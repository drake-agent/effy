/**
 * thinking-effort.js — 프로세스/태스크별 Thinking Effort 제어.
 * 라우팅 기반 패턴: auto/low/medium/high per process type.
 * Extended Thinking 활용도 향상 + 토큰 비용 절감.
 *
 * Process/task-level Thinking Effort control.
 * Routing pattern: auto/low/medium/high per process type.
 * Maximize Extended Thinking utilization + reduce token costs.
 */

const { createLogger } = require('../shared/logger');
const { config } = require('../config');

class ThinkingEffortController {
  /**
   * 초기화 — Thinking Effort 제어기 구성
   * Initialize - Thinking Effort controller configuration
   *
   * @param {Object} opts - 옵션 / Options
   * @param {Object} [opts.defaults] - 프로세스 타입별 기본 설정 / Default effort by process type
   * @param {Object} [opts.taskOverrides] - 태스크 타입별 오버라이드 / Task type overrides
   */
  constructor(opts = {}) {
    this.log = createLogger('ThinkingEffortController');

    // 프로세스 타입별 기본 Thinking Effort
    // Default effort levels by process type
    this.defaults = {
      channel: 'auto',      // LLM 자동 결정 / Let model decide
      worker: 'high',       // 철저한 실행 / Thorough execution
      branch: 'medium',     // 병렬 사고 / Parallel thinking
      compactor: 'low',     // 요약 최적화 / Summarization, save tokens
      cortex: 'low'         // 브리핑 생성 / Bulletin generation
    };

    // 사용자 설정 오버라이드 / User config overrides
    if (opts.defaults && typeof opts.defaults === 'object') {
      this.defaults = { ...this.defaults, ...opts.defaults };
    }

    // 설정 파일에서 오버라이드 / Load from config
    if (config.thinking?.defaults && typeof config.thinking.defaults === 'object') {
      this.defaults = { ...this.defaults, ...config.thinking.defaults };
    }

    // 태스크 타입별 오버라이드 (processType 우선순위 무시)
    // Task type overrides (override process type defaults)
    this.taskOverrides = {
      coding: 'high',       // 코드 작성/리뷰 / Code generation/review
      chat: 'low',          // 간단한 대화 / Simple conversation
      analysis: 'medium',   // 분석 작업 / Analysis tasks
      summarization: 'low', // 요약 / Summarization
      planning: 'high',     // 계획/전략 / Planning/strategy
      debugging: 'high'     // 디버깅 / Debugging
    };

    if (opts.taskOverrides && typeof opts.taskOverrides === 'object') {
      this.taskOverrides = { ...this.taskOverrides, ...opts.taskOverrides };
    }

    if (config.thinking?.taskOverrides && typeof config.thinking.taskOverrides === 'object') {
      this.taskOverrides = { ...this.taskOverrides, ...config.thinking.taskOverrides };
    }

    // 토큰 예산 설정 / Token budget configuration
    this.budgets = {
      low: 2048,
      medium: 8192,
      high: 32768,
      auto: null  // API 자동 결정 / Let API decide
    };

    this.log.info('ThinkingEffortController initialized', {
      defaultsByProcessType: Object.keys(this.defaults).length,
      taskOverrides: Object.keys(this.taskOverrides).length
    });
  }

  /**
   * 메시지 복잡도에 기반한 Thinking Effort 결정
   * Resolve Thinking Effort based on process/task types and complexity
   *
   * @param {string} processType - 프로세스 타입 ('channel', 'worker', 'branch', 'compactor', 'cortex') / Process type
   * @param {string} [taskType] - 태스크 타입 ('coding', 'chat', 'analysis', etc.) / Task type
   * @param {string|number} [messageComplexity] - 메시지 복잡도 ('light'|'standard'|'heavy' or 0-1) / Message complexity
   * @returns {Object} { effort: 'auto'|'low'|'medium'|'high', budgetTokens: number|null }
   */
  resolve(processType, taskType = null, messageComplexity = 'standard') {
    try {
      // 입력 검증 / Validate input
      if (!processType || typeof processType !== 'string') {
        this.log.warn('Invalid processType', { processType });
        return { effort: 'auto', budgetTokens: null };
      }

      let effort = 'auto';

      // 1. 태스크 타입 오버라이드 확인 (최우선)
      // Check task type override (highest priority)
      if (taskType && this.taskOverrides[taskType]) {
        effort = this.taskOverrides[taskType];
        this.log.debug('Effort resolved by task type', { processType, taskType, effort });
      }
      // 2. 프로세스 타입 기본값 사용
      // Use process type default if no task override
      else if (this.defaults[processType]) {
        effort = this.defaults[processType];

        // 메시지 복잡도 기반 상향 조정 / Boost effort for complex messages
        const complexity = this._normalizeComplexity(messageComplexity);
        if (effort !== 'auto' && complexity > 0.7) {
          effort = this._boostEffort(effort);
          this.log.debug('Effort boosted by complexity', {
            processType,
            originalEffort: this.defaults[processType],
            boostedEffort: effort,
            complexity
          });
        } else {
          this.log.debug('Effort resolved by process type', { processType, effort });
        }
      } else {
        this.log.warn('Unknown process type', { processType });
      }

      // 토큰 예산 계산 / Calculate token budget
      const budgetTokens = this.budgets[effort] ?? null;

      return { effort, budgetTokens };
    } catch (err) {
      this.log.error('Error resolving thinking effort', err);
      return { effort: 'auto', budgetTokens: null };
    }
  }

  /**
   * Thinking Effort를 Anthropic API 파라미터 형식으로 변환
   * Convert effort to Anthropic API thinking parameter format
   *
   * @param {'auto'|'low'|'medium'|'high'} effort - Thinking Effort 레벨 / Effort level
   * @returns {Object} Anthropic API 파라미터 / Anthropic API parameters
   * @example
   * // Returns:
   * // { thinking: { type: 'enabled', budget_tokens: 2048 } } for 'low'
   * // {} for 'auto'
   */
  getAnthropicParam(effort = 'auto') {
    try {
      const validEfforts = ['auto', 'low', 'medium', 'high'];

      if (!validEfforts.includes(effort)) {
        this.log.warn('Invalid effort level', { effort });
        return {};
      }

      if (effort === 'auto') {
        // API가 자동으로 결정하도록 빈 객체 반환 / Return empty object to let API decide
        return {};
      }

      const budgetTokens = this.budgets[effort];
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: budgetTokens
        }
      };
    } catch (err) {
      this.log.error('Error getting Anthropic parameter', err);
      return {};
    }
  }

  /**
   * Thinking Effort 상향 조정 (한 단계 상향)
   * Boost effort one level up
   *
   * @private
   * @param {'auto'|'low'|'medium'|'high'} effort - 현재 레벨 / Current level
   * @returns {'auto'|'low'|'medium'|'high'} 상향 조정된 레벨 / Boosted level
   */
  _boostEffort(effort) {
    const levels = ['auto', 'low', 'medium', 'high'];
    const currentIndex = levels.indexOf(effort);

    if (currentIndex < levels.length - 1) {
      return levels[currentIndex + 1];
    }

    return effort; // 이미 최고 수준 / Already at max
  }

  /**
   * 복잡도를 정규화된 0-1 값으로 변환
   * Normalize complexity to 0-1 scale
   *
   * @private
   * @param {string|number} complexity - 복잡도 ('light'|'standard'|'heavy' or 0-1) / Complexity
   * @returns {number} 정규화된 값 (0-1) / Normalized value
   */
  _normalizeComplexity(complexity) {
    if (typeof complexity === 'number') {
      return Math.max(0, Math.min(1, complexity));
    }

    if (typeof complexity === 'string') {
      const map = {
        light: 0.25,
        standard: 0.5,
        heavy: 0.85
      };
      return map[complexity.toLowerCase()] ?? 0.5;
    }

    return 0.5; // 기본값 / Default
  }

  /**
   * 프로세스 타입별 현재 설정 조회
   * Get current effort configuration for a process type
   *
   * @param {string} processType - 프로세스 타입 / Process type
   * @returns {Object} { effort: string, budgetTokens: number|null, description: string }
   */
  getConfig(processType) {
    try {
      const effort = this.defaults[processType] ?? 'unknown';
      const budgetTokens = this.budgets[effort] ?? null;
      const description = this._describeEffort(effort);

      return { effort, budgetTokens, description };
    } catch (err) {
      this.log.error('Error getting config', err);
      return { effort: 'unknown', budgetTokens: null, description: '' };
    }
  }

  /**
   * Thinking Effort 레벨 설명
   * Describe effort level
   *
   * @private
   * @param {'auto'|'low'|'medium'|'high'} effort - 레벨 / Level
   * @returns {string}
   */
  _describeEffort(effort) {
    const descriptions = {
      auto: 'Model decides thinking effort',
      low: 'Minimal thinking (fast, cheap)',
      medium: 'Moderate thinking (balanced)',
      high: 'Extended thinking (thorough, expensive)'
    };
    return descriptions[effort] || 'Unknown effort level';
  }

  /**
   * 전체 기본값 설정 조회
   * Get all default configurations
   *
   * @returns {Object}
   */
  getAllDefaults() {
    try {
      const result = {};
      for (const [processType, effort] of Object.entries(this.defaults)) {
        result[processType] = {
          effort,
          budgetTokens: this.budgets[effort] ?? null,
          description: this._describeEffort(effort)
        };
      }
      return result;
    } catch (err) {
      this.log.error('Error getting all defaults', err);
      return {};
    }
  }

  /**
   * 기본값 업데이트
   * Update default effort for a process type
   *
   * @param {string} processType - 프로세스 타입 / Process type
   * @param {'auto'|'low'|'medium'|'high'} effort - 새로운 레벨 / New level
   */
  setDefault(processType, effort) {
    try {
      const validEfforts = ['auto', 'low', 'medium', 'high'];

      if (!validEfforts.includes(effort)) {
        throw new Error(`Invalid effort: ${effort}`);
      }

      this.defaults[processType] = effort;
      this.log.info('Default effort updated', { processType, effort });
    } catch (err) {
      this.log.error('Error setting default', err);
    }
  }

  /**
   * 태스크 타입 오버라이드 업데이트
   * Update task type override
   *
   * @param {string} taskType - 태스크 타입 / Task type
   * @param {'auto'|'low'|'medium'|'high'} effort - 새로운 레벨 / New level
   */
  setTaskOverride(taskType, effort) {
    try {
      const validEfforts = ['auto', 'low', 'medium', 'high'];

      if (!validEfforts.includes(effort)) {
        throw new Error(`Invalid effort: ${effort}`);
      }

      this.taskOverrides[taskType] = effort;
      this.log.info('Task override updated', { taskType, effort });
    } catch (err) {
      this.log.error('Error setting task override', err);
    }
  }
}

module.exports = { ThinkingEffortController };
