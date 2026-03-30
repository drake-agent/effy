/**
 * keyring-isolation.js — 워커별 비밀 격리
 * Per-Worker Secret Isolation
 *
 * 워커들이 스코핑된 비밀 접근만 가능 — 다른 에이전트의 비밀 조회 불가.
 * 접근 기록 감사 추적 유지.
 */

const { createLogger } = require('./logger');

const log = createLogger('shared/keyring-isolation');

/**
 * 키링 격리 및 접근 제어 클래스
 * KeyringIsolation — 프로세스 타입별 권한 제어
 */
class KeyringIsolation {
  /**
   * @param {Object} [opts]
   * @param {Object} opts.keyring - KeyringManager 인스턴스
   */
  constructor(opts = {}) {
    this.keyring = opts.keyring;
    if (!this.keyring) {
      throw new Error('KeyringManager instance required');
    }

    this._accessLog = []; // 접근 기록: { timestamp, processType, agentId, key, action, allowed }
    this._policies = new Map(); // processType → allowed keys[]
    this._maxLogSize = 10000; // 기록 최대 크기

    // 기본 정책 설정
    this._initDefaultPolicies();
  }

  /**
   * 프로세스 타입별 접근 정책 설정
   * @param {string} processType - 'channel'|'worker'|'branch'|'cortex'
   * @param {string[]} allowedKeys - 접근 가능한 키 목록
   */
  setPolicy(processType, allowedKeys) {
    try {
      if (!Array.isArray(allowedKeys)) {
        throw new Error('allowedKeys must be an array');
      }

      this._policies.set(processType, allowedKeys);
      log.info('Policy set', { processType, allowedKeysCount: allowedKeys.length });
    } catch (err) {
      log.error('Failed to set policy', err);
      throw err;
    }
  }

  /**
   * 특정 프로세스용 스코핑된 키링 프록시 생성
   * get/list만 가능, 허용된 키로만 접근
   * @param {string} processType
   * @param {string} agentId
   * @returns {Object} - 스코핑된 프록시
   */
  createScopedProxy(processType, agentId) {
    try {
      const allowedKeys = this._policies.get(processType) || [];
      const self = this;

      return {
        /**
         * 스코핑된 비밀 조회
         */
        async get(key) {
          const allowed = self.checkAccess(processType, key);
          self._logAccess(processType, agentId, key, 'get', allowed.allowed);

          if (!allowed.allowed) {
            log.warn('Access denied', { processType, key, reason: allowed.reason });
            return null;
          }

          try {
            const value = await self.keyring.get(key, agentId);
            return value;
          } catch (err) {
            log.error('Failed to retrieve secret via proxy', err);
            return null;
          }
        },

        /**
         * 스코핑된 키 나열
         */
        async list() {
          self._logAccess(processType, agentId, '*', 'list', true);

          try {
            const allKeys = await self.keyring.list(agentId);
            const filtered = allKeys.filter((k) => allowedKeys.includes(k) || allowedKeys.includes('*'));
            return filtered;
          } catch (err) {
            log.error('Failed to list secrets via proxy', err);
            return [];
          }
        },

        /**
         * 프록시의 정책 확인
         */
        getPolicies() {
          return allowedKeys;
        },

        /**
         * 프록시의 프로세스 타입 반환
         */
        getProcessType() {
          return processType;
        },
      };
    } catch (err) {
      log.error('Failed to create scoped proxy', err);
      throw err;
    }
  }

  /**
   * 프로세스가 특정 비밀에 접근 가능한지 확인
   * @param {string} processType
   * @param {string} key
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkAccess(processType, key) {
    const allowedKeys = this._policies.get(processType) || [];

    // 와일드카드 체크
    if (allowedKeys.includes('*')) {
      return { allowed: true, reason: 'Wildcard access granted' };
    }

    // 정확한 키 매칭
    if (allowedKeys.includes(key)) {
      return { allowed: true, reason: 'Key in policy' };
    }

    // 패턴 매칭 (prefix:*) — 유효성 검사 포함
    const matchingPattern = allowedKeys.find((pattern) => {
      if (typeof pattern !== 'string') {
        return false;
      }
      if (pattern.endsWith(':*') && pattern.length > 2) {
        const prefix = pattern.slice(0, -2);
        // prefix에 유효한 문자만 포함되도록 검증
        if (/^[a-zA-Z0-9\-_:]+$/.test(prefix)) {
          return key.startsWith(prefix);
        }
      }
      return false;
    });

    if (matchingPattern) {
      return { allowed: true, reason: `Matches pattern: ${matchingPattern}` };
    }

    return { allowed: false, reason: `Key not in policy for ${processType}` };
  }

  /**
   * 접근 감시 로그 조회
   * @param {Object} [filter]
   * @param {string} [filter.agentId]
   * @param {string} [filter.processType]
   * @param {string} [filter.key]
   * @param {number} [filter.after] - Unix timestamp
   * @returns {Array<Object>}
   */
  getAccessLog(filter = {}) {
    try {
      let logs = this._accessLog;

      if (filter.agentId) {
        logs = logs.filter((l) => l.agentId === filter.agentId);
      }

      if (filter.processType) {
        logs = logs.filter((l) => l.processType === filter.processType);
      }

      if (filter.key) {
        logs = logs.filter((l) => l.key === filter.key);
      }

      if (filter.after) {
        logs = logs.filter((l) => l.timestamp >= filter.after);
      }

      return logs;
    } catch (err) {
      log.error('Failed to get access log', err);
      return [];
    }
  }

  /**
   * 접근 기록 초기화
   */
  clearAccessLog() {
    this._accessLog = [];
    log.debug('Access log cleared');
  }

  /**
   * 기본 정책 초기화
   * @private
   */
  _initDefaultPolicies() {
    // channel: 일반적인 API 키 접근
    this.setPolicy('channel', ['anthropic-api-key', 'github-api', 'openai-api']);

    // worker: 제한된 도구 접근
    this.setPolicy('worker', ['http-timeout', 'proxy-config']);

    // branch: 자신의 컨텍스트만
    this.setPolicy('branch', ['context:*']);

    // cortex: 모든 핵심 비밀 접근 (제한적)
    this.setPolicy('cortex', ['anthropic-api-key', 'knowledge:*']);

    log.debug('Default policies initialized');
  }

  /**
   * 내부: 접근 기록 로깅
   * @private
   */
  _logAccess(processType, agentId, key, action, allowed) {
    try {
      const entry = {
        timestamp: Date.now(),
        processType,
        agentId,
        key,
        action, // 'get'|'list'|'set'|'delete'
        allowed,
      };

      this._accessLog.push(entry);

      // 로그 크기 제한
      if (this._accessLog.length > this._maxLogSize) {
        this._accessLog = this._accessLog.slice(-this._maxLogSize);
      }

      if (!allowed) {
        log.warn('Access denied (logged)', { processType, key, action });
      }
    } catch (err) {
      log.error('Failed to log access', err);
    }
  }
}

module.exports = { KeyringIsolation };
