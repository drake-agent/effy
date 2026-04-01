/**
 * circuit-breaker.js — Agent Error Detection + Auto-Disable.
 *
 * 연속 에러 threshold 도달 시 에이전트를 cooldownMs 동안 비활성화.
 * 자동 복구: disabledUntil 경과 후 자동 활성화.
 * Slack 알림 지원 (notifyChannel 설정 시).
 */
const { config } = require('../config');

// R3-STRUCT-2: category-based error policy (기본값)
const CATEGORY_POLICY = {
  auth:       { weight: 3, action: 'immediate' },   // 인증 오류 → 즉시 차단
  timeout:    { weight: 1, action: 'count' },        // 타임아웃 → 카운트
  rate_limit: { weight: 1, action: 'count' },        // Rate limit → 카운트
  server:     { weight: 2, action: 'count' },        // 5xx → 가중 카운트
  unknown:    { weight: 1, action: 'count' },        // 기타 → 카운트
};

class CircuitBreaker {
  constructor(opts = {}) {
    const cbCfg = config.circuitBreaker || {};
    this.threshold = cbCfg.errorThreshold || 3;
    this.cooldownMs = cbCfg.cooldownMs || 900000; // 15분
    this.notifyChannel = cbCfg.notifyChannel || '';
    this.enabled = cbCfg.enabled !== false;
    // R3-STRUCT-2: config-driven category policy
    this.categoryPolicy = opts.categoryPolicy
      ? { ...CATEGORY_POLICY, ...opts.categoryPolicy }
      : { ...CATEGORY_POLICY };
    // R3-PERF-CB: 알림 디바운스 30s
    this._lastNotifyAt = 0;
    this._notifyDebounceMs = cbCfg.notifyDebounceMs || 30000;

    /** @type {Map<string, { consecutiveErrors: number, lastError: string, disabledUntil: number }>} */
    this._agents = new Map();
    this._slackClient = null;
  }

  /** Slack client 설정 (Gateway에서 호출). */
  setSlackClient(client) {
    this._slackClient = client;
  }

  /** 성공 기록 — 연속 에러 카운터 리셋. */
  recordSuccess(agentId) {
    if (!this.enabled) return;
    const state = this._agents.get(agentId);
    if (state) state.consecutiveErrors = 0;
  }

  /** 에러 기록 — threshold 도달 시 비활성화. R3-STRUCT-2: category 기반 가중치 */
  recordError(agentId, errMsg, category = 'unknown') {
    if (!this.enabled) return;

    let state = this._agents.get(agentId);
    if (!state) {
      state = { consecutiveErrors: 0, lastError: '', disabledUntil: 0 };
      this._agents.set(agentId, state);
    }

    // R3-STRUCT-2: category policy 적용
    const policy = this.categoryPolicy[category] || this.categoryPolicy.unknown;
    if (policy.action === 'immediate') {
      state.consecutiveErrors = this.threshold; // 즉시 차단
    } else {
      state.consecutiveErrors += (policy.weight || 1);
    }
    state.lastError = errMsg || 'unknown';

    if (state.consecutiveErrors >= this.threshold) {
      state.disabledUntil = Date.now() + this.cooldownMs;
      const cooldownMin = Math.round(this.cooldownMs / 60000);
      console.error(`[circuit-breaker] Agent '${agentId}' disabled for ${cooldownMin}m — errors: ${state.consecutiveErrors}, category: ${category}`);

      // R3-PERF-CB: 알림 디바운스 — 30초 이내 중복 알림 방지
      const now = Date.now();
      if (this._slackClient && this.notifyChannel && (now - this._lastNotifyAt > this._notifyDebounceMs)) {
        this._lastNotifyAt = now;
        this._slackClient.chat.postMessage({
          channel: this.notifyChannel,
          text: `[CircuitBreaker] Agent \`${agentId}\` disabled for ${cooldownMin}m.\nConsecutive errors: ${state.consecutiveErrors}\nCategory: ${category}\nLast error: ${String(errMsg).slice(0, 200)}`,
        }).catch(err => {
          console.error(`[circuit-breaker] Slack notify failed: ${err.message}`);
        });
      }
    }
  }

  /** 에이전트 비활성화 여부 확인. disabledUntil 경과 시 자동 복구. */
  isDisabled(agentId) {
    if (!this.enabled) return false;
    const state = this._agents.get(agentId);
    if (!state) return false;

    if (state.disabledUntil > Date.now()) return true;

    // 자동 복구
    if (state.disabledUntil > 0) {
      state.disabledUntil = 0;
      state.consecutiveErrors = 0;
      console.log(`[circuit-breaker] Agent '${agentId}' auto-recovered`);
    }
    return false;
  }

  /** 전체 상태 맵. */
  getStats() {
    const stats = {};
    for (const [agentId, state] of this._agents) {
      stats[agentId] = {
        count: state.consecutiveErrors,
        disabledUntil: state.disabledUntil > Date.now() ? state.disabledUntil : 0,
      };
    }
    return stats;
  }
}

module.exports = { CircuitBreaker, CATEGORY_POLICY };
