/**
 * sql-database.js — SQL Database 커넥터.
 *
 * 외부 SQLite/PostgreSQL/MySQL 등 SQL DB 연동.
 * 현재는 better-sqlite3 기반 (Phase 2에서 pg 드라이버 추가 예정).
 *
 * Config 예시:
 *   datasources:
 *     analytics-db:
 *       type: sql
 *       driver: sqlite           # sqlite | postgresql (Phase 2)
 *       path: ./data/analytics.db
 *       readOnly: true
 *       maxResults: 500
 *       agents: [knowledge, strategy]
 *       # PostgreSQL (Phase 2):
 *       # url: ${ANALYTICS_DB_URL}
 *       # pool: { max: 5 }
 */
const { BaseConnector } = require('../base-connector');

class SqlDatabaseConnector extends BaseConnector {
  constructor(id, options) {
    super(id, 'sql', options);
    this.driver = options.driver || 'sqlite';
    this.db = null;
  }

  async init() {
    if (this.driver === 'sqlite') {
      await this._initSqlite();
    } else {
      throw new Error(`sql:${this.id} — 미지원 드라이버: ${this.driver} (sqlite만 지원)`);
    }
    this.ready = true;
    this.log.info('Connected', { driver: this.driver, readOnly: this.readOnly });
  }

  /**
   * SQL 쿼리 실행.
   * @param {string} queryString — SQL (SELECT만 허용 in readOnly mode)
   * @param {object} params — { bindings: [] } SQL 바인딩 파라미터
   */
  async query(queryString, params = {}) {
    if (!this.ready || !this.db) throw new Error(`sql:${this.id} — 초기화되지 않음`);

    const sql = queryString.trim();

    // SEC-SQL fix: Stacked query 차단 — 문자열 리터럴 + SQL 주석 모두 제거 후 세미콜론 검출
    const strippedSql = sql
      .replace(/'[^']*'/g, '')       // 단일 따옴표 문자열 제거
      .replace(/"[^"]*"/g, '')       // 이중 따옴표 식별자 제거
      .replace(/--[^\n]*/g, '')      // 단일행 주석 제거
      .replace(/\/\*[\s\S]*?\*\//g, '');  // 블록 주석 제거
    if (/;[\s]*\S/.test(strippedSql)) {
      return {
        rows: [],
        metadata: { error: 'stacked query 차단: 단일 statement만 허용', connector: this.id },
      };
    }

    // readOnly 모드: SELECT만 허용 (SQL injection 방어)
    if (!/^\s*SELECT\s/i.test(sql)) {
      const blocked = this.guardReadOnly('SELECT 쿼리만 허용');
      if (blocked) return blocked;
    }

    // DDL 차단 (DROP, TRUNCATE, ALTER) — readOnly 여부 무관, 항상 차단
    if (/\b(DROP|TRUNCATE|ALTER)\b/i.test(sql)) {
      return {
        rows: [],
        metadata: { error: 'DDL 쿼리 차단됨 (DROP/TRUNCATE/ALTER)', connector: this.id },
      };
    }

    try {
      const bindings = params.bindings || [];
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...bindings);

      return {
        rows: this.truncateResults(rows),
        metadata: {
          connector: this.id,
          driver: this.driver,
          rowCount: rows.length,
          truncated: rows.length > this.maxResults,
        },
      };
    } catch (e) {
      this.log.error('Query failed', { sql: sql.slice(0, 100), error: e.message });
      return { rows: [], metadata: { error: e.message, connector: this.id } };
    }
  }

  async destroy() {
    if (this.db) {
      try { this.db.close(); } catch (_) { /* ignore */ }
      this.db = null;
    }
    await super.destroy();
    this.log.info('Disconnected');
  }

  // ─── 내부 ─────────────────────────────────────────

  async _initSqlite() {
    const dbPath = this.options.path;
    if (!dbPath) throw new Error(`sql:${this.id} — path 필수 (SQLite)`);

    const Database = require('better-sqlite3');
    this.db = new Database(dbPath, {
      readonly: this.readOnly,
      fileMustExist: true,
    });
    this.db.pragma('journal_mode = WAL');
  }
}

module.exports = { SqlDatabaseConnector };
