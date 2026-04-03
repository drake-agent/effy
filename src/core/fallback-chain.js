/**
 * Fallback Chain Configuration — Tier 1 모듈
 * 모델 실패시 자동 폴백 체인 실행
 * 선언적 모델 재시도 전략
 */

const { createLogger } = require('../shared/logger');

class FallbackChain {
  /**
   * 초기화 — 폴백 체인 및 재시도 정책 구성
   * @param {Object} opts - 옵션
   * @param {Object} opts.chains - { chainName: ['model1', 'model2', ...] }
   * @param {number} opts.maxRetries - 최대 재시도 횟수
   * @param {number} opts.retryDelayMs - 재시도 간 지연시간
   */
  constructor(opts = {}) {
    this.log = createLogger('FallbackChain');

    // 폴백 체인 정의: chainName → 모델 배열 (우선순위 순)
    this.chains = opts.chains ?? {
      default: ['claude-opus', 'claude-sonnet', 'claude-haiku'],
      coding: ['claude-opus', 'claude-sonnet'],
      light: ['claude-haiku', 'claude-sonnet']
    };

    this.maxRetries = opts.maxRetries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;

    // 모델별 실패 추적: model → { count, lastFailure, consecutiveFailures }
    this._failures = new Map();
    this._successCount = new Map();

    this.log.info('FallbackChain initialized', {
      chains: Object.keys(this.chains),
      maxRetries: this.maxRetries,
      retryDelayMs: this.retryDelayMs
    });
  }

  /**
   * 폴백 체인 실행
   * @param {string} chainName - 사용할 체인 이름
   * @param {Function} callFn - async (modelName) => response
   * @returns {Promise<{ response: any, modelUsed: string, fallbacksUsed: number, error: Error|null }>}
   */
  async execute(chainName, callFn) {
    try {
      const chain = this.chains[chainName] || this.chains.default;
      let lastError = null;
      let fallbacksUsed = 0;
      let nonRetryableError = false; // CE-3: flag to break outer retry loop

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (nonRetryableError) break; // CE-3: stop retrying non-retryable errors
        for (const model of chain) {
          try {
            this.log.debug('Attempting model', { model, attempt, chainName });

            const response = await callFn(model);
            this.recordSuccess(model);

            this.log.info('Model call succeeded', {
              model,
              chainName,
              fallbacksUsed,
              attempt
            });

            return {
              response,
              modelUsed: model,
              fallbacksUsed,
              error: null
            };
          } catch (err) {
            lastError = err;
            fallbacksUsed++;

            const isRetryable = this._isRetryable(err);
            this.recordFailure(model, err);

            const modelIndex = chain.indexOf(model);
            const nextIndex = modelIndex + 1;
            const nextFallback = nextIndex < chain.length ? chain[nextIndex] : 'none';

            this.log.warn('Model call failed', {
              model,
              error: err.message,
              retryable: isRetryable,
              nextFallback
            });

            if (!isRetryable) {
              nonRetryableError = true; // CE-3: propagate to outer loop
              break;
            }
          }
        }

        // 다음 재시도 전 지연
        if (attempt < this.maxRetries) {
          const delayMs = this.retryDelayMs * Math.pow(2, attempt); // exponential backoff
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      this.log.error('All fallback attempts exhausted', {
        chainName,
        lastError: lastError?.message
      });

      return {
        response: null,
        modelUsed: null,
        fallbacksUsed,
        error: lastError
      };
    } catch (err) {
      this.log.error('Unexpected error in execute', err);
      return { response: null, modelUsed: null, fallbacksUsed: 0, error: err };
    }
  }

  /**
   * 모델 실패 기록
   * @param {string} model - 모델 이름
   * @param {Error} error - 에러 객체
   */
  recordFailure(model, error) {
    const current = this._failures.get(model) || { count: 0, lastFailure: null, consecutiveFailures: 0 };
    current.count++;
    current.lastFailure = new Date().toISOString();
    current.consecutiveFailures++;

    this._failures.set(model, current);
    this.log.debug('Failure recorded', { model, totalFailures: current.count });
  }

  /**
   * 모델 성공 기록 (실패 카운트 초기화)
   * @param {string} model - 모델 이름
   */
  recordSuccess(model) {
    this._failures.set(model, { count: 0, lastFailure: null, consecutiveFailures: 0 });
    const successes = (this._successCount.get(model) || 0) + 1;
    this._successCount.set(model, successes);

    this.log.debug('Success recorded', { model, totalSuccesses: successes });
  }

  /**
   * 체인 상태 조회
   * @param {string} chainName - 체인 이름
   * @returns {Object} 체인 상태 정보
   */
  getStatus(chainName) {
    const chain = this.chains[chainName] || this.chains.default;
    const status = {
      chain: chainName,
      models: chain.map(model => ({
        name: model,
        failures: this._failures.get(model)?.count || 0,
        successes: this._successCount.get(model) || 0,
        lastFailure: this._failures.get(model)?.lastFailure || null,
        consecutiveFailures: this._failures.get(model)?.consecutiveFailures || 0
      }))
    };

    return status;
  }

  /**
   * 에러가 재시도 가능한지 판단
   * @private
   * @param {Error} err - 에러 객체
   * @returns {boolean}
   */
  _isRetryable(err) {
    // 429, 500, 503 에러는 재시도 가능
    // 타임아웃도 재시도 가능
    const message = (err.message || '').toLowerCase();
    const code = err.code || err.status || 0;

    return code === 429 || code === 500 || code === 503 ||
           message.includes('timeout') || message.includes('rate limit') ||
           message.includes('temporarily unavailable');
  }

  /**
   * 모든 실패 기록 초기화
   */
  reset() {
    this._failures.clear();
    this._successCount.clear();
    this.log.info('Failure tracking reset');
  }
}

module.exports = { FallbackChain };
