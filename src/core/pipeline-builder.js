/**
 * pipeline-builder.js — 유창한 파이프라인 빌더 API.
 *
 * 우아한 설정을 통해 복잡한 파이프라인을 구성:
 *
 * ```javascript
 * const pipeline = PipelineBuilder.create('incident-response')
 *   .sequential()
 *     .step(authStep)
 *     .step(rateLimitStep)
 *   .end()
 *   .conditional(ctx => ctx.severity === 'critical')
 *     .whenTrue(
 *       PipelineBuilder.create('critical-path')
 *         .fanout()
 *           .step(notifyOpsAgent)
 *           .step(notifySlackChannel)
 *         .end()
 *     )
 *     .whenFalse(standardResponseStep)
 *   .end()
 *   .build();
 * ```
 */

const { createLogger } = require('../shared/logger');
const {
  Pipeline,
  SequentialPipeline,
  FanoutPipeline,
  ConditionalPipeline,
  IterativePipeline,
  AgentPipeline,
} = require('./pipeline');

const log = createLogger('pipeline-builder');

/**
 * 파이프라인 빌더.
 * 유창한 인터페이스로 파이프라인 구성.
 */
class PipelineBuilder {
  constructor(name = 'unnamed') {
    this.name = name;
    this.root = null;
    this.current = null; // 현재 컨텍스트 (builder 체이닝용)
    this.stack = []; // 중첩 파이프라인을 위한 스택
  }

  /**
   * 새로운 빌더 인스턴스 생성.
   * @param {string} name - 파이프라인 이름
   * @returns {PipelineBuilder}
   */
  static create(name = 'unnamed') {
    return new PipelineBuilder(name);
  }

  /**
   * SequentialPipeline 시작.
   * @param {string} name - 선택사항, override 이름
   * @returns {SequentialBuilder}
   */
  sequential(name) {
    const pipeline = new SequentialPipeline(name || `${this.name}:sequential`);
    if (!this.root) {
      this.root = pipeline;
    }
    this.stack.push(this.current);
    this.current = new SequentialBuilder(pipeline, this);
    return this.current;
  }

  /**
   * FanoutPipeline 시작.
   * @param {string} name - 선택사항
   * @returns {FanoutBuilder}
   */
  fanout(name) {
    const pipeline = new FanoutPipeline(name || `${this.name}:fanout`);
    if (!this.root) {
      this.root = pipeline;
    }
    this.stack.push(this.current);
    this.current = new FanoutBuilder(pipeline, this);
    return this.current;
  }

  /**
   * ConditionalPipeline 시작.
   * @param {function(object): boolean} condition
   * @param {string} name - 선택사항
   * @returns {ConditionalBuilder}
   */
  conditional(condition, name) {
    if (typeof condition !== 'function') {
      throw new Error('Condition must be a function: (context) => boolean');
    }
    const pipeline = new ConditionalPipeline(name || `${this.name}:conditional`);
    pipeline.setCondition(condition);
    if (!this.root) {
      this.root = pipeline;
    }
    this.stack.push(this.current);
    this.current = new ConditionalBuilder(pipeline, this);
    return this.current;
  }

  /**
   * IterativePipeline 시작.
   * @param {PipelineStep} step
   * @param {function(object): boolean} condition
   * @param {string} name - 선택사항
   * @returns {IterativeBuilder}
   */
  iterative(step, condition, name) {
    if (typeof step !== 'function' || typeof condition !== 'function') {
      throw new Error('Both step and condition must be functions');
    }
    const pipeline = new IterativePipeline(name || `${this.name}:iterative`);
    pipeline.setStep(step);
    pipeline.setCondition(condition);
    if (!this.root) {
      this.root = pipeline;
    }
    this.stack.push(this.current);
    this.current = new IterativeBuilder(pipeline, this);
    return this.current;
  }

  /**
   * AgentPipeline 시작.
   * @param {string} name - 선택사항
   * @returns {AgentBuilder}
   */
  agent(name) {
    const pipeline = new AgentPipeline(name || `${this.name}:agent`);
    if (!this.root) {
      this.root = pipeline;
    }
    this.stack.push(this.current);
    this.current = new AgentBuilder(pipeline, this);
    return this.current;
  }

  /**
   * 파이프라인 빌드 (최종 인스턴스 반환).
   * @returns {BasePipeline}
   */
  build() {
    if (!this.root) {
      throw new Error('No pipeline configured');
    }
    return this.root;
  }
}

/**
 * SequentialPipeline 빌더.
 */
class SequentialBuilder {
  constructor(pipeline, parentBuilder) {
    this.pipeline = pipeline;
    this.parentBuilder = parentBuilder;
  }

  /**
   * 스텝 추가.
   * @param {PipelineStep} step
   * @returns {this}
   */
  step(step) {
    this.pipeline.addStep(step);
    return this;
  }

  /**
   * 여러 스텝 추가.
   * @param {PipelineStep[]} steps
   * @returns {this}
   */
  steps(steps) {
    for (const step of steps) {
      this.pipeline.addStep(step);
    }
    return this;
  }

  /**
   * 파이프라인 종료 및 상위 빌더로 반환.
   * @returns {PipelineBuilder}
   */
  end() {
    const parent = this.parentBuilder.stack.pop();
    this.parentBuilder.current = parent;
    return this.parentBuilder;
  }
}

/**
 * FanoutPipeline 빌더.
 */
class FanoutBuilder {
  constructor(pipeline, parentBuilder) {
    this.pipeline = pipeline;
    this.parentBuilder = parentBuilder;
  }

  /**
   * 병렬 스텝 추가.
   * @param {PipelineStep} step
   * @returns {this}
   */
  step(step) {
    this.pipeline.addStep(step);
    return this;
  }

  /**
   * 여러 병렬 스텝 추가.
   * @param {PipelineStep[]} steps
   * @returns {this}
   */
  steps(steps) {
    for (const step of steps) {
      this.pipeline.addStep(step);
    }
    return this;
  }

  /**
   * 파이프라인 종료 및 상위 빌더로 반환.
   * @returns {PipelineBuilder}
   */
  end() {
    const parent = this.parentBuilder.stack.pop();
    this.parentBuilder.current = parent;
    return this.parentBuilder;
  }
}

/**
 * ConditionalPipeline 빌더.
 */
class ConditionalBuilder {
  constructor(pipeline, parentBuilder) {
    this.pipeline = pipeline;
    this.parentBuilder = parentBuilder;
  }

  /**
   * True 분기 설정.
   * @param {BasePipeline|PipelineStep} branch
   * @returns {this}
   */
  whenTrue(branch) {
    this.pipeline.whenTrue(branch);
    return this;
  }

  /**
   * False 분기 설정.
   * @param {BasePipeline|PipelineStep} branch
   * @returns {this}
   */
  whenFalse(branch) {
    this.pipeline.whenFalse(branch);
    return this;
  }

  /**
   * 파이프라인 종료 및 상위 빌더로 반환.
   * @returns {PipelineBuilder}
   */
  end() {
    const parent = this.parentBuilder.stack.pop();
    this.parentBuilder.current = parent;
    return this.parentBuilder;
  }
}

/**
 * IterativePipeline 빌더.
 */
class IterativeBuilder {
  constructor(pipeline, parentBuilder) {
    this.pipeline = pipeline;
    this.parentBuilder = parentBuilder;
  }

  /**
   * 최대 반복 횟수 설정.
   * @param {number} max
   * @returns {this}
   */
  maxIterations(max) {
    this.pipeline.setMaxIterations(max);
    return this;
  }

  /**
   * 파이프라인 종료 및 상위 빌더로 반환.
   * @returns {PipelineBuilder}
   */
  end() {
    const parent = this.parentBuilder.stack.pop();
    this.parentBuilder.current = parent;
    return this.parentBuilder;
  }
}

/**
 * AgentPipeline 빌더.
 */
class AgentBuilder {
  constructor(pipeline, parentBuilder) {
    this.pipeline = pipeline;
    this.parentBuilder = parentBuilder;
  }

  /**
   * 에이전트 추가.
   * @param {string} agentName
   * @param {function(object): Promise<object>} handler
   * @returns {this}
   */
  agent(agentName, handler) {
    this.pipeline.addAgent(agentName, handler);
    return this;
  }

  /**
   * 여러 에이전트 추가.
   * @param {Array<{name: string, handler: function}>} agents
   * @returns {this}
   */
  agents(agents) {
    for (const agent of agents) {
      this.pipeline.addAgent(agent.name, agent.handler);
    }
    return this;
  }

  /**
   * 파이프라인 종료 및 상위 빌더로 반환.
   * @returns {PipelineBuilder}
   */
  end() {
    const parent = this.parentBuilder.stack.pop();
    this.parentBuilder.current = parent;
    return this.parentBuilder;
  }
}

/**
 * 설정 기반 파이프라인 로더.
 *
 * effy.config.yaml에서 파이프라인 정의를 로드하여 구성.
 * 예:
 *
 * ```yaml
 * pipelines:
 *   default:
 *     steps: [auth, rateLimit, coalesce, route, contextBuild, runtime, memoryPersist, log]
 *   incident:
 *     steps: [auth, route]
 *     then:
 *       conditional:
 *         field: severity
 *         critical: [notifyOps, notifySlack, escalate]
 *         default: [standardResponse]
 * ```
 */
class ConfigBasedPipelineLoader {
  constructor(stepRegistry = {}) {
    this.stepRegistry = stepRegistry;
    this.pipelines = new Map();
  }

  /**
   * 스텝 등록.
   * @param {string} stepName
   * @param {PipelineStep} step
   */
  registerStep(stepName, step) {
    this.stepRegistry[stepName] = step;
    log.debug(`Step registered: ${stepName}`);
  }

  /**
   * 다수의 스텝 등록.
   * @param {object} steps - { stepName: step, ... }
   */
  registerSteps(steps) {
    Object.assign(this.stepRegistry, steps);
    log.debug(`Registered ${Object.keys(steps).length} steps`);
  }

  /**
   * 설정에서 파이프라인 로드 및 구성.
   * @param {object} pipelineConfig - effy.config.yaml의 pipelines 섹션
   */
  loadFromConfig(pipelineConfig) {
    if (!pipelineConfig || typeof pipelineConfig !== 'object') {
      log.warn('No pipeline configuration provided');
      return;
    }

    for (const [pipelineName, config] of Object.entries(pipelineConfig)) {
      try {
        const pipeline = this._buildPipelineFromConfig(pipelineName, config);
        this.pipelines.set(pipelineName, pipeline);
        log.info(`Pipeline loaded: ${pipelineName}`);
      } catch (err) {
        log.error(`Failed to load pipeline '${pipelineName}'`, { error: err.message });
      }
    }
  }

  /**
   * 설정 객체에서 파이프라인 빌드.
   * @private
   * @param {string} pipelineName
   * @param {object} config
   * @returns {BasePipeline}
   */
  _buildPipelineFromConfig(pipelineName, config) {
    const builder = PipelineBuilder.create(pipelineName);

    // 순차 스텝 목록 처리
    if (config.steps && Array.isArray(config.steps)) {
      const seqBuilder = builder.sequential();
      for (const stepName of config.steps) {
        const step = this.stepRegistry[stepName];
        if (!step) {
          throw new Error(`Unknown step: ${stepName}`);
        }
        seqBuilder.step(step);
      }
      seqBuilder.end();
    }

    // 조건부 라우팅 처리 (then 섹션)
    if (config.then && config.then.conditional) {
      const condConfig = config.then.conditional;
      const conditionField = condConfig.field;
      const conditionValue = condConfig.value;

      const condBuilder = builder.conditional(
        (ctx) => ctx[conditionField] === conditionValue,
        `${pipelineName}:conditional`
      );

      // true 분기
      if (condConfig.critical || condConfig.whenTrue) {
        const trueBranch = this._buildSimpleSequentialPipeline(
          condConfig.critical || condConfig.whenTrue
        );
        condBuilder.whenTrue(trueBranch);
      }

      // false 분기
      if (condConfig.default || condConfig.whenFalse) {
        const falseBranch = this._buildSimpleSequentialPipeline(
          condConfig.default || condConfig.whenFalse
        );
        condBuilder.whenFalse(falseBranch);
      }

      condBuilder.end();
    }

    return builder.build();
  }

  /**
   * 스텝 이름 배열에서 순차 파이프라인 빌드.
   * @private
   * @param {string[]} stepNames
   * @returns {SequentialPipeline}
   */
  _buildSimpleSequentialPipeline(stepNames) {
    const pipeline = new SequentialPipeline('anonymous');
    if (Array.isArray(stepNames)) {
      for (const stepName of stepNames) {
        const step = this.stepRegistry[stepName];
        if (!step) {
          throw new Error(`Unknown step: ${stepName}`);
        }
        pipeline.addStep(step);
      }
    }
    return pipeline;
  }

  /**
   * 이름으로 파이프라인 조회.
   * @param {string} name
   * @returns {BasePipeline}
   */
  getPipeline(name) {
    const pipeline = this.pipelines.get(name);
    if (!pipeline) {
      throw new Error(`Pipeline not found: ${name}`);
    }
    return pipeline;
  }

  /**
   * 등록된 모든 파이프라인 조회.
   * @returns {Map<string, BasePipeline>}
   */
  getAllPipelines() {
    return new Map(this.pipelines);
  }
}

module.exports = {
  PipelineBuilder,
  SequentialBuilder,
  FanoutBuilder,
  ConditionalBuilder,
  IterativeBuilder,
  AgentBuilder,
  ConfigBasedPipelineLoader,
};
