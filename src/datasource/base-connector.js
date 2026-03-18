/**
 * base-connector.js — DataSource Connector 인터페이스.
 *
 * 모든 커넥터가 구현해야 하는 추상 계약.
 * 새 커넥터 추가 시 이 클래스를 상속하고 3개 메서드만 구현하면 됨.
 *
 * 라이프사이클: init() → query()/list() → destroy()
 */
const { createLogger } = require('../shared/logger');

class BaseConnector {
  /**
   * @param {string} id        — 커넥터 고유 ID (config에서 정의)
   * @param {string} type      — 커넥터 타입 (rest_api, sql, filesystem, etc.)
   * @param {object} options   — 타입별 설정 (url, auth, path 등)
   */
  constructor(id, type, options = {}) {
    if (new.target === BaseConnector) {
      throw new Error('BaseConnector는 직접 인스턴스화할 수 없습니다. 상속하세요.');
    }
    this.id = id;
    this.type = type;
    this.options = options;
    this.ready = false;
    this.log = createLogger(`datasource:${id}`);

    // 접근 제어 — config에서 정의
    this.allowedAgents = options.agents ?? ['*'];
    this.readOnly = options.readOnly !== false;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxResults = options.maxResults ?? 100;
  }

  // ─── 필수 구현 메서드 (3개) ──────────────────────────

  /**
   * 커넥터 초기화 (커넥션 풀 생성, 인증 등).
   * @returns {Promise<void>}
   */
  async init() {
    throw new Error(`${this.type}:${this.id} — init() 미구현`);
  }

  /**
   * 데이터 조회.
   * @param {string} queryString  — SQL, API path, glob 패턴 등
   * @param {object} params       — 바인딩 파라미터 또는 쿼리 옵션
   * @returns {Promise<{ rows: Array, metadata: object }>}
   */
  async query(queryString, params = {}) {
    throw new Error(`${this.type}:${this.id} — query() 미구현`);
  }

  /**
   * 커넥터 정리 (커넥션 풀 해제 등).
   * @returns {Promise<void>}
   */
  async destroy() {
    this.ready = false;
  }

  // ─── 공통 유틸리티 ───────────────────────────────────

  /**
   * 에이전트 접근 권한 검증.
   * @param {string} agentId — 요청하는 에이전트 ID
   * @returns {boolean}
   */
  canAccess(agentId) {
    if (this.allowedAgents.includes('*')) return true;
    return this.allowedAgents.includes(agentId);
  }

  /**
   * readOnly 모드 쓰기 작업 차단 가드.
   * @param {string} operation — 차단된 작업 설명 (e.g. 'POST', 'INSERT')
   * @returns {{ rows: Array, metadata: object }|null} — 차단 시 에러 응답, 허용 시 null
   */
  guardReadOnly(operation) {
    if (!this.readOnly) return null;
    return { rows: [], metadata: { error: `readOnly 모드: ${operation} 불허`, connector: this.id } };
  }

  /**
   * 결과 행 수 제한.
   * @param {Array} rows
   * @returns {Array}
   */
  truncateResults(rows) {
    if (!Array.isArray(rows)) return [];
    if (rows.length <= this.maxResults) return rows;
    this.log.warn('Result truncated', { original: rows.length, limit: this.maxResults });
    return rows.slice(0, this.maxResults);
  }

  /**
   * 타임아웃 래퍼.
   * @param {Promise} promise
   * @param {number} ms
   * @returns {Promise}
   */
  withTimeout(promise, ms) {
    const timeout = ms ?? this.timeoutMs;
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout: ${timeout}ms exceeded`)), timeout);
      }),
    ]);
  }

  /**
   * 커넥터 상태 요약 (LLM 컨텍스트용).
   * @returns {object}
   */
  describe() {
    return {
      id: this.id,
      type: this.type,
      ready: this.ready,
      readOnly: this.readOnly,
      description: this.options.description || `${this.type} connector: ${this.id}`,
    };
  }
}

module.exports = { BaseConnector };
