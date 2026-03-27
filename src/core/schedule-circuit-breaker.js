/**
 * schedule-circuit-breaker.js — 스케줄 Circuit Breaker (SpaceBot 차용).
 *
 * Cron job이 3회 연속 실패 시 자동 비활성화.
 * 실패하는 작업이 영원히 LLM 토큰을 소모하는 것을 방지.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('schedule-cb');

class ScheduleCircuitBreaker {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.failureThreshold=3] - 연속 실패 임계치
   * @param {number} [opts.cooldownMs=3600000] - 자동 복구 대기 시간 (1시간)
   * @param {boolean} [opts.autoRecover=true] - 쿨다운 후 자동 재활성화
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 3600000;
    this.autoRecover = opts.autoRecover ?? true;

    /** @type {Map<string, { failures: number, disabledAt: number|null, lastError: string }>} */
    this._state = new Map();
  }

  /**
   * Job 실행 가능 여부 확인.
   * @param {string} jobName
   * @returns {{ allowed: boolean, reason: string }}
   */
  canRun(jobName) {
    const state = this._state.get(jobName);
    if (!state) return { allowed: true, reason: 'No failure history' };

    if (state.disabledAt) {
      // 자동 복구 확인
      if (this.autoRecover && (Date.now() - state.disabledAt) > this.cooldownMs) {
        state.failures = 0;
        state.disabledAt = null;
        log.info('Schedule auto-recovered', { jobName });
        return { allowed: true, reason: 'Auto-recovered after cooldown' };
      }

      const remainingMs = this.cooldownMs - (Date.now() - state.disabledAt);
      return {
        allowed: false,
        reason: `Circuit open: ${state.failures} consecutive failures. Recovery in ${Math.ceil(remainingMs / 60000)}min. Last error: ${state.lastError}`,
      };
    }

    return { allowed: true, reason: `${state.failures}/${this.failureThreshold} failures` };
  }

  /**
   * Job 성공 기록.
   * @param {string} jobName
   */
  recordSuccess(jobName) {
    const state = this._state.get(jobName);
    if (state) {
      state.failures = 0;
      state.disabledAt = null;
    }
  }

  /**
   * Job 실패 기록.
   * @param {string} jobName
   * @param {string} error - 에러 메시지
   * @returns {{ tripped: boolean, failures: number }}
   */
  recordFailure(jobName, error) {
    let state = this._state.get(jobName);
    if (!state) {
      state = { failures: 0, disabledAt: null, lastError: '' };
      this._state.set(jobName, state);
    }

    state.failures++;
    state.lastError = (error || '').slice(0, 200);

    if (state.failures >= this.failureThreshold && !state.disabledAt) {
      state.disabledAt = Date.now();
      log.error('Schedule circuit OPEN', { jobName, failures: state.failures, error: state.lastError });
      return { tripped: true, failures: state.failures };
    }

    log.warn('Schedule failure recorded', { jobName, failures: state.failures, threshold: this.failureThreshold });
    return { tripped: false, failures: state.failures };
  }

  /**
   * 수동 리셋.
   * @param {string} jobName
   */
  reset(jobName) {
    this._state.delete(jobName);
    log.info('Schedule circuit reset', { jobName });
  }

  /**
   * 상태 요약.
   * @returns {Object}
   */
  getStatus() {
    const jobs = {};
    for (const [name, state] of this._state) {
      jobs[name] = {
        failures: state.failures,
        disabled: !!state.disabledAt,
        disabledAt: state.disabledAt ? new Date(state.disabledAt).toISOString() : null,
        lastError: state.lastError,
      };
    }
    return jobs;
  }
}

module.exports = { ScheduleCircuitBreaker };
