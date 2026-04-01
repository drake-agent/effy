/**
 * db/index.js — Unified database entry point (Phase 2 Adapter Pattern).
 *
 * Backward-compatible with existing code:
 *   const { getDb } = require('../db');
 *   const db = getDb();
 *   const row = await db.prepare('SELECT ...').get(param);
 *
 * New adapter API (recommended for new code):
 *   const { dbGet, dbAll, dbRun, dbExec } = require('../db');
 *   const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
 *
 * Configuration:
 *   config.db.isSQLite === true  → SQLite  (better-sqlite3)
 *   config.db.isSQLite === false → PostgreSQL (pg)
 *   Or: DB_TYPE env var, DATABASE_URL env var
 */
const { config } = require('../config');
const { initAdapter, getAdapter, isInitialized, closeAdapter, _setAdapter, translateSQLiteToPostgres, sqliteToPostgresParams } = require('./adapter');
const { createLogger } = require('../shared/logger');

const log = createLogger('db');

// ─── Backward-Compatible Init ─────────────────────────

/**
 * DB 초기화. app.js에서 await init()으로 호출.
 * 기존 config.db 기반 초기화를 v4.0 adapter 시스템으로 라우팅.
 */
async function init() {
  if (config.db.isSQLite) {
    await initAdapter({ type: 'sqlite', sqlitePath: config.db.sqlitePath });
  } else {
    const pgUrl = config.db.postgresUrl || process.env.DATABASE_URL;
    if (pgUrl) {
      const pgConfig = _parsePostgresUrl(pgUrl);
      await initAdapter({ type: 'postgres', ...pgConfig });
    } else {
      await initAdapter({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        database: process.env.DB_NAME || 'effy',
        user: process.env.DB_USER || 'effy',
        password: process.env.DB_PASSWORD || '',
        ssl: process.env.DB_SSL === 'true',
      });
    }
  }
}

/**
 * Backward-compatible getDb().
 *
 * SQLite: returns raw better-sqlite3 instance (sync API).
 * PostgreSQL: returns PgCompat wrapper with prepare().get/all/run() API.
 *
 * 기존 13개 파일이 이 패턴을 사용하므로 backward-compat 유지 필수:
 *   const db = getDb();
 *   await db.prepare('SELECT ...').get(param);
 */
function getDb() {
  if (!isInitialized()) {
    throw new Error('[db] Not initialized. Call init() first.');
  }
  const adapter = getAdapter();
  if (adapter.type === 'sqlite') {
    return adapter.getRawDb();
  }
  // PostgreSQL: wrap adapter with prepare() shim
  return new PgCompat(adapter);
}

/**
 * DB 종료.
 */
async function close() {
  await closeAdapter();
}

// ─── PostgreSQL Backward-Compat Wrapper ───────────────

/**
 * PgCompat — PostgreSQL adapter를 SQLite의 prepare().get/all/run() API와 호환.
 * 기존 코드가 await db.prepare(sql).get(param) 패턴으로 호출하므로
 * 이 wrapper가 async 메서드를 제공하여 await 시 정상 동작.
 */
class PgCompat {
  constructor(adapter) {
    this._adapter = adapter;
  }

  prepare(sql) {
    return new PgStatement(this._adapter, sql);
  }

  async exec(sql) {
    return this._adapter.exec(sql);
  }

  transaction(fn) {
    // better-sqlite3 스타일: db.transaction(() => { ... })() 호출 패턴 지원
    return async () => {
      return this._adapter.transaction(async (tx) => {
        const txDb = {
          prepare: (sql) => new PgTxStatement(tx, sql),
        };
        return fn(txDb);
      });
    };
  }

  pragma() {
    // SQLite pragma — PostgreSQL에서는 no-op
    return undefined;
  }
}

class PgStatement {
  constructor(adapter, sql) {
    this._adapter = adapter;
    this._sql = sql;
  }

  async get(...params) {
    return this._adapter.get(this._sql, params);
  }

  async all(...params) {
    return this._adapter.all(this._sql, params);
  }

  async run(...params) {
    return this._adapter.run(this._sql, params);
  }
}

class PgTxStatement {
  constructor(tx, sql) {
    this._tx = tx;
    this._sql = sql;
  }

  async get(...params) {
    return this._tx.get(this._sql, params);
  }

  async all(...params) {
    return this._tx.all(this._sql, params);
  }

  async run(...params) {
    return this._tx.run(this._sql, params);
  }
}

// ─── FTS Search (backward-compat) ─────────────────────

/**
 * FTS 검색 — SQLite FTS5 / PostgreSQL tsvector 양쪽 호환.
 * 기존 memory/manager.js, memory/search.js에서 사용.
 */
async function ftsSearch(table, query, opts = {}) {
  const { pools, memoryType, limit = 10, archived = 0 } = opts;
  const db = getDb();

  if (config.db.isSQLite) {
    return _ftsSearchSqlite(db, table, query, { pools, memoryType, limit, archived });
  } else {
    return _ftsSearchPostgres(db, table, query, { pools, memoryType, limit, archived });
  }
}

function _ftsSearchSqlite(db, table, query, { pools, memoryType, limit, archived }) {
  const ftsTable = table === 'memories' ? 'memories_fts' :
                   table === 'episodic_memory' ? 'episodic_fts' : 'semantic_fts';

  let sql, params;

  if (table === 'semantic_memory' && pools && pools.length > 0) {
    const placeholders = pools.map(() => '?').join(',');
    if (memoryType) {
      sql = `SELECT sm.*, ABS(rank) AS score FROM ${ftsTable}
             JOIN ${table} sm ON ${ftsTable}.rowid = sm.id
             WHERE ${ftsTable} MATCH ?
               AND sm.archived = ${archived}
               AND sm.pool_id IN (${placeholders})
               AND sm.memory_type = ?
             ORDER BY rank LIMIT ?`;
      params = [query, ...pools, memoryType, limit];
    } else {
      sql = `SELECT sm.*, ABS(rank) AS score FROM ${ftsTable}
             JOIN ${table} sm ON ${ftsTable}.rowid = sm.id
             WHERE ${ftsTable} MATCH ?
               AND sm.archived = ${archived}
               AND sm.pool_id IN (${placeholders})
             ORDER BY rank LIMIT ?`;
      params = [query, ...pools, limit];
    }
  } else {
    sql = `SELECT sm.*, ABS(rank) AS score FROM ${ftsTable}
           JOIN ${table} sm ON ${ftsTable}.rowid = sm.id
           WHERE ${ftsTable} MATCH ?
           ORDER BY rank LIMIT ?`;
    params = [query, limit];
  }

  return db.prepare(sql).all(...params);
}

async function _ftsSearchPostgres(db, table, query, { pools, memoryType, limit, archived }) {
  const tsQuery = query.trim().split(/\s+/).filter(w => w.length > 0).join(' & ');
  if (!tsQuery) return [];

  const params = [];
  let paramIdx = 0;
  const p = () => `$${++paramIdx}`;

  let conditions = [`search_vector @@ to_tsquery('simple', ${p()})`];
  params.push(tsQuery);

  if (table === 'semantic_memory') {
    conditions.push(`archived = ${archived}`);
    if (pools && pools.length > 0) {
      const poolPlaceholders = pools.map(() => p()).join(',');
      conditions.push(`pool_id IN (${poolPlaceholders})`);
      params.push(...pools);
    }
    if (memoryType) {
      conditions.push(`memory_type = ${p()}`);
      params.push(memoryType);
    }
  }

  params.push(limit);
  const sql = `SELECT *, ts_rank(search_vector, to_tsquery('simple', $1)) AS score
               FROM ${table}
               WHERE ${conditions.join(' AND ')}
               ORDER BY score DESC
               LIMIT ${p()}`;

  return await db.prepare(sql).all(...params);
}

// ─── URL Parser ───────────────────────────────────────

function _parsePostgresUrl(url) {
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

// ─── New Dual-Mode Compat (v4.0 API) ─────────────────

const { dbGet, dbAll, dbRun, dbExec, dbTransaction, dbType: getDbType, isPostgres, dbFullTextSearch } = require('./db-compat');

// ─── Exports ──────────────────────────────────────────

module.exports = {
  // Backward-compatible API (works for BOTH SQLite and PostgreSQL)
  init,
  getDb,
  close,
  ftsSearch,

  // New adapter API (v4.0, recommended for new code)
  initDb: init,         // alias for consistency with v4.0 modules
  getAdapter,
  isInitialized,
  closeAdapter,
  initAdapter,

  // Dual-mode compat (v4.0, async, works on both — recommended for Phase 3+ modules)
  dbGet,
  dbAll,
  dbRun,
  dbExec,
  dbTransaction,
  getDbType,
  isPostgres,
  dbFullTextSearch,

  // SQL translation utils
  translateSQLiteToPostgres,
  sqliteToPostgresParams,
};
