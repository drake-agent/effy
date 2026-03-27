/**
 * process-routing.js — 프로세스 타입별 모델 분리 배정.
 * 라우팅 패턴: Channel=Sonnet, Worker=Opus, Compactor=Haiku.
 *
 * Process-type based model routing for efficient resource allocation.
 * Supports channel, worker, branch, compactor, cortex process types.
 */
const { createLogger } = require('../shared/logger');
const { config } = require('../config');

const log = createLogger('core:process-routing');

/**
 * 기본 모델 매핑 (프로세스 타입별)
 * Default process type to model mappings
 */
const DEFAULT_PROCESS_MAPPINGS = {
  channel: 'sonnet', // 균형잡힌 응답
  worker: 'opus', // 깊은 추론
  branch: 'sonnet', // 병렬 처리
  compactor: 'haiku', // 저비용
  cortex: 'haiku', // 빠른 처리
};

/**
 * 작업 타입별 모델 오버라이드
 * Task type to model overrides
 */
const DEFAULT_TASK_OVERRIDES = {
  coding: 'opus', // 코딩은 높은 능력 필요
  chat: 'haiku', // 대화는 빠른 응답 필요
  analysis: 'sonnet', // 분석은 균형 필요
  strategy: 'opus', // 전략은 높은 능력 필요
  summarize: 'haiku', // 요약은 빠르게
  translate: 'sonnet', // 번역은 균형
  research: 'opus', // 조사는 깊은 추론
};

/**
 * Tier to fallback chain 매핑
 * Fallback chains for each tier
 */
const FALLBACK_CHAINS = {
  opus: ['sonnet', 'haiku'],
  sonnet: ['haiku'],
  haiku: [],
};

/**
 * ProcessRouter — 프로세스 타입별 모델 라우팅
 * Routes models based on process type and task type
 */
class ProcessRouter {
  constructor(opts = {}) {
    /**
     * 프로세스 타입 → 모델 ID 매핑
     * @type {Map<string, string>}
     */
    this.processMapping = new Map();

    /**
     * 작업 타입 → 모델 ID 오버라이드
     * @type {Map<string, string>}
     */
    this.taskOverrides = new Map();

    /**
     * 모델 → Fallback 체인 매핑
     * @type {Map<string, string[]>}
     */
    this.fallbackChains = new Map();

    // 기본값 로드
    this._loadDefaults();

    // 설정 파일에서 커스텀 매핑 로드
    this._loadConfigMappings();

    log.info('ProcessRouter initialized', {
      processMappings: this.processMapping.size,
      taskOverrides: this.taskOverrides.size,
    });
  }

  /**
   * 기본값 로드
   * Load default mappings
   *
   * @private
   */
  _loadDefaults() {
    // 프로세스 타입 기본값
    for (const [processType, model] of Object.entries(DEFAULT_PROCESS_MAPPINGS)) {
      this.processMapping.set(processType, model);
    }

    // 작업 타입 오버라이드
    for (const [taskType, model] of Object.entries(DEFAULT_TASK_OVERRIDES)) {
      this.taskOverrides.set(taskType, model);
    }

    // Fallback 체인
    for (const [model, chain] of Object.entries(FALLBACK_CHAINS)) {
      this.fallbackChains.set(model, chain);
    }
  }

  /**
   * 설정 파일에서 커스텀 매핑 로드
   * Load custom mappings from config
   *
   * @private
   */
  _loadConfigMappings() {
    const routingCfg = config.routing || {};

    // 프로세스 기본값
    if (routingCfg.processDefaults) {
      for (const [processType, model] of Object.entries(routingCfg.processDefaults)) {
        this.processMapping.set(processType, model);
      }
    }

    // 작업 타입 오버라이드
    if (routingCfg.taskOverrides) {
      for (const [taskType, model] of Object.entries(routingCfg.taskOverrides)) {
        this.taskOverrides.set(taskType, model);
      }
    }

    // Fallback 체인
    if (routingCfg.fallbackChains) {
      for (const [model, chain] of Object.entries(routingCfg.fallbackChains)) {
        this.fallbackChains.set(model, chain);
      }
    }
  }

  /**
   * 프로세스 타입과 작업 타입에 따라 모델 결정
   * Resolve model based on process type and task type
   *
   * @param {string} processType - 프로세스 타입 ('channel', 'worker', 'branch', 'compactor', 'cortex')
   * @param {string} [taskType=''] - 작업 타입 ('coding', 'chat', 'analysis', 'strategy' 등)
   * @returns {string} 모델 ID (e.g., 'opus', 'sonnet', 'haiku')
   */
  resolve(processType, taskType = '') {
    // 1. 작업 타입 오버라이드 확인 (최우선)
    if (taskType && this.taskOverrides.has(taskType)) {
      const model = this.taskOverrides.get(taskType);
      log.debug('Model resolved from task override', { taskType, model });
      return model;
    }

    // 2. 프로세스 타입 기본값 사용
    if (this.processMapping.has(processType)) {
      const model = this.processMapping.get(processType);
      log.debug('Model resolved from process type', { processType, model });
      return model;
    }

    // 3. 폴백 - 기본값 사용
    const defaultModel = 'sonnet';
    log.warn('Model resolution falling back to default', {
      processType,
      taskType,
      defaultModel,
    });
    return defaultModel;
  }

  /**
   * 프로세스 타입별 모델 매핑 업데이트
   * Update process type to model mapping at runtime
   *
   * @param {string} processType - 프로세스 타입
   * @param {string} model - 모델 ID
   */
  setMapping(processType, model) {
    this.processMapping.set(processType, model);
    log.info('Process mapping updated', { processType, model });
  }

  /**
   * 작업 타입별 모델 오버라이드 추가/업데이트
   * Add or update task type override
   *
   * @param {string} taskType - 작업 타입
   * @param {string} model - 모델 ID
   */
  setTaskOverride(taskType, model) {
    this.taskOverrides.set(taskType, model);
    log.info('Task override updated', { taskType, model });
  }

  /**
   * 특정 모델의 Fallback 체인 반환
   * Get fallback chain for a model
   *
   * @param {string} model - 모델 ID ('opus', 'sonnet', 'haiku')
   * @returns {string[]} Fallback 모델들의 배열
   */
  getFallbacks(model) {
    return this.fallbackChains.get(model) || [];
  }

  /**
   * 모든 프로세스 타입 매핑 반환
   * Get all process type mappings
   *
   * @returns {Object} 매핑 객체
   */
  getMappings() {
    const result = {};
    for (const [key, value] of this.processMapping) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 모든 작업 타입 오버라이드 반환
   * Get all task overrides
   *
   * @returns {Object} 오버라이드 객체
   */
  getTaskOverrides() {
    const result = {};
    for (const [key, value] of this.taskOverrides) {
      result[key] = value;
    }
    return result;
  }

  /**
   * 라우팅 설정 상태 반환
   * Get routing configuration status
   *
   * @returns {Object} 현재 설정 상태
   */
  getStatus() {
    return {
      processMappings: this.getMappings(),
      taskOverrides: this.getTaskOverrides(),
      fallbackChains: Object.fromEntries(this.fallbackChains),
    };
  }
}

module.exports = { ProcessRouter };
