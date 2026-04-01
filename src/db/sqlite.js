/**
 * sqlite.js — Backward-compatible SQLite database layer.
 *
 * This module now delegates to the adapter system (adapter.js + sqlite-adapter.js)
 * while maintaining the exact same exports: { init, getDb, close, migrate, writeQueue }
 *
 * Existing code that does:
 *   const { getDb } = require('../db/sqlite');
 *   const db = getDb();
 *   db.prepare('SELECT ...').get(...)
 *
 * ... continues to work unchanged.
 *
 * For new code or PostgreSQL support, use:
 *   const { getAdapter } = require('../db');
 *   const row = await getAdapter().get('SELECT ...', [...]);
 */
const { initAdapter, getAdapter, isInitialized, closeAdapter } = require('./adapter');
const { createLogger } = require('../shared/logger');

const log = createLogger('db');

// Local reference for backward compat
let _sqliteAdapter = null;

/**
 * DB 초기화 — WAL 모드, busy_timeout 설정, 스키마 생성.
 * Now delegates to SQLiteAdapter.
 */
function init(dbPath) {
  // Synchronous wrapper: SQLiteAdapter.init() is async but SQLite init is actually sync.
  // We call it synchronously here to maintain backward compat with existing app.js boot.
  const { SQLiteAdapter } = require('./sqlite-adapter');
  _sqliteAdapter = new SQLiteAdapter();

  // SQLiteAdapter.init is async, but all its SQLite operations are sync.
  // We extract the sync core here for backward compat.
  const Database = require('better-sqlite3');
  const path = require('path');
  const fs = require('fs');

  const dir = path.dirname(dbPath);
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`[db] Refusing to create DB in symlinked directory: ${dir}`);
  }
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');
  db.pragma('foreign_keys = ON');

  // Assign the raw db to adapter internals
  _sqliteAdapter.db = db;
  _sqliteAdapter._dbPath = dbPath;

  // Create schema (sync for SQLite)
  _createTables(db);
  _migrate(db);

  // Also register with the adapter system so getAdapter() works
  const { initAdapter: _init } = require('./adapter');
  // We need to set the adapter without going through async init
  // Directly set the module-level adapter
  require('./adapter')._setAdapter(_sqliteAdapter);

  log.info(`SQLite initialized: ${dbPath}`);
  return db;
}

function getDb() {
  if (!_sqliteAdapter || !_sqliteAdapter.db) {
    throw new Error('[db] Not initialized. Call init() first.');
  }
  return _sqliteAdapter.db;
}

function _createTables(db) {
  db.exec(`
    -- 세션 관리
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      channel_id      TEXT,
      thread_ts       TEXT,
      agent_type      TEXT NOT NULL,
      function_type   TEXT DEFAULT '',
      state_json      TEXT,
      last_activity   TEXT NOT NULL DEFAULT (datetime('now')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_activity DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id, last_activity DESC);

    -- L2: Episodic Memory
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_episodic_conv ON episodic_memory(conversation_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_memory(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_episodic_channel ON episodic_memory(channel_id, created_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
      content,
      content='episodic_memory',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS episodic_fts_insert AFTER INSERT ON episodic_memory BEGIN
      INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
    END;

    -- L3: Semantic Memory
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
      last_accessed     TEXT DEFAULT (datetime('now')),
      access_count      INTEGER DEFAULT 0,
      metadata          TEXT DEFAULT '{}',
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_pool ON semantic_memory(pool_id, archived, last_accessed DESC);
    CREATE INDEX IF NOT EXISTS idx_semantic_memory_type ON semantic_memory(memory_type, archived);

    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
      content, source_type, channel_id, tags,
      content='semantic_memory', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS semantic_fts_ai AFTER INSERT ON semantic_memory BEGIN
      INSERT INTO semantic_fts(rowid, content, source_type, channel_id, tags)
      VALUES (new.id, new.content, new.source_type, new.channel_id, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS semantic_fts_ad AFTER DELETE ON semantic_memory BEGIN
      INSERT INTO semantic_fts(semantic_fts, rowid, content, source_type, channel_id, tags)
      VALUES ('delete', old.id, old.content, old.source_type, old.channel_id, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS semantic_fts_au AFTER UPDATE ON semantic_memory BEGIN
      INSERT INTO semantic_fts(semantic_fts, rowid, content, source_type, channel_id, tags)
      VALUES ('delete', old.id, old.content, old.source_type, old.channel_id, old.tags);
      INSERT INTO semantic_fts(rowid, content, source_type, channel_id, tags)
      VALUES (new.id, new.content, new.source_type, new.channel_id, new.tags);
    END;

    -- L4: Entity Memory
    CREATE TABLE IF NOT EXISTS entities (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL,
      entity_id    TEXT NOT NULL,
      name         TEXT DEFAULT '',
      properties   TEXT DEFAULT '{}',
      last_seen    TEXT DEFAULT (datetime('now')),
      created_at   TEXT DEFAULT (datetime('now')),
      UNIQUE (entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS entity_relationships (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type   TEXT NOT NULL,
      source_id     TEXT NOT NULL,
      target_type   TEXT NOT NULL,
      target_id     TEXT NOT NULL,
      relation      TEXT NOT NULL,
      weight        REAL DEFAULT 1.0,
      metadata      TEXT DEFAULT '{}',
      created_at    TEXT DEFAULT (datetime('now')),
      UNIQUE (source_type, source_id, target_type, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_entity_lookup ON entities(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_rel_source ON entity_relationships(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_rel_target ON entity_relationships(target_type, target_id);

    -- 비용 추적
    CREATE TABLE IF NOT EXISTS cost_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd      REAL DEFAULT 0,
      session_id    TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cost_user ON cost_log(user_id, created_at DESC);
    -- PERF-BDG fix: Budget Gate 월별 합산 쿼리 최적화 (full table scan 방지)
    CREATE INDEX IF NOT EXISTS idx_cost_month ON cost_log(created_at, user_id, cost_usd);

    -- GitHub 이벤트
    CREATE TABLE IF NOT EXISTS github_events (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
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
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_github_user ON github_events(user_id, created_at DESC);

    -- GitHub <-> Slack 매핑
    CREATE TABLE IF NOT EXISTS user_mappings (
      slack_user_id  TEXT PRIMARY KEY,
      github_login   TEXT UNIQUE NOT NULL,
      display_name   TEXT DEFAULT ''
    );

    -- 메모리 승격 로그
    CREATE TABLE IF NOT EXISTS memory_promotions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source_layer  TEXT NOT NULL,
      target_layer  TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      reason        TEXT DEFAULT '',
      created_at    TEXT DEFAULT (datetime('now'))
    );

    -- Memory Graph (8 typed nodes)
    CREATE TABLE IF NOT EXISTS memories (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT NOT NULL CHECK(type IN ('fact','preference','decision','identity','event','observation','goal','todo')),
      content         TEXT NOT NULL,
      content_hash    TEXT UNIQUE NOT NULL,
      source_channel  TEXT DEFAULT '',
      source_user     TEXT DEFAULT '',
      importance      REAL DEFAULT 0.5,
      base_importance REAL DEFAULT 0.5,
      access_count    INTEGER DEFAULT 0,
      last_accessed   TEXT DEFAULT (datetime('now')),
      archived        INTEGER DEFAULT 0,
      metadata        TEXT DEFAULT '{}',
      created_at      TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

    -- Memory Edges
    CREATE TABLE IF NOT EXISTS memory_edges (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation    TEXT NOT NULL CHECK(relation IN ('related_to','updates','contradicts','caused_by','part_of')),
      weight      REAL DEFAULT 1.0,
      metadata    TEXT DEFAULT '{}',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, target_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);

    -- FTS5 for Memory Graph
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, type,
      content='memories', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, type) VALUES (new.id, new.content, new.type);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, type) VALUES('delete', old.id, old.content, old.type);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, type) VALUES('delete', old.id, old.content, old.type);
      INSERT INTO memories_fts(rowid, content, type) VALUES (new.id, new.content, new.type);
    END;

    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority    TEXT DEFAULT 'medium',
      status      TEXT DEFAULT 'open',
      assignee    TEXT DEFAULT '',
      due_date    TEXT,
      created_by  TEXT DEFAULT 'system',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

    -- Incidents
    CREATE TABLE IF NOT EXISTS incidents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      title             TEXT NOT NULL,
      description       TEXT DEFAULT '',
      severity          TEXT NOT NULL,
      affected_systems  TEXT DEFAULT '',
      status            TEXT DEFAULT 'open',
      created_by        TEXT DEFAULT 'system',
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity, status);

    -- Cron Jobs
    CREATE TABLE IF NOT EXISTS cron_jobs (
      name        TEXT UNIQUE NOT NULL,
      cron_expr   TEXT NOT NULL,
      task_type   TEXT NOT NULL,
      task_config TEXT DEFAULT '{}',
      enabled     INTEGER DEFAULT 1,
      last_run    TEXT,
      created_at  TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function _migrate(db) {
  // v3.5: memory_type 컬럼 추가
  try {
    const columns = db.prepare('PRAGMA table_info(semantic_memory)').all();
    if (!columns.some(c => c.name === 'memory_type')) {
      db.exec("ALTER TABLE semantic_memory ADD COLUMN memory_type TEXT DEFAULT 'Fact'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_semantic_memory_type ON semantic_memory(memory_type, archived)');
      log.info('Migration: added memory_type column to semantic_memory');
    }
  } catch (err) {
    if (!err.message.includes('duplicate column') && !err.message.includes('no such table')) {
      log.warn('Migration warning (memory_type)', { error: err.message });
    }
  }

  // v3.6.2: tasks.updated_at
  try {
    const taskCols = db.prepare('PRAGMA table_info(tasks)').all();
    if (taskCols.length > 0 && !taskCols.some(c => c.name === 'updated_at')) {
      db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");
      log.info('Migration: added updated_at to tasks');
    }
  } catch (err) {
    if (!err.message.includes('duplicate column')) {
      log.warn('Migration warning (tasks.updated_at)', { error: err.message });
    }
  }

  // v4: memories.base_importance, memories.updated_at
  try {
    const memColumns = db.prepare('PRAGMA table_info(memories)').all();
    if (memColumns.length > 0) {
      if (!memColumns.some(c => c.name === 'base_importance')) {
        db.exec('ALTER TABLE memories ADD COLUMN base_importance REAL DEFAULT 0.5');
        log.info('Migration: added base_importance to memories');
      }
      if (!memColumns.some(c => c.name === 'updated_at')) {
        db.exec("ALTER TABLE memories ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");
        log.info('Migration: added updated_at to memories');
      }
    }
  } catch (err) {
    if (!err.message.includes('duplicate column') && !err.message.includes('no such table')) {
      log.warn('Migration warning (memories)', { error: err.message });
    }
  }
}

function close() {
  if (_sqliteAdapter && _sqliteAdapter.db) {
    _sqliteAdapter.db.close();
    _sqliteAdapter.db = null;
    _sqliteAdapter = null;
  }
}

// BUG-004/STRUCT-003 fix: Delegate to adapter's writeQueue instead of maintaining a separate one.
// This proxy ensures all writes go through a single serialization point.
const writeQueue = {
  enqueue(fn) {
    if (!_sqliteAdapter || !_sqliteAdapter.writeQueue) {
      return Promise.reject(new Error('WriteQueue: DB not initialized'));
    }
    return _sqliteAdapter.writeQueue.enqueue(() => fn(getDb()));
  },
  get metrics() {
    if (!_sqliteAdapter || !_sqliteAdapter.writeQueue) {
      return { depth: 0, totalWrites: 0, totalDropped: 0 };
    }
    return _sqliteAdapter.writeQueue.metrics;
  },
};

module.exports = { init, getDb, close, migrate: () => { if (_sqliteAdapter?.db) _migrate(_sqliteAdapter.db); }, writeQueue };
