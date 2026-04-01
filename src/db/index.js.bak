/**
 * db/index.js — Database 추상화 레이어.
 *
 * config.db.phase === 1 → SQLite (better-sqlite3, 동기)
 * config.db.phase === 2 → PostgreSQL (pg, 비동기)
 *
 * 사용법:
 *   const { getDb } = require('./db');
 *   const db = getDb();
 *   const row = await db.prepare('SELECT ...').get(param);
 *
 * `await`는 SQLite 동기 값에도 무해하므로 양쪽 호환.
 */
const { config } = require('../config');

let backend = null;

function getBackend() {
  if (backend) return backend;
  if (config.db.isSQLite) {
    backend = require('./sqlite');
  } else {
    backend = require('./postgres');
  }
  return backend;
}

/**
 * DB 초기화. PostgreSQL은 async, SQLite는 sync.
 * app.js에서 await init()으로 호출.
 */
async function init() {
  const b = getBackend();
  if (config.db.isSQLite) {
    b.init(config.db.sqlitePath);
    b.migrate();
  } else {
    await b.init(config.db.postgresUrl);
    await b.migrate();
  }
}

function getDb() {
  return getBackend().getDb();
}

async function close() {
  const b = getBackend();
  if (config.db.isSQLite) {
    b.close();
  } else {
    await b.close();
  }
}

/**
 * FTS 검색 — SQLite FTS5 / PostgreSQL tsvector 양쪽 호환.
 *
 * @param {string} table - 'semantic_memory' | 'episodic_memory' | 'memories'
 * @param {string} query - 검색 쿼리 텍스트
 * @param {object} opts - { pools, memoryType, limit, archived }
 * @returns {Promise<Array>} 검색 결과
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
  // PostgreSQL: to_tsquery('simple', 'word1 & word2') 형태로 변환
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

module.exports = { init, getDb, close, ftsSearch };
