/**
 * adapter.js — Dual-DB Adapter Interface.
 * Unified async interface for SQLite and PostgreSQL.
 *
 * Usage:
 *   const { initAdapter, getAdapter } = require('./adapter');
 *   await initAdapter(config);       // { type: 'sqlite'|'postgres', ... }
 *   const db = getAdapter();
 *   const row = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
 *   const rows = await db.all('SELECT * FROM sessions WHERE user_id = ?', [uid]);
 *   const result = await db.run('INSERT INTO tasks (title) VALUES (?)', ['test']);
 *   await db.exec('CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY)');
 *   await db.transaction(async (tx) => {
 *     await tx.run('INSERT INTO a VALUES (?)', [1]);
 *     await tx.run('INSERT INTO b VALUES (?)', [2]);
 *   });
 *   await db.close();
 *
 * Config:
 *   { type: 'sqlite', sqlitePath: './data/effy.db' }
 *   { type: 'postgres', host, port, database, user, password, ssl?, pool?: { min, max } }
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('db:adapter');

let _adapter = null;

/**
 * @typedef {Object} QueryResult
 * @property {number} changes - Number of rows affected (INSERT/UPDATE/DELETE)
 * @property {number|string} lastInsertRowid - Last inserted row ID
 */

/**
 * @typedef {Object} DBAdapter
 * @property {string} type - 'sqlite' or 'postgres'
 * @property {function(string, Array?): Promise<Object|null>} get - Single row
 * @property {function(string, Array?): Promise<Array>} all - All matching rows
 * @property {function(string, Array?): Promise<QueryResult>} run - Execute write
 * @property {function(string): Promise<void>} exec - Raw SQL execution
 * @property {function(function): Promise<*>} transaction - Transactional wrapper
 * @property {function(): Promise<void>} close - Close connection
 * @property {function(): Object} getMetrics - Adapter metrics
 * @property {function(string, Array?): string} translateSQL - Translate SQL for target DB
 */

/**
 * Initialize the database adapter based on config.
 * @param {Object} config - { type: 'sqlite'|'postgres', ... }
 * @returns {Promise<DBAdapter>}
 */
async function initAdapter(config) {
  if (_adapter) {
    log.warn('Adapter already initialized. Closing previous instance.');
    await _adapter.close();
  }

  const dbType = (config.type || config.dbType || 'sqlite').toLowerCase();

  if (dbType === 'postgres' || dbType === 'postgresql' || dbType === 'pg') {
    const { PostgresAdapter } = require('./pg-adapter');
    _adapter = new PostgresAdapter();
    await _adapter.init(config);
    log.info('PostgreSQL adapter initialized');
  } else {
    const { SQLiteAdapter } = require('./sqlite-adapter');
    _adapter = new SQLiteAdapter();
    await _adapter.init(config);
    log.info('SQLite adapter initialized');
  }

  return _adapter;
}

/**
 * Get the current adapter instance.
 * @returns {DBAdapter}
 */
function getAdapter() {
  if (!_adapter) throw new Error('[db:adapter] Not initialized. Call initAdapter() first.');
  return _adapter;
}

/**
 * Check if adapter is initialized.
 * @returns {boolean}
 */
function isInitialized() {
  return _adapter !== null;
}

/**
 * Close the current adapter.
 */
async function closeAdapter() {
  if (_adapter) {
    await _adapter.close();
    _adapter = null;
  }
}

/**
 * Translate SQLite-style ? placeholders to PostgreSQL $1, $2, ... style.
 * Handles quoted strings and double-quoted identifiers to avoid replacing
 * question marks inside literals.
 * @param {string} sql
 * @returns {string}
 */
function sqliteToPostgresParams(sql) {
  let idx = 0;
  let result = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (ch === "'" && !inDouble) {
      // SEC2-003 fix: Handle both \' (C-style) and '' (SQL-standard) escapes
      const prev = i > 0 ? sql[i - 1] : '';
      const next = i < sql.length - 1 ? sql[i + 1] : '';
      if (prev === '\\') {
        // Escaped by backslash — not a quote boundary
        result += ch;
        continue;
      }
      if (inSingle && next === "'") {
        // SQL-standard escape '' — skip both quotes, stay in string
        result += "''";
        i++; // skip next quote
        continue;
      }
      inSingle = !inSingle;
      result += ch;
    } else if (ch === '"' && !inSingle) {
      const prev = i > 0 ? sql[i - 1] : '';
      if (prev !== '\\') {
        inDouble = !inDouble;
      }
      result += ch;
    } else if (ch === '?' && !inSingle && !inDouble) {
      idx++;
      result += `$${idx}`;
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * Translate SQLite-specific SQL constructs to PostgreSQL equivalents.
 * @param {string} sql - SQLite SQL
 * @returns {string} - PostgreSQL-compatible SQL
 */
function translateSQLiteToPostgres(sql) {
  let pg = sql;

  // datetime('now') → NOW()
  pg = pg.replace(/datetime\s*\(\s*'now'\s*\)/gi, 'NOW()');

  // datetime('now', '-N days/hours/minutes/seconds') → NOW() - INTERVAL 'N days/...'
  pg = pg.replace(
    /datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi,
    (_, modifier) => {
      // e.g. '-7 days', '+3 hours', '-30 minutes'
      const cleaned = modifier.replace(/^[+-]\s*/, '');
      const sign = modifier.trim().startsWith('-') ? '-' : '+';
      return `NOW() ${sign} INTERVAL '${cleaned}'`;
    }
  );

  // AUTOINCREMENT → GENERATED ALWAYS AS IDENTITY (or just remove for SERIAL)
  // INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
  pg = pg.replace(
    /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi,
    'SERIAL PRIMARY KEY'
  );

  // CURRENT_TIMESTAMP stays the same in PostgreSQL

  // json_extract(col, '$.key') → col::jsonb->>'key'
  // SEC-001 fix: Validate captured groups are safe identifiers (alphanumeric + underscore only)
  pg = pg.replace(
    /json_extract\s*\(\s*(\w+)\s*,\s*'\$\.(\w+)'\s*\)/gi,
    (_, col, key) => {
      if (!/^\w+$/.test(col) || !/^\w+$/.test(key)) {
        throw new Error(`Unsafe identifier in json_extract: col=${col}, key=${key}`);
      }
      return `${col}::jsonb->>'${key}'`;
    }
  );

  // json_extract(col, '$.key.nested') → col::jsonb->'key'->>'nested'
  pg = pg.replace(
    /json_extract\s*\(\s*(\w+)\s*,\s*'\$\.(\w+)\.(\w+)'\s*\)/gi,
    (_, col, key1, key2) => {
      if (!/^\w+$/.test(col) || !/^\w+$/.test(key1) || !/^\w+$/.test(key2)) {
        throw new Error(`Unsafe identifier in json_extract: col=${col}, key1=${key1}, key2=${key2}`);
      }
      return `${col}::jsonb->'${key1}'->>'${key2}'`;
    }
  );

  // IFNULL → COALESCE (PostgreSQL standard)
  pg = pg.replace(/IFNULL\s*\(/gi, 'COALESCE(');

  // GROUP_CONCAT → STRING_AGG
  // SEC-002 fix: Validate identifiers and escape separator
  pg = pg.replace(
    /GROUP_CONCAT\s*\(\s*(\w+)\s*\)/gi,
    (_, col) => {
      if (!/^\w+$/.test(col)) throw new Error(`Unsafe identifier in GROUP_CONCAT: ${col}`);
      return `STRING_AGG(${col}::TEXT, ',')`;
    }
  );
  pg = pg.replace(
    /GROUP_CONCAT\s*\(\s*(\w+)\s*,\s*'([^']+)'\s*\)/gi,
    (_, col, sep) => {
      if (!/^\w+$/.test(col)) throw new Error(`Unsafe identifier in GROUP_CONCAT: ${col}`);
      // Escape single quotes in separator to prevent injection
      const safeSep = sep.replace(/'/g, "''");
      return `STRING_AGG(${col}::TEXT, '${safeSep}')`;
    }
  );

  // GLOB → LIKE (case-sensitive in PG by default)
  // SQLite GLOB uses * and ?, PG LIKE uses % and _
  // This is a rough translation — complex patterns may need manual review
  pg = pg.replace(/\bGLOB\b/gi, 'LIKE');

  // Remove STRICT keyword (SQLite-specific)
  pg = pg.replace(/\)\s*STRICT\s*;/gi, ');');

  // Boolean: SQLite uses 0/1, PG supports TRUE/FALSE but 0/1 also works

  // Remove FTS5 virtual table creation (handled separately)
  // We don't auto-translate FTS5 → tsvector here; that's in schema translation

  // ? placeholders → $1, $2, ...
  pg = sqliteToPostgresParams(pg);

  return pg;
}

/**
 * Internal: Set adapter directly (used by sqlite.js backward-compat bridge).
 * @param {DBAdapter} adapter
 */
function _setAdapter(adapter) {
  _adapter = adapter;
}

module.exports = {
  initAdapter,
  getAdapter,
  isInitialized,
  closeAdapter,
  _setAdapter,
  sqliteToPostgresParams,
  translateSQLiteToPostgres,
};
