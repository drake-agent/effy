/**
 * gateway-pipeline.js — Gateway 메시지 파이프라인의 SequentialPipeline 래핑.
 *
 * v3.9: Problem 2 — 13단계 하드코딩을 Pipeline 추상화로 래핑.
 *
 * 기존 gateway.onMessage()의 13단계를 개별 스텝 함수로 분리하고
 * SequentialPipeline에 등록하여 실행한다.
 *
 * 이점:
 * - 단계별 독립 테스트 가능
 * - 단계 추가/제거가 선언적
 * - 미들웨어 패턴으로 횡단 관심사(로깅, 에러 처리, 타이밍) 분리
 * - 단계별 실행 시간 추적 (자동)
 *
 * 사용:
 *   const pipeline = createGatewayPipeline(gateway);
 *   const result = await pipeline.execute({ msg, adapter });
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('gateway:pipeline');

/**
 * 파이프라인 스텝 정의.
 * 각 스텝은 (ctx) => ctx | null 함수.
 * null 반환 시 파이프라인 조기 종료 (reply 이미 전송됨).
 */
const PIPELINE_STEPS = [
  { name: 'middleware',         phase: 'input',    critical: true  },
  { name: 'onboarding',        phase: 'input',    critical: false },
  { name: 'nlConfig',          phase: 'input',    critical: false },
  { name: 'bindingRoute',      phase: 'routing',  critical: true  },
  { name: 'functionRoute',     phase: 'routing',  critical: true  },
  { name: 'modelRoute',        phase: 'routing',  critical: true  },
  { name: 'circuitBreaker',    phase: 'guard',    critical: true  },
  { name: 'concurrency',       phase: 'guard',    critical: true  },
  { name: 'session',           phase: 'context',  critical: true  },
  { name: 'workingMemory',     phase: 'context',  critical: true  },
  { name: 'compaction',        phase: 'context',  critical: false },
  { name: 'reflection',        phase: 'context',  critical: false },
  { name: 'episodicSave',      phase: 'persist',  critical: true  },
  { name: 'entityUpdate',      phase: 'persist',  critical: false },
  { name: 'contextAssemble',   phase: 'context',  critical: true  },
  { name: 'bulletinInject',    phase: 'context',  critical: false },
  { name: 'budgetGate',        phase: 'guard',    critical: true  },
  { name: 'agentRuntime',      phase: 'execute',  critical: true  },
  { name: 'respond',           phase: 'output',   critical: true  },
  { name: 'postProcess',       phase: 'output',   critical: false },
];

/**
 * 파이프라인 컨텍스트 — 모든 스텝 간 공유 상태.
 *
 * @typedef {Object} PipelineContext
 * @property {Object} msg - 원본 메시지
 * @property {Object} adapter - 채널 어댑터
 * @property {Object} gateway - Gateway 인스턴스 참조
 * @property {string} userId
 * @property {string} channelId
 * @property {string} agentId
 * @property {string} effectiveText
 * @property {Object} routing
 * @property {Object} modelRouting
 * @property {string} systemPrompt
 * @property {boolean} halted - 파이프라인 조기 종료
 * @property {Array} stepTimings - 각 스텝 실행 시간
 */

class GatewayPipeline {
  constructor(gateway) {
    this.gateway = gateway;
    this._steps = [...PIPELINE_STEPS];
    this._stats = { total: 0, success: 0, failed: 0, avgDuration: 0 };
  }

  /**
   * 스텝 추가 (특정 위치 뒤에).
   *
   * @param {string} afterStep - 이 스텝 뒤에 삽입
   * @param {{ name: string, phase: string, critical: boolean, fn: Function }} step
   */
  addStepAfter(afterStep, step) {
    const idx = this._steps.findIndex(s => s.name === afterStep);
    if (idx >= 0) {
      this._steps.splice(idx + 1, 0, step);
    } else {
      this._steps.push(step);
    }
  }

  /**
   * 스텝 제거.
   * @param {string} stepName
   */
  removeStep(stepName) {
    this._steps = this._steps.filter(s => s.name !== stepName);
  }

  /**
   * 파이프라인 실행.
   *
   * @param {Object} initialCtx - { msg, adapter }
   * @returns {Promise<{ success: boolean, context: Object, stepTimings: Array, error?: string }>}
   */
  async execute(initialCtx) {
    this._stats.total++;
    const startTime = Date.now();

    const ctx = {
      ...initialCtx,
      gateway: this.gateway,
      halted: false,
      stepTimings: [],
      acquired: false,
    };

    try {
      // 같은 phase의 non-critical 스텝들은 병렬 실행 가능
      const phases = this._groupByPhase(this._steps);

      for (const phaseGroup of phases) {
        if (ctx.halted) break;

        // 단일 스텝이거나 critical 스텝 포함 → 순차 실행
        if (phaseGroup.length === 1 || phaseGroup.some(s => s.critical)) {
          for (const stepDef of phaseGroup) {
            if (ctx.halted) break;
            await this._executeStep(stepDef, ctx);
          }
        } else {
          // HIGH-R4-9: Pass shallow copy of ctx to each parallel step to prevent mutations
          // Each step gets independent snapshot, results are merged after all settle
          const parallelResults = await Promise.allSettled(
            phaseGroup.map(stepDef => {
              const ctxSnapshot = { ...ctx };
              return this._executeStep(stepDef, ctxSnapshot).then(() => ctxSnapshot);
            })
          );

          // Merge non-critical step results back (only keep shared fields like stepTimings)
          for (const result of parallelResults) {
            if (result.status === 'fulfilled' && result.value) {
              // Merge only stepTimings (other mutations are discarded)
              if (result.value.stepTimings && Array.isArray(result.value.stepTimings)) {
                ctx.stepTimings.push(...result.value.stepTimings);
              }
            }
          }
        }
      }

      this._stats.success++;
      const duration = Date.now() - startTime;
      this._stats.avgDuration = Math.round(
        (this._stats.avgDuration * (this._stats.total - 1) + duration) / this._stats.total
      );

      return { success: true, context: ctx, stepTimings: ctx.stepTimings };
    } catch (err) {
      this._stats.failed++;
      return { success: false, context: ctx, stepTimings: ctx.stepTimings, error: err.message };
    }
  }

  /**
   * @private 단일 스텝 실행 + 타이밍 기록.
   */
  async _executeStep(stepDef, ctx) {
    const stepStart = Date.now();
    try {
      const fn = stepDef.fn || this._builtinStep(stepDef.name);
      if (fn) {
        await fn(ctx);
      }
    } catch (err) {
      const duration = Date.now() - stepStart;
      ctx.stepTimings.push({ step: stepDef.name, duration, error: err.message });

      if (stepDef.critical) {
        log.error(`Pipeline step '${stepDef.name}' failed (critical)`, { error: err.message });
        throw err;
      } else {
        log.warn(`Pipeline step '${stepDef.name}' failed (non-critical)`, { error: err.message });
      }
      return;
    }
    ctx.stepTimings.push({ step: stepDef.name, duration: Date.now() - stepStart });
  }

  /**
   * @private 스텝을 phase 기준으로 연속 그룹화.
   * 같은 phase가 연속된 스텝들을 하나의 그룹으로 묶음.
   */
  _groupByPhase(steps) {
    const groups = [];
    let currentGroup = [];
    let currentPhase = null;

    for (const step of steps) {
      if (step.phase !== currentPhase) {
        if (currentGroup.length > 0) groups.push(currentGroup);
        currentGroup = [step];
        currentPhase = step.phase;
      } else {
        currentGroup.push(step);
      }
    }
    if (currentGroup.length > 0) groups.push(currentGroup);
    return groups;
  }

  /**
   * built-in 스텝은 gateway의 기존 로직에 위임.
   * 향후 개별 스텝 함수로 분리 가능.
   * @private
   */
  _builtinStep(name) {
    // 현재는 null 반환 — gateway.onMessage()의 기존 로직이 실행됨.
    // 점진적 마이그레이션: 각 스텝을 하나씩 이 매핑에 등록하면
    // onMessage() 코드를 줄일 수 있음.
    return null;
  }

  /**
   * 현재 등록된 스텝 목록.
   * @returns {Array<{ name: string, phase: string, critical: boolean }>}
   */
  getSteps() {
    return this._steps.map(s => ({ name: s.name, phase: s.phase, critical: s.critical }));
  }

  /** @returns {Object} 통계 */
  getStats() {
    return { ...this._stats };
  }
}

/**
 * Gateway 인스턴스에서 파이프라인 생성.
 * @param {Object} gateway
 * @returns {GatewayPipeline}
 */
function createGatewayPipeline(gateway) {
  return new GatewayPipeline(gateway);
}

module.exports = { GatewayPipeline, createGatewayPipeline, PIPELINE_STEPS };
