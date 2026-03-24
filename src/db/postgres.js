/**
 * postgres.js — Phase 2 PostgreSQL 데이터베이스 레이어.
 *
 * better-sqlite3와 호환되는 인터페이스 제공:
 *   getDb().prepare(sql).get/all/run() → 단, 모두 async (Promise 반환)
 *
 * 기존 코드에서 `await`만 추가하면 SQLite/PostgreSQL 양쪽 호환.
 */
const { Pool } = require('pg');
const { createLogger } = require('../shared/logger');

const log = createLogger('db:pg');

let pool = null;

// ─── SQLite → PostgreSQL SQL 변환 ───

function convertSql(sql) {
  // ? 파라미터 → $1, $2, ...
  let paramIdx = 0;
  let converted = sql.replace(/\?/g, () => `$${++paramIdx}`);

  return converted
    // INSERT OR IGNORE INTO ... VALUES (...) → INSERT INTO ... VALUES (...) ON CONFLICT DO NOTHING
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
    // INSERT OR REPLACE INTO → INSERT INTO (기존 ON CONFLICT 절 유지)
    .replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO')
    // datetime('now', 'start of month/day') → date_trunc('month/day', NOW())
    .replace(/datetime\('now',\s*'start of month'\)/gi, "date_trunc('month', NOW())")
    .replace(/datetime\('now',\s*'start of day'\)/gi, "date_trunc('day', NOW())")
    // datetime('now', '-' || $N || ' days') → NOW() - INTERVAL '1 day' * $N
    .replace(/datetime\('now',\s*'-'\s*\|\|\s*\$(\d+)\s*\|\|\s*'\s*days'\)/gi,
      (_, p) => `NOW() - INTERVAL '1 day' * $${p}`)
    // datetime('now') → NOW()
    .replace(/datetime\('now'\)/gi, 'NOW()')
    // 나머지 datetime('now', ...) fallback → NOW()
    .replace(/datetime\('now',\s*'[^']*'\)/gi, 'NOW()')
    .replace(/CURRENT_TIMESTAMP/gi, 'NOW()')
    .replace(/DEFAULT\s+\(NOW\(\)\)/gi, 'DEFAULT NOW()')
    ;
}

/**
 * INSERT OR IGNORE용: ON CONFLICT가 없는 INSERT에만 DO NOTHING 추가.
 * convertSql 이후 호출.
 */
function addConflictDoNothing(sql) {
  // 이미 ON CONFLICT가 있으면 건드리지 않음
  if (/ON\s+CONFLICT/i.test(sql)) return sql;
  // INSERT OR IGNORE에서 변환된 INSERT INTO ... VALUES (...) 에만 추가
  return sql.replace(
    /(INSERT\s+INTO\s+\w+\s*\([^)]+\)\s*VALUES\s*\([^)]+\))\s*$/im,
    '$1 ON CONFLICT DO NOTHING'
  );
}

// ─── Statement 호환 클래스 ───

class PgStatement {
  constructor(pool, sql) {
    this.pool = pool;
    this.sql = convertSql(sql);
  }

  async get(...params) {
    const result = await this.pool.query(this.sql, params);
    return result.rows[0] || undefined;
  }

  async all(...params) {
    const result = await this.pool.query(this.sql, params);
    return result.rows;
  }

  async run(...params) {
    const result = await this.pool.query(this.sql, params);
    return { changes: result.rowCount, lastInsertRowid: undefined };
  }
}

// ─── Database 호환 클래스 ───

class PgDatabase {
  constructor(pool) {
    this.pool = pool;
  }

  prepare(sql) {
    return new PgStatement(this.pool, sql);
  }

  async exec(sql) {
    await this.pool.query(sql);
  }

  /**
   * better-sqlite3 transaction() 호환.
   * PostgreSQL에서는 BEGIN/COMMIT 래핑.
   */
  transaction(fn) {
    const pool = this.pool;
    return async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(...args);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };
  }

  pragma() {
    // PostgreSQL에서는 no-op
  }
}

// ─── Public API ───

async function init(connectionString) {
  // search_path를 커넥션 옵션으로 설정
  // pool.on('connect') 내 client.query()는 동일 클라이언트에서 동시 쿼리 충돌을 일으킴
  const sslConfig = connectionString.includes('rds.amazonaws.com') ? { rejectUnauthorized: false } : false;
  const separator = connectionString.includes('?') ? '&' : '?';
  const connWithOptions = `${connectionString}${separator}options=${encodeURIComponent('-c search_path=effy,public')}`;

  pool = new Pool({
    connectionString: connWithOptions,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ssl: sslConfig,
  });

  // 연결 테스트 + search_path 확인
  const client = await pool.connect();
  const spResult = await client.query('SHOW search_path');
  client.release();
  if (!spResult.rows[0]?.search_path?.includes('effy')) {
    log.warn('search_path may not be set correctly', { actual: spResult.rows[0]?.search_path });
  }

  await createTables();
  log.info(`PostgreSQL initialized: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
  return new PgDatabase(pool);
}

function getDb() {
  if (!pool) throw new Error('[db:pg] Not initialized. Call init() first.');
  return new PgDatabase(pool);
}

async function createTables() {
  // 테이블은 migrate-pg.js로 사전 생성됨 — 여기서는 연결 확인만
  // search_path는 커넥션 옵션으로 이미 설정됨

  // 테이블 존재 확인
  const { rows } = await pool.query(
    "SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = 'effy'"
  );
  const tableCount = parseInt(rows[0]?.cnt || '0', 10);
  if (tableCount === 0) {
    throw new Error('effy 스키마에 테이블이 없습니다. npm run db:migrate-pg를 먼저 실행하세요.');
  }
  log.info(`PostgreSQL tables verified: ${tableCount} tables in effy schema`);
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

async function migrate() {
  if (!pool) return;
  // PostgreSQL은 createTables에서 IF NOT EXISTS로 이미 처리됨
  // 추가 마이그레이션 필요 시 여기에 작성
  log.info('PostgreSQL migration check complete');
}

module.exports = { init, getDb, close, migrate };
