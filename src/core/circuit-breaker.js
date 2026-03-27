/**
 * circuit-breaker.js — Agent Error Detection + Auto-Disable.
 *
 * v3.9: ErrorClassifier 연동 — 에러 카테고리별 차등 대응.
 * v3.9: PostgreSQL 에러 로그 영속화 (선택적).
 *
 * 에러 카테고리별 동작:
 * - rate_limit    → 전역 쿨다운 (CircuitBreaker 안 열림, 재시도 대기)
 * - auth          → 즉시 disable (복구 불가, 수동 개입 필요)
 * - timeout       → consecutive count (기존 방식)
 * - server_error  → consecutive count (기존 방식)
 * - invalid_request → 무시 (에이전트 입력 문제, 시스템 문제 아님)
 * - quota_exceeded → 전역 쿨다운 + 알림
 * - network       → consecutive count, 짧은 쿨다운
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('core:circuit-breaker');

/**
 * 에러 카테고리별 정책
 */
const CATEGORY_POLICY = {
  rate_limit:      { tripCircuit: false, globalCooldown: true,  cooldownMs: 60000,  notify: true  },
  quota_exceeded:  { tripCircuit: false, globalCooldown: true,  cooldownMs: 300000, notify: true  },
  auth:            { tripCircuit: true,  globalCooldown: false, cooldownMs: 0,      notify: true,  immediateDisable: true },
  timeout:         { tripCircuit: true,  globalCooldown: false, cooldownMs: 0,      notify: false },
  network:         { tripCircuit: true,  globalCooldown: false, cooldownMs: 0,      notify: false, shortCooldown: 60000 },
  server_error:    { tripCircuit: true,  globalCooldown: false, cooldownMs: 0,      notify: false },
  model_unavailable: { tripCircuit: false, globalCooldown: true, cooldownMs: 120000, notify: true },
  context_overflow:  { tripCircuit: false, globalCooldown: false, cooldownMs: 0,     notify: false },
  invalid_request: { tripCircuit: false, globalCooldown: false, cooldownMs: 0,      notify: false },
  unknown:         { tripCircuit: true,  globalCooldown: false, cooldownMs: 0,      notify: false },
};

class CircuitBreaker {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.errorThreshold=3]
   * @param {number} [opts.cooldownMs=900000] - 15분 기본 쿨다운
   * @param {string} [opts.notifyChannel]
   * @param {boolean} [opts.enabled=true]
   * @param {Object} [opts.errorClassifier] - ErrorClassifier 인스턴스
   * @param {Object} [opts.db] - PostgreSQL adapter (선택)
   */
  constructor(opts = {}) {
    this.threshold = opts.errorThreshold || 3;
    this.cooldownMs = opts.cooldownMs || 900000;
    this.notifyChannel = opts.notifyChannel || '';
    this.enabled = opts.enabled !== false;
    this.errorClassifier = opts.errorClassifier || null;
    this.db = opts.db || null;

    /** @type {Map<string, AgentState>} */
    this._agents = new Map();
    this._slackClient = null;

    /** 전역 쿨다운 — rate_limit/quota 시 모든 에이전트 일시 정지 */
    this._globalCooldownUntil = 0;

    this._stats = {
      totalErrors: 0,
      trippedCount: 0,
      globalCooldowns: 0,
      ignoredErrors: 0,
    };
  }

  /** Slack client 설정 (Gateway에서 호출). */
  setSlackClient(client) {
    this._slackClient = client;
  }

  /** ErrorClassifier 설정 (지연 주입). */
  setErrorClassifier(classifier) {
    this.errorClassifier = classifier;
  }

  /** DB adapter 설정 (PostgreSQL 에러 로그 영속화). */
  setDb(db) {
    this.db = db;
  }

  /**
   * 성공 기록 — 연속 에러 카운터 리셋.
   * @param {string} agentId
   */
  recordSuccess(agentId) {
    if (!this.enabled) return;
    const state = this._agents.get(agentId);
    if (state) {
      state.consecutiveErrors = 0;
      state.lastCategory = null;
    }
  }

  /**
   * 에러 기록 — ErrorClassifier 연동 차등 대응.
   *
   * @param {string} agentId
   * @param {Error|string} error - 에러 객체 또는 메시지
   * @param {Object} [opts]
   * @param {string} [opts.provider='generic'] - LLM 프로바이더
   * @returns {ErrorAction} 취한 조치 요약
   */
  recordError(agentId, error, opts = {}) {
    if (!this.enabled) return { action: 'none', reason: 'disabled' };

    this._stats.totalErrors++;
    const provider = opts.provider || 'generic';
    const errObj = typeof error === 'string' ? { message: error } : error;
    const errMsg = errObj?.message || 'unknown';

    // ErrorClassifier로 카테고리 분류
    let category = 'unknown';
    let classification = null;

    if (this.errorClassifier) {
      classification = this.errorClassifier.classify(provider, errObj);
      category = classification.category;
    }

    const policy = CATEGORY_POLICY[category] || CATEGORY_POLICY.unknown;

    // PostgreSQL 에러 로그 기록 (비동기, 실패해도 무시)
    this._logToDb(agentId, category, errMsg, provider).catch(() => {});

    // 1) invalid_request / context_overflow → 무시 (시스템 문제 아님)
    if (!policy.tripCircuit && !policy.globalCooldown) {
      this._stats.ignoredErrors++;
      log.debug('Error ignored (not system fault)', { agentId, category });
      return { action: 'ignored', category, reason: `${category} errors don't trip circuit` };
    }

    // 2) 전역 쿨다운 (rate_limit, quota_exceeded, model_unavailable)
    if (policy.globalCooldown) {
      this._globalCooldownUntil = Date.now() + policy.cooldownMs;
      this._stats.globalCooldowns++;
      log.warn('Global cooldown activated', { category, cooldownMs: policy.cooldownMs });

      if (policy.notify) {
        this._notify(agentId, `Global cooldown: ${category} (${Math.round(policy.cooldownMs / 1000)}s)`);
      }

      return {
        action: 'global_cooldown',
        category,
        cooldownUntil: this._globalCooldownUntil,
        reason: `${category} triggered global cooldown`,
      };
    }

    // 3) 에이전트별 consecutive error tracking
    let state = this._agents.get(agentId);
    if (!state) {
      state = { consecutiveErrors: 0, lastError: '', disabledUntil: 0, lastCategory: null, disableReason: null };
      this._agents.set(agentId, state);
    }

    state.consecutiveErrors++;
    state.lastError = errMsg;
    state.lastCategory = category;

    // auth → 즉시 비활성화 (threshold 무시)
    if (policy.immediateDisable) {
      state.disabledUntil = Infinity; // 수동 복구 필요
      state.disableReason = 'auth_failure';
      this._stats.trippedCount++;
      log.error('Agent permanently disabled (auth failure)', { agentId });
      this._notify(agentId, `Auth failure — agent permanently disabled. Manual intervention required.`);
      return { action: 'disabled_permanent', category, reason: 'Auth error requires manual fix' };
    }

    // threshold 도달 시 비활성화
    if (state.consecutiveErrors >= this.threshold) {
      const effectiveCooldown = policy.shortCooldown || this.cooldownMs;
      state.disabledUntil = Date.now() + effectiveCooldown;
      state.disableReason = category;
      this._stats.trippedCount++;

      const cooldownSec = Math.round(effectiveCooldown / 1000);
      log.error(`Agent disabled`, { agentId, category, consecutiveErrors: state.consecutiveErrors, cooldownSec });

      if (policy.notify) {
        this._notify(agentId, `Disabled for ${cooldownSec}s — ${state.consecutiveErrors} consecutive ${category} errors`);
      }

      return {
        action: 'disabled',
        category,
        cooldownUntil: state.disabledUntil,
        reason: `${state.consecutiveErrors} consecutive ${category} errors`,
      };
    }

    return { action: 'counted', category, count: state.consecutiveErrors, threshold: this.threshold };
  }

  /**
   * 에이전트 비활성화 여부 확인.
   * 전역 쿨다운도 검사.
   *
   * @param {string} agentId
   * @returns {boolean}
   */
  isDisabled(agentId) {
    if (!this.enabled) return false;

    // 전역 쿨다운 확인
    if (this._globalCooldownUntil > Date.now()) return true;

    const state = this._agents.get(agentId);
    if (!state) return false;

    // 영구 비활성화 (auth)
    if (state.disabledUntil === Infinity) return true;

    if (state.disabledUntil > Date.now()) return true;

    // 자동 복구
    if (state.disabledUntil > 0) {
      state.disabledUntil = 0;
      state.consecutiveErrors = 0;
      state.disableReason = null;
      log.info(`Agent auto-recovered`, { agentId });
    }
    return false;
  }

  /**
   * 에이전트 수동 복구 (auth 실패 후).
   * @param {string} agentId
   */
  resetAgent(agentId) {
    const state = this._agents.get(agentId);
    if (state) {
      state.consecutiveErrors = 0;
      state.disabledUntil = 0;
      state.disableReason = null;
      state.lastCategory = null;
      log.info('Agent manually reset', { agentId });
    }
  }

  /**
   * 전역 쿨다운 강제 해제.
   */
  resetGlobalCooldown() {
    this._globalCooldownUntil = 0;
    log.info('Global cooldown manually reset');
  }

  /**
   * 비활성화 이유 조회.
   * @param {string} agentId
   * @returns {{ disabled: boolean, reason: string|null, remaining: number }}
   */
  getDisableInfo(agentId) {
    if (!this.enabled) return { disabled: false, reason: null, remaining: 0 };

    // 전역 쿨다운
    const globalRemaining = Math.max(0, this._globalCooldownUntil - Date.now());
    if (globalRemaining > 0) {
      return { disabled: true, reason: 'global_cooldown', remaining: globalRemaining };
    }

    const state = this._agents.get(agentId);
    if (!state) return { disabled: false, reason: null, remaining: 0 };

    if (state.disabledUntil === Infinity) {
      return { disabled: true, reason: state.disableReason || 'permanent', remaining: Infinity };
    }

    const remaining = Math.max(0, state.disabledUntil - Date.now());
    if (remaining > 0) {
      return { disabled: true, reason: state.disableReason, remaining };
    }

    return { disabled: false, reason: null, remaining: 0 };
  }

  /**
   * 전체 상태 맵.
   */
  getStats() {
    const agents = {};
    for (const [agentId, state] of this._agents) {
      agents[agentId] = {
        count: state.consecutiveErrors,
        disabledUntil: state.disabledUntil > Date.now() ? state.disabledUntil : 0,
        lastCategory: state.lastCategory,
        disableReason: state.disableReason,
      };
    }
    return {
      ...this._stats,
      globalCooldownUntil: this._globalCooldownUntil > Date.now() ? this._globalCooldownUntil : 0,
      agents,
    };
  }

  // ─── Private ───

  /** @private PostgreSQL 에러 로그 기록 */
  async _logToDb(agentId, category, message, provider) {
    if (!this.db) return;
    try {
      await this.db.run(
        `INSERT INTO circuit_breaker_log (agent_id, category, message, provider)
         VALUES (?, ?, ?, ?)`,
        [agentId, category, (message || '').substring(0, 500), provider]
      );
    } catch (err) {
      log.debug('DB log failed (non-critical)', { error: err.message });
    }
  }

  /** @private Slack 알림 */
  _notify(agentId, text) {
    if (this._slackClient && this.notifyChannel) {
      this._slackClient.chat.postMessage({
        channel: this.notifyChannel,
        text: `[CircuitBreaker] Agent \`${agentId}\`: ${text}`,
      }).catch(err => {
        log.debug('Slack notify failed', { error: err.message });
      });
    }
  }
}

module.exports = { CircuitBreaker, CATEGORY_POLICY };
