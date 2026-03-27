/**
 * pipeline.js — 구성 가능한 Pipeline 추상화 (AgentScope 패턴).
 *
 * 고정된 13단계 메시지 파이프라인을 대체하는 동적 파이프라인 시스템.
 * 다양한 파이프라인 유형을 지원:
 * - Sequential: 순차 실행, 이전 결과를 다음 스텝으로
 * - Fanout: 병렬 실행, 모든 결과 수집
 * - Conditional: 조건에 따라 다른 경로로 라우팅
 * - Iterative: 조건까지 반복 실행 (최대 반복 제한)
 * - Agent: 여러 Effy 에이전트 체인 (Code → Ops → Knowledge)
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('pipeline');

/**
 * 파이프라인 스텝 함수 타입.
 * @typedef {function(object): Promise<object>} PipelineStep
 * @description context 객체를 받아 수정된 context를 반환 (비동기)
 */

/**
 * 파이프라인 실행 결과.
 * @typedef {object} PipelineResult
 * @property {boolean} success - 파이프라인 성공 여부
 * @property {object} context - 최종 context 상태
 * @property {array} history - 실행된 스텝 이력
 * @property {string} error - 에러 메시지 (실패 시)
 * @property {number} executionTime - 전체 실행 시간 (ms)
 */

/**
 * 기본 파이프라인 추상 클래스.
 * 모든 파이프라인 타입의 기반.
 */
class BasePipeline {
  constructor(name = 'anonymous') {
    this.name = name;
    this.description = '';
    this.timeout = 30000; // 기본 타임아웃 (ms)
  }

  /**
   * 파이프라인 실행.
   * @param {object} context - 초기 context 객체
   * @returns {Promise<PipelineResult>}
   */
  async execute(context = {}) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * 타임아웃 래퍼.
   * @param {Promise} promise
   * @param {number} timeoutMs
   * @returns {Promise}
   */
  _withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Pipeline '${this.name}' timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }
}

/**
 * SequentialPipeline — 순차 실행.
 * 각 스텝이 이전 스텝의 결과를 받아 처리.
 */
class SequentialPipeline extends BasePipeline {
  constructor(name = 'sequential') {
    super(name);
    this.steps = [];
  }

  /**
   * 스텝 추가.
   * @param {PipelineStep} step
   * @returns {this}
   */
  addStep(step) {
    if (typeof step !== 'function') {
      throw new Error('Step must be a function: async (context) => context');
    }
    this.steps.push(step);
    return this;
  }

  /**
   * 파이프라인 실행.
   * @param {object} context
   * @returns {Promise<PipelineResult>}
   */
  async execute(context = {}) {
    const startTime = Date.now();
    const history = [];
    let currentContext = { ...context };

    try {
      for (let i = 0; i < this.steps.length; i++) {
        const step = this.steps[i];
        const stepName = step.name || `step-${i}`;

        try {
          log.debug(`[${this.name}] 실행 중: ${stepName}`);
          currentContext = await this._withTimeout(
            step(currentContext),
            this.timeout
          );
          history.push({ name: stepName, status: 'success' });
        } catch (stepErr) {
          history.push({ name: stepName, status: 'error', error: stepErr.message });
          throw new Error(`Sequential step '${stepName}' failed: ${stepErr.message}`);
        }
      }

      log.debug(`[${this.name}] 완료`);
      return {
        success: true,
        context: currentContext,
        history,
        executionTime: Date.now() - startTime,
      };
    } catch (err) {
      log.error(`[${this.name}] 실패`, { error: err.message });
      return {
        success: false,
        context: currentContext,
        history,
        error: err.message,
        executionTime: Date.now() - startTime,
      };
    }
  }
}

/**
 * FanoutPipeline — 병렬 실행.
 * 모든 스텝을 동시에 실행하고 결과를 수집.
 */
class FanoutPipeline extends BasePipeline {
  constructor(name = 'fanout') {
    super(name);
    this.steps = [];
  }

  /**
   * 스텝 추가.
   * @param {PipelineStep} step
   * @returns {this}
   */
  addStep(step) {
    if (typeof step !== 'function') {
      throw new Error('Step must be a function: async (context) => context');
    }
    this.steps.push(step);
    return this;
  }

  /**
   * 파이프라인 실행 (병렬).
   * @param {object} context
   * @returns {Promise<PipelineResult>}
   */
  async execute(context = {}) {
    const startTime = Date.now();
    const history = [];
    const results = {};

    try {
      const promises = this.steps.map(async (step, idx) => {
        const stepName = step.name || `step-${idx}`;
        try {
          log.debug(`[${this.name}] 병렬 실행: ${stepName}`);
          const result = await this._withTimeout(step({ ...context }), this.timeout);
          history.push({ name: stepName, status: 'success' });
          results[stepName] = result;
          return result;
        } catch (stepErr) {
          history.push({ name: stepName, status: 'error', error: stepErr.message });
          throw new Error(`Fanout step '${stepName}' failed: ${stepErr.message}`);
        }
      });

      await Promise.all(promises);

      // 병렬 결과를 context에 병합 (결과 객체는 fanout.results에 저장)
      const mergedContext = {
        ...context,
        fanout: { results },
      };

      log.debug(`[${this.name}] 완료`);
      return {
        success: true,
        context: mergedContext,
        history,
        executionTime: Date.now() - startTime,
      };
    } catch (err) {
      log.error(`[${this.name}] 실패`, { error: err.message });
      return {
        success: false,
        context: { ...context, fanout: { results } },
        history,
        error: err.message,
        executionTime: Date.now() - startTime,
      };
    }
  }
}

/**
 * ConditionalPipeline — 조건부 라우팅.
 * 조건 함수 결과에 따라 다른 파이프라인으로 분기.
 */
class ConditionalPipeline extends BasePipeline {
  constructor(name = 'conditional') {
    super(name);
    this.condition = null;
    this.trueBranch = null;
    this.falseBranch = null;
  }

  /**
   * 조건 함수 설정.
   * @param {function(object): boolean} conditionFn
   * @returns {this}
   */
  setCondition(conditionFn) {
    if (typeof conditionFn !== 'function') {
      throw new Error('Condition must be a function: (context) => boolean');
    }
    this.condition = conditionFn;
    return this;
  }

  /**
   * True 분기 설정.
   * @param {BasePipeline|PipelineStep} branch
   * @returns {this}
   */
  whenTrue(branch) {
    this.trueBranch = branch;
    return this;
  }

  /**
   * False 분기 설정.
   * @param {BasePipeline|PipelineStep} branch
   * @returns {this}
   */
  whenFalse(branch) {
    this.falseBranch = branch;
    return this;
  }

  /**
   * 파이프라인 실행 (조건부 라우팅).
   * @param {object} context
   * @returns {Promise<PipelineResult>}
   */
  async execute(context = {}) {
    const startTime = Date.now();
    const history = [];

    try {
      if (!this.condition) {
        throw new Error('Condition not set');
      }

      log.debug(`[${this.name}] 조건 평가 중`);
      const conditionResult = this.condition(context);
      history.push({ name: 'condition', status: 'success', result: conditionResult });

      const branch = conditionResult ? this.trueBranch : this.falseBranch;
      if (!branch) {
        throw new Error(`No branch defined for condition result: ${conditionResult}`);
      }

      const branchName = conditionResult ? 'whenTrue' : 'whenFalse';
      log.debug(`[${this.name}] 분기 실행: ${branchName}`);

      let result;
      if (branch instanceof BasePipeline) {
        result = await this._withTimeout(branch.execute(context), this.timeout);
      } else if (typeof branch === 'function') {
        result = await this._withTimeout(branch(context), this.timeout);
        // 함수 결과를 PipelineResult로 정규화
        result = {
          success: true,
          context: result,
          history: [{ name: branchName, status: 'success' }],
          executionTime: Date.now() - startTime,
        };
      } else {
        throw new Error('Branch must be a pipeline or function');
      }

      history.push(...(result.history || []));

      log.debug(`[${this.name}] 완료`);
      return {
        success: result.success,
        context: result.context,
        history,
        executionTime: Date.now() - startTime,
        error: result.error,
      };
    } catch (err) {
      log.error(`[${this.name}] 실패`, { error: err.message });
      return {
        success: false,
        context,
        history,
        error: err.message,
        executionTime: Date.now() - startTime,
      };
    }
  }
}

/**
 * IterativePipeline — 반복 실행.
 * 조건을 만족할 때까지 스텝을 반복 (최대 반복 제한).
 */
class IterativePipeline extends BasePipeline {
  constructor(name = 'iterative') {
    super(name);
    this.step = null;
    this.condition = null;
    this.maxIterations = 10; // 무한 루프 방지
  }

  /**
   * 반복할 스텝 설정.
   * @param {PipelineStep} step
   * @returns {this}
   */
  setStep(step) {
    if (typeof step !== 'function') {
      throw new Error('Step must be a function: async (context) => context');
    }
    this.step = step;
    return this;
  }

  /**
   * 반복 종료 조건 설정.
   * @param {function(object): boolean} conditionFn - true면 반복 종료
   * @returns {this}
   */
  setCondition(conditionFn) {
    if (typeof conditionFn !== 'function') {
      throw new Error('Condition must be a function: (context) => boolean');
    }
    this.condition = conditionFn;
    return this;
  }

  /**
   * 최대 반복 횟수 설정.
   * @param {number} max
   * @returns {this}
   */
  setMaxIterations(max) {
    this.maxIterations = max;
    return this;
  }

  /**
   * 파이프라인 실행 (반복).
   * @param {object} context
   * @returns {Promise<PipelineResult>}
   */
  async execute(context = {}) {
    const startTime = Date.now();
    const history = [];
    let currentContext = { ...context };
    let iteration = 0;

    try {
      if (!this.step) {
        throw new Error('Step not set');
      }
      if (!this.condition) {
        throw new Error('Condition not set');
      }

      while (iteration < this.maxIterations) {
        const stepName = `${this.step.name || 'step'}-iter${iteration}`;

        // 반복 종료 조건 확인
        if (this.condition(currentContext)) {
          log.debug(`[${this.name}] 반복 종료 조건 충족 (${iteration}회 반복)`);
          break;
        }

        try {
          log.debug(`[${this.name}] 반복 실행: ${stepName}`);
          currentContext = await this._withTimeout(
            this.step(currentContext),
            this.timeout
          );
          history.push({ name: stepName, status: 'success' });
          iteration++;
        } catch (stepErr) {
          history.push({ name: stepName, status: 'error', error: stepErr.message });
          throw new Error(`Iterative step failed at iteration ${iteration}: ${stepErr.message}`);
        }
      }

      if (iteration >= this.maxIterations) {
        log.warn(`[${this.name}] 최대 반복 횟수 도달`, { maxIterations: this.maxIterations });
      }

      log.debug(`[${this.name}] 완료 (총 ${iteration}회 반복)`);
      return {
        success: true,
        context: currentContext,
        history,
        iterations: iteration,
        executionTime: Date.now() - startTime,
      };
    } catch (err) {
      log.error(`[${this.name}] 실패`, { error: err.message, iteration });
      return {
        success: false,
        context: currentContext,
        history,
        iterations: iteration,
        error: err.message,
        executionTime: Date.now() - startTime,
      };
    }
  }
}

/**
 * AgentPipeline — 에이전트 체인.
 * 여러 Effy 에이전트를 순차적으로 실행:
 * Code Agent (작성) → Ops Agent (리뷰) → Knowledge Agent (문서화)
 */
class AgentPipeline extends BasePipeline {
  constructor(name = 'agent-chain') {
    super(name);
    this.agents = []; // { name, handler: async (context) => result }
  }

  /**
   * 에이전트 추가.
   * @param {string} agentName
   * @param {function(object): Promise<object>} handler
   * @returns {this}
   */
  addAgent(agentName, handler) {
    if (typeof handler !== 'function') {
      throw new Error(`Agent handler for '${agentName}' must be a function`);
    }
    this.agents.push({ name: agentName, handler });
    return this;
  }

  /**
   * 파이프라인 실행 (에이전트 체인).
   * @param {object} context
   * @returns {Promise<PipelineResult>}
   */
  async execute(context = {}) {
    const startTime = Date.now();
    const history = [];
    let currentContext = { ...context };
    const results = {};

    try {
      for (const agent of this.agents) {
        try {
          log.debug(`[${this.name}] 에이전트 실행: ${agent.name}`);
          const agentResult = await this._withTimeout(
            agent.handler(currentContext),
            this.timeout
          );
          currentContext = { ...currentContext, [agent.name]: agentResult };
          results[agent.name] = agentResult;
          history.push({ name: agent.name, status: 'success' });
        } catch (agentErr) {
          history.push({ name: agent.name, status: 'error', error: agentErr.message });
          throw new Error(`Agent '${agent.name}' failed: ${agentErr.message}`);
        }
      }

      log.debug(`[${this.name}] 완료`);
      return {
        success: true,
        context: currentContext,
        agentResults: results,
        history,
        executionTime: Date.now() - startTime,
      };
    } catch (err) {
      log.error(`[${this.name}] 실패`, { error: err.message });
      return {
        success: false,
        context: currentContext,
        agentResults: results,
        history,
        error: err.message,
        executionTime: Date.now() - startTime,
      };
    }
  }
}

/**
 * 파이프라인 팩토리 및 래퍼.
 * 모든 파이프라인 타입에 대한 정적 인터페이스 제공.
 */
class Pipeline {
  /**
   * SequentialPipeline 생성.
   * @param {string} name
   * @returns {SequentialPipeline}
   */
  static sequential(name = 'sequential') {
    return new SequentialPipeline(name);
  }

  /**
   * FanoutPipeline 생성.
   * @param {string} name
   * @returns {FanoutPipeline}
   */
  static fanout(name = 'fanout') {
    return new FanoutPipeline(name);
  }

  /**
   * ConditionalPipeline 생성.
   * @param {string} name
   * @returns {ConditionalPipeline}
   */
  static conditional(name = 'conditional') {
    return new ConditionalPipeline(name);
  }

  /**
   * IterativePipeline 생성.
   * @param {string} name
   * @returns {IterativePipeline}
   */
  static iterative(name = 'iterative') {
    return new IterativePipeline(name);
  }

  /**
   * AgentPipeline 생성.
   * @param {string} name
   * @returns {AgentPipeline}
   */
  static agent(name = 'agent-chain') {
    return new AgentPipeline(name);
  }
}

module.exports = {
  // 추상 클래스
  BasePipeline,

  // 구체적 구현
  SequentialPipeline,
  FanoutPipeline,
  ConditionalPipeline,
  IterativePipeline,
  AgentPipeline,

  // 팩토리
  Pipeline,
};
