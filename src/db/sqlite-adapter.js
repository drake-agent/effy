/**
 * sqlite-adapter.js — SQLite adapter wrapping better-sqlite3.
 * Presents async interface (sync calls wrapped in resolved Promises).
 * Preserves existing WriteQueue for serialized writes.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { createLogger } = require('../shared/logger');

const log = createLogger('db:sqlite');

class WriteQueue {
  constructor() {
    this._queue = [];
    this._processing = false;
    this.maxQueueDepth = 500;
    this.totalWrites = 0;
    this.totalDropped = 0;
  }

  enqueue(fn) {
    if (this._queue.length >= this.maxQueueDepth) {
      this.totalDropped++;
      log.warn(`Backpressure: queue full (${this.maxQueueDepth}). Write dropped. Total dropped: ${this.totalDropped}`);
      return Promise.reject(new Error('WriteQueue backpressure: queue full'));
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._processing) this._drain();
    });
  }

  async _drain() {
    this._processing = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try {
        const result = fn();
        this.totalWrites++;
        resolve(result);
      } catch (err) {
        reject(err);
      }
      if (this._queue.length > 0) {
        await new Promise(r => setImmediate(r));
      }
    }
    this._processing = false;
  }

  get metrics() {
    return { depth: this._queue.length, totalWrites: this.totalWrites, totalDropped: this.totalDropped };
  }
}

class SQLiteAdapter {
  constructor() {
    this.type = 'sqlite';
    this.db = null;
    this.writeQueue = new WriteQueue();
    this._dbPath = null;
  }

  /**
   * Initialize SQLite database.
   * @param {Object} config - { sqlitePath: string }
   */
  async init(config) {
    const dbPath = config.sqlitePath || config.path || './data/effy.db';
    const dir = path.dirname(dbPath);

    if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) {
      throw new Error(`Refusing to create DB in symlinked directory: ${dir}`);
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 15000');
    this.db.pragma('foreign_keys = ON');
    this._dbPath = dbPath;

    await this.createTables();
    await this.migrate();
    log.info(`SQLite initialized: ${dbPath}`);
    return this;
  }

  /**
   * Get a single row. Returns null if not found.
   * @param {string} sql - SQL with ? placeholders
   * @param {Array} [params=[]]
   * @returns {Promise<Object|null>}
   */
  async get(sql, params = []) {
    return this.db.prepare(sql).get(...params) || null;
  }

  /**
   * Get all matching rows.
   * @param {string} sql
   * @param {Array} [params=[]]
   * @returns {Promise<Array>}
   */
  async all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  /**
   * Execute a write operation (INSERT/UPDATE/DELETE).
   * Routed through WriteQueue for serialization.
   * @param {string} sql
   * @param {Array} [params=[]]
   * @returns {Promise<{changes: number, lastInsertRowid: number}>}
   */
  async run(sql, params = []) {
    return this.writeQueue.enqueue(() => {
      const result = this.db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    });
  }

  /**
   * Execute raw SQL (DDL, multi-statement).
   * @param {string} sql
   * @returns {Promise<void>}
   */
  async exec(sql) {
    return this.writeQueue.enqueue(() => {
      this.db.exec(sql);
    });
  }

  /**
   * Execute a function within a transaction.
   * @param {function(SQLiteAdapter): Promise<*>} fn
   * @returns {Promise<*>}
   */
  async transaction(fn) {
    return this.writeQueue.enqueue(async () => {
      const txAdapter = new SQLiteTransactionProxy(this.db);
      this.db.exec('BEGIN');
      try {
        const result = await fn(txAdapter);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    });
  }

  /**
   * Get the raw better-sqlite3 instance (for backward compatibility).
   * WARNING: Direct access bypasses WriteQueue. Use only for reads.
   * @returns {Database}
   */
  getRawDb() {
    if (!this.db) throw new Error('SQLite not initialized');
    return this.db;
  }

  /**
   * Get adapter metrics.
   */
  getMetrics() {
    return {
      type: 'sqlite',
      path: this._dbPath,
      writeQueue: this.writeQueue.metrics,
    };
  }

  /**
   * Close the database.
   */
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      log.info('SQLite connection closed');
    }
  }

  // ─── Schema Creation ───

  async createTables() {
    this.db.exec(`
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

      -- Episodic FTS5
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

      -- Cost tracking
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

      -- GitHub Events
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

      -- GitHub <-> Slack mapping
      CREATE TABLE IF NOT EXISTS user_mappings (
        slack_user_id  TEXT PRIMARY KEY,
        github_login   TEXT UNIQUE NOT NULL,
        display_name   TEXT DEFAULT ''
      );

      -- Memory promotion log
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

  async migrate() {
    if (!this.db) return;

    // v3.5: memory_type column
    try {
      const columns = this.db.prepare('PRAGMA table_info(semantic_memory)').all();
      if (!columns.some(c => c.name === 'memory_type')) {
        this.db.exec("ALTER TABLE semantic_memory ADD COLUMN memory_type TEXT DEFAULT 'Fact'");
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_semantic_memory_type ON semantic_memory(memory_type, archived)');
        log.info('Migration: added memory_type column to semantic_memory');
      }
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('no such table')) {
        log.warn('Migration warning (memory_type)', { error: err.message });
      }
    }

    // v3.6.2: tasks.updated_at
    try {
      const taskCols = this.db.prepare('PRAGMA table_info(tasks)').all();
      if (taskCols.length > 0 && !taskCols.some(c => c.name === 'updated_at')) {
        this.db.exec("ALTER TABLE tasks ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");
        log.info('Migration: added updated_at to tasks');
      }
    } catch (err) {
      if (!err.message.includes('duplicate column')) {
        log.warn('Migration warning (tasks.updated_at)', { error: err.message });
      }
    }

    // v4: memories.base_importance, memories.updated_at
    try {
      const memColumns = this.db.prepare('PRAGMA table_info(memories)').all();
      if (memColumns.length > 0) {
        if (!memColumns.some(c => c.name === 'base_importance')) {
          this.db.exec('ALTER TABLE memories ADD COLUMN base_importance REAL DEFAULT 0.5');
          log.info('Migration: added base_importance to memories');
        }
        if (!memColumns.some(c => c.name === 'updated_at')) {
          this.db.exec("ALTER TABLE memories ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))");
          log.info('Migration: added updated_at to memories');
        }
      }
    } catch (err) {
      if (!err.message.includes('duplicate column') && !err.message.includes('no such table')) {
        log.warn('Migration warning (memories)', { error: err.message });
      }
    }
  }
}

/**
 * Transaction proxy — provides get/all/run within a transaction context.
 * Runs synchronously (no WriteQueue) since the outer transaction already serialized.
 */
class SQLiteTransactionProxy {
  constructor(db) {
    this.db = db;
    this.type = 'sqlite';
  }

  async get(sql, params = []) {
    return this.db.prepare(sql).get(...params) || null;
  }

  async all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  async run(sql, params = []) {
    const result = this.db.prepare(sql).run(...params);
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async exec(sql) {
    this.db.exec(sql);
  }
}

module.exports = { SQLiteAdapter };
