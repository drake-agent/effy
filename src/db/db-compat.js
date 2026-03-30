/**
 * db-compat.js — Dual-mode database compatibility layer.
 *
 * Provides a UNIFIED ASYNC API that works identically on both SQLite and PostgreSQL.
 * This is the recommended replacement for direct getDb().prepare() calls.
 *
 * Migration path:
 *   BEFORE (SQLite only):
 *     const { getDb } = require('../db/sqlite');
 *     const db = getDb();
 *     const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
 *
 *   AFTER (works on both SQLite and PostgreSQL):
 *     const { dbGet, dbAll, dbRun, dbExec } = require('../db/db-compat');
 *     const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
 *
 * Dialect translation is automatic — write SQLite-style SQL and it gets
 * translated to PostgreSQL when running on PG.
 *
 * @module db/db-compat
 */
const { getAdapter, isInitialized } = require('./adapter');
const { createLogger } = require('../shared/logger');

const log = createLogger('db:compat');

/**
 * Get a single row.
 * @param {string} sql - SQL query (SQLite dialect OK, auto-translated for PG)
 * @param {Array} params - Query parameters (use ? placeholders)
 * @returns {Promise<Object|null>} - Single row or null
 */
async function dbGet(sql, params = []) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    // Sync path for SQLite (faster, no async overhead)
    try {
      return adapter.db.prepare(sql).get(...params) || null;
    } catch (err) {
      log.error('dbGet error (sqlite)', { sql: sql.slice(0, 100), error: err.message });
      throw err;
    }
  }

  // Async path for PostgreSQL (adapter handles SQL translation)
  return adapter.get(sql, params);
}

/**
 * Get all matching rows.
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array<Object>>} - Array of rows
 */
async function dbAll(sql, params = []) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    try {
      return adapter.db.prepare(sql).all(...params);
    } catch (err) {
      log.error('dbAll error (sqlite)', { sql: sql.slice(0, 100), error: err.message });
      throw err;
    }
  }

  return adapter.all(sql, params);
}

/**
 * Execute a write operation (INSERT, UPDATE, DELETE).
 * @param {string} sql - SQL statement
 * @param {Array} params - Query parameters
 * @returns {Promise<{ changes: number, lastInsertRowid: number|null }>}
 */
async function dbRun(sql, params = []) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    try {
      const result = adapter.db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    } catch (err) {
      log.error('dbRun error (sqlite)', { sql: sql.slice(0, 100), error: err.message });
      throw err;
    }
  }

  return adapter.run(sql, params);
}

/**
 * Execute raw SQL (DDL, multi-statement).
 * @param {string} sql - Raw SQL to execute
 * @returns {Promise<void>}
 */
async function dbExec(sql) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    try {
      adapter.db.exec(sql);
      return;
    } catch (err) {
      log.error('dbExec error (sqlite)', { sql: sql.slice(0, 100), error: err.message });
      throw err;
    }
  }

  return adapter.exec(sql);
}

/**
 * Execute a function within a transaction.
 * The callback receives a transaction proxy with { get, all, run } methods.
 *
 * @param {function} fn - async function(tx) => { await tx.run(...); }
 * @returns {Promise<*>} - Return value of fn
 */
async function dbTransaction(fn) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    // SQLite: use better-sqlite3 transaction wrapper
    const transaction = adapter.db.transaction(() => {
      const tx = {
        get: (sql, params = []) => adapter.db.prepare(sql).get(...params) || null,
        all: (sql, params = []) => adapter.db.prepare(sql).all(...params),
        run: (sql, params = []) => {
          const r = adapter.db.prepare(sql).run(...params);
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
      };
      return fn(tx);
    });
    return transaction();
  }

  // PostgreSQL: delegate to adapter's transaction
  return adapter.transaction(fn);
}

/**
 * Get the current database type.
 * @returns {'sqlite'|'postgres'}
 */
function dbType() {
  _ensureInit();
  return getAdapter().type;
}

/**
 * Check if running on PostgreSQL.
 * Useful for conditional FTS queries (FTS5 vs tsvector).
 * @returns {boolean}
 */
function isPostgres() {
  return isInitialized() && getAdapter().type === 'postgres';
}

/**
 * Full-text search helper.
 * Abstracts FTS5 (SQLite) vs tsvector (PostgreSQL).
 *
 * @param {string} table - Table name (e.g. 'episodic_memory')
 * @param {string} query - Search query
 * @param {Object} options - { limit, offset, columns, where }
 * @returns {Promise<Array<Object>>}
 */
async function dbFullTextSearch(table, query, options = {}) {
  _ensureInit();
  const adapter = getAdapter();
  const limit = options.limit || 20;
  const offset = options.offset || 0;

  // Sanitize query for FTS
  const sanitized = query.replace(/['"(){}[\]<>]/g, ' ').trim();
  if (!sanitized) return [];

  if (adapter.type === 'postgres') {
    // PostgreSQL: use tsvector + plainto_tsquery
    const contentCol = options.tsvectorColumn || 'content_tsv';
    const where = options.where ? `AND ${options.where}` : '';
    const sql = `
      SELECT *, ts_rank(${contentCol}, plainto_tsquery('english', $1)) AS rank
      FROM ${table}
      WHERE ${contentCol} @@ plainto_tsquery('english', $1) ${where}
      ORDER BY rank DESC
      LIMIT $2 OFFSET $3
    `;
    const { rows } = await adapter.pool.query(sql, [sanitized, limit, offset]);
    return rows;
  }

  // SQLite: use FTS5
  const ftsTable = `${table}_fts`;
  const sql = `
    SELECT t.*, fts.rank
    FROM ${ftsTable} fts
    JOIN ${table} t ON t.id = fts.rowid
    WHERE ${ftsTable} MATCH ?
    ORDER BY fts.rank
    LIMIT ? OFFSET ?
  `;
  return adapter.db
    ? adapter.db.prepare(sql).all(sanitized, limit, offset)
    : adapter.all(sql, [sanitized, limit, offset]);
}

function _ensureInit() {
  if (!isInitialized()) {
    throw new Error('[db:compat] Database not initialized. Call initDb() or initAdapter() first.');
  }
}

module.exports = {
  dbGet,
  dbAll,
  dbRun,
  dbExec,
  dbTransaction,
  dbType,
  isPostgres,
  dbFullTextSearch,
};
