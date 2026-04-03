/**
 * db-compat.js — Database compatibility layer (PostgreSQL).
 *
 * Provides a UNIFIED ASYNC API for database access.
 * This is the recommended replacement for direct getDb().prepare() calls.
 *
 * Usage:
 *     const { dbGet, dbAll, dbRun, dbExec } = require('../db/db-compat');
 *     const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
 *
 * Dialect translation is automatic — write SQL with ? placeholders and it gets
 * translated to PostgreSQL $1, $2, ... style automatically.
 *
 * @module db/db-compat
 */
const { getAdapter, isInitialized } = require('./adapter');
const { createLogger } = require('../shared/logger');

const log = createLogger('db:compat');

/**
 * Get a single row.
 * @param {string} sql - SQL query (? placeholders auto-translated to $1, $2, ...)
 * @param {Array} params - Query parameters (use ? placeholders)
 * @returns {Promise<Object|null>} - Single row or null
 */
async function dbGet(sql, params = []) {
  _ensureInit();
  return getAdapter().get(sql, params);
}

/**
 * Get all matching rows.
 * @param {string} sql - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array<Object>>} - Array of rows
 */
async function dbAll(sql, params = []) {
  _ensureInit();
  return getAdapter().all(sql, params);
}

/**
 * Execute a write operation (INSERT, UPDATE, DELETE).
 * @param {string} sql - SQL statement
 * @param {Array} params - Query parameters
 * @returns {Promise<{ changes: number, lastInsertRowid: number|null }>}
 */
async function dbRun(sql, params = []) {
  _ensureInit();
  return getAdapter().run(sql, params);
}

/**
 * Execute raw SQL (DDL, multi-statement).
 * @param {string} sql - Raw SQL to execute
 * @returns {Promise<void>}
 */
async function dbExec(sql) {
  _ensureInit();
  return getAdapter().exec(sql);
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
  return getAdapter().transaction(fn);
}

/**
 * Get the current database type.
 * @returns {'postgres'}
 */
function dbType() {
  _ensureInit();
  return getAdapter().type;
}

/**
 * Check if running on PostgreSQL. Always true in v4.0+.
 * @returns {boolean}
 */
function isPostgres() {
  return isInitialized();
}

/**
 * Full-text search helper.
 * Uses PostgreSQL tsvector for full-text search.
 *
 * @param {string} table - Table name (e.g. 'episodic_memory')
 * @param {string} query - Search query
 * @param {Object} options - { limit, offset, columns, where }
 * @returns {Promise<Array<Object>>}
 */
// M-07: Whitelist of allowed table names to prevent SQL injection via table interpolation
const ALLOWED_TABLES = [
  'memories', 'memories_fts', 'sessions', 'sessions_fts',
  'decisions', 'decisions_fts', 'lessons', 'lessons_fts',
  'entities', 'entities_fts', 'goals', 'goals_fts',
  'messages', 'messages_fts', 'channels', 'channels_fts',
  'episodic_memory', 'episodic_memory_fts',
  'semantic_memory', 'semantic_memory_fts',
];

async function dbFullTextSearch(table, query, options = {}) {
  _ensureInit();

  // M-07: Validate table name against whitelist
  if (!ALLOWED_TABLES.includes(table) && !ALLOWED_TABLES.includes(`${table}_fts`)) {
    throw new Error(`[db:compat] Table '${table}' is not in the allowed tables whitelist.`);
  }

  const adapter = getAdapter();
  const limit = options.limit || 20;
  const offset = options.offset || 0;

  // Sanitize query for FTS
  const sanitized = query.replace(/['"(){}[\]<>]/g, ' ').trim();
  if (!sanitized) return [];

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
