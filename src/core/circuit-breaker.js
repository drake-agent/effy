/**
 * circuit-breaker.js — Agent Error Detection + Auto-Disable.
 *
 * 연속 에러 threshold 도달 시 에이전트를 cooldownMs 동안 비활성화.
 * 자동 복구: disabledUntil 경과 후 자동 활성화.
 * Slack 알림 지원 (notifyChannel 설정 시).
 */
const { config } = require('../config');

class CircuitBreaker {
  constructor() {
    const cbCfg = config.circuitBreaker || {};
    this.threshold = cbCfg.errorThreshold || 3;
    this.cooldownMs = cbCfg.cooldownMs || 900000; // 15분
    this.notifyChannel = cbCfg.notifyChannel || '';
    this.enabled = cbCfg.enabled !== false;

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

  /** 에러 기록 — threshold 도달 시 비활성화. */
  recordError(agentId, errMsg) {
    if (!this.enabled) return;

    let state = this._agents.get(agentId);
    if (!state) {
      state = { consecutiveErrors: 0, lastError: '', disabledUntil: 0 };
      this._agents.set(agentId, state);
    }

    state.consecutiveErrors++;
    state.lastError = errMsg || 'unknown';

    if (state.consecutiveErrors >= this.threshold) {
      state.disabledUntil = Date.now() + this.cooldownMs;
      const cooldownMin = Math.round(this.cooldownMs / 60000);
      console.error(`[circuit-breaker] Agent '${agentId}' disabled for ${cooldownMin}m — ${state.consecutiveErrors} consecutive errors: ${errMsg}`);

      if (this._slackClient && this.notifyChannel) {
        this._slackClient.chat.postMessage({
          channel: this.notifyChannel,
          text: `[CircuitBreaker] Agent \`${agentId}\` disabled for ${cooldownMin}m.\nConsecutive errors: ${state.consecutiveErrors}\nLast error: ${errMsg}`,
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

module.exports = { CircuitBreaker };
