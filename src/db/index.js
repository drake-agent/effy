/**
 * db/index.js — Unified database entry point.
 *
 * Provides backward-compatible interface for existing code (getDb, writeQueue)
 * AND new adapter-based async interface (getAdapter).
 *
 * Existing code: const { getDb } = require('../db/sqlite');  // still works for SQLite
 * New code:      const { getAdapter } = require('../db');     // works for both
 *
 * Configuration:
 *   - DB_TYPE=sqlite (default) or DB_TYPE=postgres
 *   - For postgres: DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD, DB_SSL
 *   - Or: DATABASE_URL=postgres://user:pass@host:port/dbname
 */
const { initAdapter, getAdapter, isInitialized, closeAdapter } = require('./adapter');
const { createLogger } = require('../shared/logger');

const log = createLogger('db');

/**
 * Initialize database from Effy config object.
 * @param {Object} config - Effy config (config.db section)
 * @returns {Promise<Object>} - The adapter instance
 */
async function initDb(config = {}) {
  const dbType = resolveDbType(config);

  if (dbType === 'postgres') {
    const pgConfig = resolvePostgresConfig(config);
    return initAdapter({ type: 'postgres', ...pgConfig });
  }

  // Default: SQLite
  const sqlitePath = config.sqlitePath || config.db?.sqlitePath || './data/effy.db';
  return initAdapter({ type: 'sqlite', sqlitePath });
}

/**
 * Determine DB type from config and environment.
 */
function resolveDbType(config) {
  // Explicit env var takes precedence
  if (process.env.DB_TYPE) {
    return process.env.DB_TYPE.toLowerCase();
  }
  // Config-based: phase 2 = postgres
  if (config.phase === 2 || config.type === 'postgres') {
    return 'postgres';
  }
  // If DATABASE_URL is set, assume postgres
  if (process.env.DATABASE_URL) {
    return 'postgres';
  }
  return 'sqlite';
}

/**
 * Build PostgreSQL config from env vars or config object.
 */
function resolvePostgresConfig(config) {
  // Parse DATABASE_URL if available
  if (process.env.DATABASE_URL || config.postgresUrl) {
    const url = process.env.DATABASE_URL || config.postgresUrl;
    return parsePostgresUrl(url);
  }

  return {
    host: process.env.DB_HOST || config.host || 'localhost',
    port: parseInt(process.env.DB_PORT || config.port || '5432', 10),
    database: process.env.DB_NAME || config.database || 'effy',
    user: process.env.DB_USER || config.user || 'effy',
    password: process.env.DB_PASSWORD || config.password || '',
    ssl: process.env.DB_SSL === 'true' || config.ssl || false,
    pool: config.pool || { min: 2, max: 10 },
  };
}

/**
 * Parse PostgreSQL connection URL.
 * Format: postgres://user:password@host:port/database?ssl=true
 */
function parsePostgresUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '5432', 10),
      database: (parsed.pathname || '/effy').slice(1),
      user: parsed.username || 'effy',
      password: parsed.password || '',
      ssl: parsed.searchParams.get('ssl') === 'true' ||
           parsed.searchParams.get('sslmode') === 'require',
    };
  } catch (err) {
    log.error('Failed to parse DATABASE_URL', { error: err.message });
    throw new Error(`Invalid DATABASE_URL: ${err.message}`, { cause: err });
  }
}

/**
 * Backward-compatible: get raw SQLite DB instance.
 * ONLY works when DB_TYPE=sqlite. Throws for postgres.
 * Existing modules that call getDb() continue to work unchanged.
 */
function getDb() {
  if (!isInitialized()) {
    throw new Error('[db] Not initialized. Call initDb() first.');
  }
  const adapter = getAdapter();
  if (adapter.type !== 'sqlite') {
    throw new Error(
      '[db] getDb() is only available for SQLite. ' +
      'Use getAdapter() for database-agnostic access. ' +
      'See src/db/adapter.js for the async API.'
    );
  }
  return adapter.getRawDb();
}

/**
 * Backward-compatible: get write queue (SQLite only).
 */
function getWriteQueue() {
  if (!isInitialized()) return null;
  const adapter = getAdapter();
  return adapter.writeQueue || null;
}

// Dual-mode compat layer (works on both SQLite and PostgreSQL)
const { dbGet, dbAll, dbRun, dbExec, dbTransaction, dbType: getDbType, isPostgres, dbFullTextSearch } = require('./db-compat');

module.exports = {
  // New API (recommended)
  initDb,
  getAdapter,
  isInitialized,
  closeAdapter,

  // Dual-mode compat (works on both SQLite and PostgreSQL — recommended for new code)
  dbGet,
  dbAll,
  dbRun,
  dbExec,
  dbTransaction,
  getDbType,
  isPostgres,
  dbFullTextSearch,

  // Backward-compatible API (SQLite only — will throw on PostgreSQL)
  getDb,
  getWriteQueue,

  // Re-export for convenience
  initAdapter,
};
