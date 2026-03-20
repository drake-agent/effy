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
    // INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    .replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
    .replace(/(INSERT\s+INTO\s+\w+\s*\([^)]+\)\s*VALUES\s*\([^)]+\))(?!\s*ON\s+CONFLICT)/gi,
      (match) => `${match} ON CONFLICT DO NOTHING`)
    // INSERT OR REPLACE → UPSERT
    .replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, 'INSERT INTO')
    // datetime('now') → NOW()
    .replace(/datetime\('now'\)/gi, 'NOW()')
    .replace(/CURRENT_TIMESTAMP/gi, 'NOW()')
    // DEFAULT (NOW()) → DEFAULT NOW()
    .replace(/DEFAULT\s+\(NOW\(\)\)/gi, 'DEFAULT NOW()')
    ;
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

  pragma() {
    // PostgreSQL에서는 no-op
  }
}

// ─── Public API ───

async function init(connectionString) {
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // 모든 새 연결에 search_path 설정
  pool.on('connect', (client) => {
    client.query('SET search_path TO effy, public');
  });

  // 연결 테스트
  const client = await pool.connect();
  await client.query('SET search_path TO effy, public');
  client.release();

  await createTables();
  log.info(`PostgreSQL initialized: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
  return new PgDatabase(pool);
}

function getDb() {
  if (!pool) throw new Error('[db:pg] Not initialized. Call init() first.');
  return new PgDatabase(pool);
}

async function createTables() {
  // effy 전용 스키마 생성
  await pool.query(`CREATE SCHEMA IF NOT EXISTS effy`);
  await pool.query(`SET search_path TO effy, public`);

  await pool.query(`
    -- ─── 세션 관리 ───
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      channel_id      TEXT,
      thread_ts       TEXT,
      agent_type      TEXT NOT NULL,
      function_type   TEXT DEFAULT '',
      state_json      TEXT,
      last_activity   TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at      TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id, last_activity DESC);

    -- ─── L2: Episodic Memory ───
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id                SERIAL PRIMARY KEY,
      conversation_key  TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      channel_id        TEXT NOT NULL,
      thread_ts         TEXT,
      role              TEXT NOT NULL,
      content           TEXT NOT NULL,
      content_hash      TEXT UNIQUE NOT NULL,
      agent_type        TEXT DEFAULT '',
      function_type     TEXT DEFAULT '',
      tokens            INTEGER DEFAULT 0,
      metadata          TEXT DEFAULT '{}',
      created_at        TIMESTAMP DEFAULT NOW(),
      search_vector     TSVECTOR
    );
    CREATE INDEX IF NOT EXISTS idx_episodic_conv ON episodic_memory(conversation_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_memory(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_channel ON episodic_memory(channel_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_fts ON episodic_memory USING GIN(search_vector);

    -- ─── L3: Semantic Memory ───
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id                SERIAL PRIMARY KEY,
      content           TEXT NOT NULL,
      content_hash      TEXT UNIQUE NOT NULL,
      source_type       TEXT DEFAULT 'conversation',
      source_id         TEXT DEFAULT '',
      channel_id        TEXT DEFAULT '',
      user_id           TEXT DEFAULT '',
      tags              TEXT DEFAULT '[]',
      promotion_reason  TEXT DEFAULT '',
      pool_id           TEXT DEFAULT 'team',
      memory_type       TEXT DEFAULT 'Fact',
      archived          INTEGER DEFAULT 0,
      last_accessed     TIMESTAMP DEFAULT NOW(),
      access_count      INTEGER DEFAULT 0,
      metadata          TEXT DEFAULT '{}',
      created_at        TIMESTAMP DEFAULT NOW(),
      search_vector     TSVECTOR
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_pool ON semantic_memory(pool_id, archived, last_accessed DESC);
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_type ON semantic_memory(memory_type, archived);
    CREATE INDEX IF NOT EXISTS idx_semantic_fts ON semantic_memory USING GIN(search_vector);

    -- ─── L4: Entity Memory ───
    CREATE TABLE IF NOT EXISTS entities (
      id           SERIAL PRIMARY KEY,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      name         TEXT DEFAULT '',
      properties   TEXT DEFAULT '{}',
      last_seen    TIMESTAMP DEFAULT NOW(),
      created_at   TIMESTAMP DEFAULT NOW(),
      UNIQUE (entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS entity_relationships (
      id            SERIAL PRIMARY KEY,
      source_type   TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      target_type   TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      relation      TEXT NOT NULL,
      weight        REAL DEFAULT 1.0,
      metadata      TEXT DEFAULT '{}',
      created_at    TIMESTAMP DEFAULT NOW(),
      UNIQUE (source_type, source_id, target_type, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_lookup ON entities(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_rel_source ON entity_relationships(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON entity_relationships(target_type, target_id);

    -- ─── 비용 추적 ───
    CREATE TABLE IF NOT EXISTS cost_log (
      id            SERIAL PRIMARY KEY,
      user_id       TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd      REAL DEFAULT 0,
      session_id    TEXT DEFAULT '',
      created_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_cost_user ON cost_log(user_id, created_at DESC);

    -- ─── GitHub 이벤트 ───
    CREATE TABLE IF NOT EXISTS github_events (
      id            SERIAL PRIMARY KEY,
      event_type    TEXT NOT NULL,
      repo          TEXT NOT NULL,
      user_id       TEXT,
      github_login  TEXT NOT NULL,
      pr_number     INTEGER,
      pr_title      TEXT,
      pr_summary    TEXT,
      additions     INTEGER DEFAULT 0,
      deletions     INTEGER DEFAULT 0,
      files_changed INTEGER DEFAULT 0,
      created_at    TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_github_user ON github_events(user_id, created_at DESC);

    -- ─── GitHub ↔ Slack 매핑 ───
    CREATE TABLE IF NOT EXISTS user_mappings (
      slack_user_id  TEXT PRIMARY KEY,
      github_login   TEXT UNIQUE NOT NULL,
      display_name   TEXT DEFAULT ''
    );

    -- ─── 메모리 승격 로그 ───
    CREATE TABLE IF NOT EXISTS memory_promotions (
      id            SERIAL PRIMARY KEY,
      source_layer  TEXT NOT NULL,
      target_layer  TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      reason        TEXT DEFAULT '',
      created_at    TIMESTAMP DEFAULT NOW()
    );

    -- ─── v4 Port: Memory Graph ───
    CREATE TABLE IF NOT EXISTS memories (
      id              SERIAL PRIMARY KEY,
      type            TEXT NOT NULL CHECK(type IN ('fact','preference','decision','identity','event','observation','goal','todo')),
      content         TEXT NOT NULL,
      content_hash    TEXT UNIQUE NOT NULL,
      source_channel  TEXT DEFAULT '',
      source_user     TEXT DEFAULT '',
      importance      REAL DEFAULT 0.5,
      base_importance REAL DEFAULT 0.5,
      access_count    INTEGER DEFAULT 0,
      last_accessed   TIMESTAMP DEFAULT NOW(),
      archived        INTEGER DEFAULT 0,
      metadata        TEXT DEFAULT '{}',
      created_at      TIMESTAMP DEFAULT NOW(),
      updated_at      TIMESTAMP DEFAULT NOW(),
      search_vector   TSVECTOR
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
    CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING GIN(search_vector);

    -- v4 Port: Memory Edges
    CREATE TABLE IF NOT EXISTS memory_edges (
      id          SERIAL PRIMARY KEY,
      source_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation    TEXT NOT NULL CHECK(relation IN ('related_to','updates','contradicts','caused_by','part_of')),
      weight      REAL DEFAULT 1.0,
      metadata    TEXT DEFAULT '{}',
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW(),
      UNIQUE(source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id);

    -- ─── Tasks ───
    CREATE TABLE IF NOT EXISTS tasks (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority    TEXT DEFAULT 'medium',
      status      TEXT DEFAULT 'open',
      assignee    TEXT DEFAULT '',
      due_date    TEXT,
      created_by  TEXT DEFAULT 'system',
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);

    -- ─── Incidents ───
    CREATE TABLE IF NOT EXISTS incidents (
      id                SERIAL PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT DEFAULT '',
      severity          TEXT NOT NULL,
      affected_systems  TEXT DEFAULT '',
      status            TEXT DEFAULT 'open',
      created_by        TEXT DEFAULT 'system',
      created_at        TIMESTAMP DEFAULT NOW()
    );

    -- ─── Cron Jobs ───
    CREATE TABLE IF NOT EXISTS cron_jobs (
      name        TEXT UNIQUE NOT NULL,
      cron_expr   TEXT NOT NULL,
      task_type   TEXT NOT NULL,
      task_config TEXT DEFAULT '{}',
      enabled     INTEGER DEFAULT 1,
      last_run    TIMESTAMP,
      created_at  TIMESTAMP DEFAULT NOW()
    );
  `);

  // ─── FTS 자동 업데이트 트리거 (PostgreSQL) ───
  await pool.query(`
    CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector('simple', COALESCE(NEW.content, ''));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_episodic_fts') THEN
        CREATE TRIGGER trg_episodic_fts BEFORE INSERT OR UPDATE ON episodic_memory
        FOR EACH ROW EXECUTE FUNCTION update_search_vector();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_semantic_fts') THEN
        CREATE TRIGGER trg_semantic_fts BEFORE INSERT OR UPDATE ON semantic_memory
        FOR EACH ROW EXECUTE FUNCTION update_search_vector();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_memories_fts') THEN
        CREATE TRIGGER trg_memories_fts BEFORE INSERT OR UPDATE ON memories
        FOR EACH ROW EXECUTE FUNCTION update_search_vector();
      END IF;
    END $$;
  `);

  log.info('PostgreSQL tables and triggers created');
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
