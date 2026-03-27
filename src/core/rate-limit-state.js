/**
 * rate-limit-state.js — 글로벌 모델 Rate-Limit 공유 상태 (SpaceBot 차용).
 *
 * 429 에러 받은 모델을 모든 에이전트에 걸쳐 일정 시간 회피.
 * 기존 ModelRouter의 로컬 상태를 글로벌로 확장.
 *
 * SpaceBot: 429된 모델 60초 cooldown (모든 에이전트 공유)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('rate-limit-state');

class GlobalRateLimitState {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.defaultCooldownMs=60000] - 기본 쿨다운 (60초)
   * @param {number} [opts.maxCooldownMs=300000] - 최대 쿨다운 (5분)
   * @param {number} [opts.backoffMultiplier=1.5] - 반복 429 시 쿨다운 증가 배율
   */
  constructor(opts = {}) {
    this.defaultCooldownMs = opts.defaultCooldownMs ?? 60000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 300000;
    this.backoffMultiplier = opts.backoffMultiplier ?? 1.5;

    /** @type {Map<string, { cooldownUntil: number, hitCount: number, lastCooldownMs: number }>} */
    this._rateLimited = new Map();
  }

  /**
   * 모델 Rate-Limit 기록 (429 에러 시 호출).
   * @param {string} modelId - 모델 ID
   * @param {Object} [opts]
   * @param {number} [opts.retryAfterMs] - 서버가 지정한 재시도 시간
   * @param {string} [opts.agentId] - 보고한 에이전트
   */
  recordRateLimit(modelId, opts = {}) {
    const existing = this._rateLimited.get(modelId);
    const hitCount = (existing?.hitCount || 0) + 1;

    // 점진적 백오프
    const baseCooldown = opts.retryAfterMs || this.defaultCooldownMs;
    const cooldownMs = Math.min(
      baseCooldown * Math.pow(this.backoffMultiplier, hitCount - 1),
      this.maxCooldownMs
    );

    this._rateLimited.set(modelId, {
      cooldownUntil: Date.now() + cooldownMs,
      hitCount,
      lastCooldownMs: cooldownMs,
      lastAgentId: opts.agentId,
      recordedAt: Date.now(),
    });

    log.warn('Model rate-limited (global)', {
      modelId,
      cooldownMs,
      hitCount,
      agentId: opts.agentId,
    });
  }

  /**
   * 모델 사용 가능 여부 확인.
   * @param {string} modelId
   * @returns {{ available: boolean, cooldownRemainingMs: number }}
   */
  isAvailable(modelId) {
    const state = this._rateLimited.get(modelId);
    if (!state) return { available: true, cooldownRemainingMs: 0 };

    const remaining = state.cooldownUntil - Date.now();
    if (remaining <= 0) {
      // 쿨다운 만료 → 상태 정리
      this._rateLimited.delete(modelId);
      return { available: true, cooldownRemainingMs: 0 };
    }

    return { available: false, cooldownRemainingMs: remaining };
  }

  /**
   * 사용 가능한 모델 필터링.
   * @param {string[]} models - 후보 모델 목록
   * @returns {string[]} 사용 가능한 모델만
   */
  filterAvailable(models) {
    return models.filter(m => this.isAvailable(m).available);
  }

  /**
   * 모델 성공 기록 (쿨다운 리셋).
   * @param {string} modelId
   */
  recordSuccess(modelId) {
    if (this._rateLimited.has(modelId)) {
      this._rateLimited.delete(modelId);
      log.info('Model rate-limit cleared', { modelId });
    }
  }

  /**
   * 현재 Rate-Limit 상태 요약.
   * @returns {Object}
   */
  getStatus() {
    const now = Date.now();
    const limited = [];
    for (const [modelId, state] of this._rateLimited) {
      const remaining = state.cooldownUntil - now;
      if (remaining > 0) {
        limited.push({ modelId, remainingMs: remaining, hitCount: state.hitCount });
      }
    }
    return { limitedModels: limited, totalLimited: limited.length };
  }
}

module.exports = { GlobalRateLimitState };
