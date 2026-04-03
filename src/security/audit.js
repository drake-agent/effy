/**
 * audit.js — Audit logging (v4.0 Security).
 *
 * 모든 보안 관련 이벤트를 audit_log 테이블에 기록.
 * 인증 시도, 권한 확인, 비밀 접근, 신뢰 경계 이벤트 등.
 *
 * DB가 초기화되지 않았으면 로거로 폴백.
 *
 * Export: AuditLogger (singleton)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('security:audit');

// DB는 지연 로드 (순환 참조 방지)
let _db = null;
function _getDb() {
  if (!_db) {
    try {
      _db = require('../db');
    } catch (err) {
      log.warn('DB module not available for audit logging', { error: err.message });
    }
  }
  return _db;
}

class AuditLogger {
  constructor() {
    this._tableCreated = false;
    this._tableCreatePromise = null;
  }

  /**
   * audit_log 테이블 자동 생성.
   */
  async _ensureTable() {
    if (this._tableCreated) return;

    // 동시 호출 방지
    if (this._tableCreatePromise) {
      return this._tableCreatePromise;
    }

    this._tableCreatePromise = this._createTable();
    await this._tableCreatePromise;
    this._tableCreatePromise = null;
  }

  async _createTable() {
    const db = _getDb();
    if (!db || !db.isInitialized || !db.isInitialized()) {
      log.debug('DB not initialized — audit will use logger fallback');
      return;
    }

    try {
      const createSql = `
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          user_id TEXT,
          agent_id TEXT,
          action TEXT,
          resource TEXT,
          success INTEGER,
          metadata TEXT,
          ip_address TEXT
        )
      `;

      // Use dbExec for dual-mode compat (works on both SQLite and PostgreSQL)
      if (db.dbExec) {
        // PostgreSQL uses SERIAL instead of AUTOINCREMENT
        if (db.isPostgres && db.isPostgres()) {
          const pgSql = `
            CREATE TABLE IF NOT EXISTS audit_log (
              id SERIAL PRIMARY KEY,
              event_type TEXT NOT NULL,
              timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              user_id TEXT,
              agent_id TEXT,
              action TEXT,
              resource TEXT,
              success BOOLEAN,
              metadata JSONB,
              ip_address TEXT
            )
          `;
          await db.dbExec(pgSql);
        } else {
          await db.dbExec(createSql);
        }
      } else {
        const rawDb = db.getDb();
        await rawDb.exec(createSql);
      }

      this._tableCreated = true;
      log.debug('audit_log table ensured');
    } catch (err) {
      log.error('Failed to create audit_log table', { error: err.message });
    }
  }

  /**
   * 감사 이벤트 기록.
   * @param {string} eventType
   * @param {object} data
   */
  async _log(eventType, data) {
    const entry = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      user_id: data.userId || null,
      agent_id: data.agentId || null,
      action: data.action || null,
      resource: data.resource || null,
      success: data.success !== undefined ? (data.success ? 1 : 0) : null,
      metadata: data.metadata ? JSON.stringify(data.metadata) : null,
      ip_address: data.ipAddress || null,
    };

    // Always log to structured logger
    log.info(`AUDIT [${eventType}]`, entry);

    // Persist to DB
    await this._ensureTable();

    const db = _getDb();
    if (!db || !this._tableCreated) return;

    try {
      if (db.dbRun) {
        await db.dbRun(
          `INSERT INTO audit_log (event_type, timestamp, user_id, agent_id, action, resource, success, metadata, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [entry.event_type, entry.timestamp, entry.user_id, entry.agent_id, entry.action, entry.resource, entry.success, entry.metadata, entry.ip_address]
        );
      } else {
        const rawDb = db.getDb();
        await rawDb.prepare(
          `INSERT INTO audit_log (event_type, timestamp, user_id, agent_id, action, resource, success, metadata, ip_address)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(entry.event_type, entry.timestamp, entry.user_id, entry.agent_id, entry.action, entry.resource, entry.success, entry.metadata, entry.ip_address);
      }
    } catch (err) {
      log.error('Failed to write audit log to DB', { error: err.message, eventType });
    }
  }

  /**
   * 인증 시도 기록.
   * @param {string} userId
   * @param {string} method - 'jwt' | 'api-key' | 'internal'
   * @param {boolean} success
   * @param {object} metadata - 추가 정보 (IP, user-agent 등)
   */
  async logAuthAttempt(userId, method, success, metadata = {}) {
    await this._log('auth_attempt', {
      userId,
      action: method,
      success,
      metadata: { ...metadata, method },
      ipAddress: metadata.ip || null,
    });
  }

  /**
   * 권한 확인 기록.
   * @param {string} userId
   * @param {string} permission
   * @param {boolean} granted
   * @param {string} resource - 접근 대상 리소스
   */
  async logPermissionCheck(userId, permission, granted, resource = null) {
    await this._log('permission_check', {
      userId,
      action: permission,
      success: granted,
      resource,
    });
  }

  /**
   * 비밀 접근 기록.
   * @param {string} agentId
   * @param {string} secretName
   * @param {string} action - 'read' | 'write' | 'delete' | 'denied'
   */
  async logSecretAccess(agentId, secretName, action) {
    await this._log('secret_access', {
      agentId,
      action,
      resource: secretName,
      success: action !== 'denied',
    });
  }

  /**
   * 신뢰 경계 이벤트 기록.
   * @param {string} from - 발신자 ID
   * @param {string} to - 수신자 ID
   * @param {string} action - 이벤트 유형 (communication, tool_call 등)
   * @param {boolean} allowed
   */
  async logTrustBoundaryEvent(from, to, action, allowed) {
    await this._log('trust_boundary', {
      userId: from,
      agentId: to,
      action,
      success: allowed,
    });
  }
}

// ─── Singleton ───
let _instance = null;

function getAuditLogger() {
  if (!_instance) {
    _instance = new AuditLogger();
  }
  return _instance;
}

module.exports = {
  AuditLogger,
  getAuditLogger,
};
