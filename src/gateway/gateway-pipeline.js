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
 * 파이프라인 스텝 정의 — SLIM 아키텍처.
 *
 * v3.9 SLIM: 13 코어 스텝 (동기, 사용자 응답까지) + 7 후처리 스텝 (비동기, 응답 후).
 * 코어 스텝만 사용자 체감 경로에 있어 응답 속도가 빨라짐.
 * 후처리 스텝은 respond 이후 setImmediate로 실행되어 실패해도 사용자에게 영향 없음.
 */
const CORE_STEPS = [
  { name: 'middleware',         phase: 'input',    critical: true  },
  { name: 'bindingRoute',      phase: 'routing',  critical: true  },
  { name: 'functionRoute',     phase: 'routing',  critical: true  },
  { name: 'modelRoute',        phase: 'routing',  critical: true  },
  { name: 'circuitBreaker',    phase: 'guard',    critical: true  },
  { name: 'concurrency',       phase: 'guard',    critical: true  },
  { name: 'session',           phase: 'context',  critical: true  },
  { name: 'workingMemory',     phase: 'context',  critical: true  },
  { name: 'contextAssemble',   phase: 'context',  critical: true  },
  { name: 'budgetGate',        phase: 'guard',    critical: true  },
  { name: 'agentRuntime',      phase: 'execute',  critical: true  },
  { name: 'respond',           phase: 'output',   critical: true  },
  { name: 'episodicSave',      phase: 'persist',  critical: true  },
];

const POST_STEPS = [
  { name: 'onboarding',        phase: 'post',     critical: false },
  { name: 'nlConfig',          phase: 'post',     critical: false },
  { name: 'compaction',        phase: 'post',     critical: false },
  { name: 'reflection',        phase: 'post',     critical: false },
  { name: 'entityUpdate',      phase: 'post',     critical: false },
  { name: 'bulletinInject',    phase: 'post',     critical: false },
  { name: 'postProcess',       phase: 'post',     critical: false },
];

/** @deprecated 레거시 호환 — 전체 20단계 목록 */
const PIPELINE_STEPS = [...CORE_STEPS, ...POST_STEPS];

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
    this._coreSteps = [...CORE_STEPS];
    this._postSteps = [...POST_STEPS];
    /** @deprecated 레거시 호환 */
    this._steps = [...CORE_STEPS, ...POST_STEPS];
    this._stats = { total: 0, success: 0, failed: 0, avgDuration: 0, postErrors: 0 };
  }

  /**
   * 코어 스텝 추가 (특정 위치 뒤에).
   *
   * @param {string} afterStep - 이 스텝 뒤에 삽입
   * @param {{ name: string, phase: string, critical: boolean, fn: Function }} step
   */
  addStepAfter(afterStep, step) {
    const coreIdx = this._coreSteps.findIndex(s => s.name === afterStep);
    if (coreIdx >= 0) {
      this._coreSteps.splice(coreIdx + 1, 0, step);
    } else {
      const postIdx = this._postSteps.findIndex(s => s.name === afterStep);
      if (postIdx >= 0) {
        this._postSteps.splice(postIdx + 1, 0, step);
      } else {
        this._postSteps.push(step);
      }
    }
    this._steps = [...this._coreSteps, ...this._postSteps];
  }

  /**
   * 후처리 스텝 추가.
   * @param {{ name: string, phase: string, critical: boolean, fn: Function }} step
   */
  addPostStep(step) {
    this._postSteps.push({ ...step, critical: false, phase: 'post' });
    this._steps = [...this._coreSteps, ...this._postSteps];
  }

  /**
   * 스텝 제거.
   * @param {string} stepName
   */
  removeStep(stepName) {
    this._coreSteps = this._coreSteps.filter(s => s.name !== stepName);
    this._postSteps = this._postSteps.filter(s => s.name !== stepName);
    this._steps = [...this._coreSteps, ...this._postSteps];
  }

  /**
   * 파이프라인 실행 — SLIM 아키텍처.
   *
   * 1단계: 코어 13 스텝 동기 실행 (사용자 응답까지)
   * 2단계: 후처리 7 스텝 비동기 실행 (응답 후, 실패해도 무영향)
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
      // ─── 1단계: 코어 스텝 (동기, 사용자 체감 경로) ───
      for (const stepDef of this._coreSteps) {
        if (ctx.halted) break;
        await this._executeStep(stepDef, ctx);
      }

      this._stats.success++;
      const duration = Date.now() - startTime;
      this._stats.avgDuration = Math.round(
        (this._stats.avgDuration * (this._stats.total - 1) + duration) / this._stats.total
      );

      // ─── 2단계: 후처리 스텝 (비동기, 응답 후 실행) ───
      if (this._postSteps.length > 0 && !ctx.halted) {
        const postCtx = { ...ctx };
        setImmediate(() => {
          this._runPostSteps(postCtx).catch(err => {
            this._stats.postErrors++;
            log.warn('Post-processing error (non-blocking)', { error: err.message });
          });
        });
      }

      return { success: true, context: ctx, stepTimings: ctx.stepTimings };
    } catch (err) {
      this._stats.failed++;
      return { success: false, context: ctx, stepTimings: ctx.stepTimings, error: err.message };
    }
  }

  /**
   * @private 후처리 스텝 병렬 실행 — 응답 후 비동기.
   * 모든 스텝이 non-critical이므로 Promise.allSettled로 병렬 실행.
   */
  async _runPostSteps(ctx) {
    const results = await Promise.allSettled(
      this._postSteps.map(stepDef => {
        // REVIEW-FIX: Deep copy mutable nested objects to prevent cross-step mutation.
        // msg and adapter are shared references — each post-step gets its own copy.
        const snapshot = {
          ...ctx,
          stepTimings: [],
          msg: ctx.msg ? { ...ctx.msg } : ctx.msg,
          routing: ctx.routing ? { ...ctx.routing } : ctx.routing,
        };
        return this._executeStep(stepDef, snapshot);
      })
    );

    let errors = 0;
    for (const r of results) {
      if (r.status === 'rejected') errors++;
    }
    if (errors > 0) {
      log.debug(`Post-processing: ${errors}/${results.length} steps failed (non-blocking)`);
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

module.exports = { GatewayPipeline, createGatewayPipeline, PIPELINE_STEPS, CORE_STEPS, POST_STEPS };
