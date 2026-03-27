/**
 * pg-adapter.js — PostgreSQL adapter using 'pg' (node-postgres).
 * Async connection pool, tsvector full-text search, JSONB support.
 *
 * Required: npm install pg
 *
 * Config:
 *   {
 *     type: 'postgres',
 *     host: 'localhost',
 *     port: 5432,
 *     database: 'effy',
 *     user: 'effy',
 *     password: 'secret',
 *     ssl: false,           // or { rejectUnauthorized: false }
 *     pool: { min: 2, max: 10 }
 *   }
 */
const { createLogger } = require('../shared/logger');
const { sqliteToPostgresParams, translateSQLiteToPostgres } = require('./adapter');

const log = createLogger('db:postgres');

class PostgresAdapter {
  constructor() {
    this.type = 'postgres';
    this.pool = null;
    this._config = null;
    this._totalQueries = 0;
    this._totalErrors = 0;
  }

  /**
   * Initialize PostgreSQL connection pool and create schema.
   * @param {Object} config
   */
  async init(config) {
    // Lazy require so 'pg' is only needed when using postgres
    const { Pool } = require('pg');

    this._config = config;
    this.pool = new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'effy',
      user: config.user || 'effy',
      password: config.password || '',
      ssl: config.ssl || false,
      min: config.pool?.min || 2,
      max: config.pool?.max || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Test connection
    const client = await this.pool.connect();
    try {
      const result = await client.query('SELECT NOW() as now');
      log.info(`PostgreSQL connected: ${config.host}:${config.port}/${config.database} (server time: ${result.rows[0].now})`);
    } finally {
      client.release();
    }

    await this.createTables();
    await this.migrate();
    return this;
  }

  /**
   * Get a single row. Returns null if not found.
   * Translates ? params to $1, $2, ... automatically.
   * @param {string} sql
   * @param {Array} [params=[]]
   * @returns {Promise<Object|null>}
   */
  async get(sql, params = []) {
    const pgSql = this._translate(sql);
    this._totalQueries++;
    try {
      const result = await this.pool.query(pgSql, params);
      return result.rows[0] || null;
    } catch (err) {
      this._totalErrors++;
      // SEC-006 fix: Don't log full SQL (may leak schema/data in error aggregators)
      log.error('Query error (get)', { error: err.message });
      throw err;
    }
  }

  /**
   * Get all matching rows.
   * @param {string} sql
   * @param {Array} [params=[]]
   * @returns {Promise<Array>}
   */
  async all(sql, params = []) {
    const pgSql = this._translate(sql);
    this._totalQueries++;
    try {
      const result = await this.pool.query(pgSql, params);
      return result.rows;
    } catch (err) {
      this._totalErrors++;
      log.error('Query error (all)', { error: err.message });
      throw err;
    }
  }

  /**
   * Execute a write operation (INSERT/UPDATE/DELETE).
   * @param {string} sql
   * @param {Array} [params=[]]
   * @returns {Promise<{changes: number, lastInsertRowid: number|null}>}
   */
  async run(sql, params = []) {
    let pgSql = this._translate(sql);

    // BUG-003/STRUCT-006 fix: Only add RETURNING for INSERT INTO tables with SERIAL id
    // Tables with TEXT PK (sessions, user_mappings, cron_jobs) don't have auto-increment id
    const isInsert = /^\s*INSERT\b/i.test(pgSql);
    const hasReturning = /\bRETURNING\b/i.test(pgSql);
    if (isInsert && !hasReturning) {
      // Extract target table name to check if it has SERIAL PK
      const tableMatch = pgSql.match(/INSERT\s+INTO\s+(\w+)/i);
      const targetTable = tableMatch ? tableMatch[1].toLowerCase() : '';
      // Tables with TEXT PRIMARY KEY — no auto-increment id to return
      const textPkTables = ['sessions', 'user_mappings', 'cron_jobs'];
      if (!textPkTables.includes(targetTable)) {
        pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
      }
    }

    this._totalQueries++;
    try {
      const result = await this.pool.query(pgSql, params);
      return {
        changes: result.rowCount || 0,
        lastInsertRowid: (isInsert && result.rows?.[0]?.id) ?? null,
      };
    } catch (err) {
      this._totalErrors++;
      log.error('Query error (run)', { error: err.message });
      throw err;
    }
  }

  /**
   * Execute raw SQL (DDL, multi-statement).
   * @param {string} sql
   * @returns {Promise<void>}
   */
  async exec(sql) {
    this._totalQueries++;
    try {
      await this.pool.query(sql);
    } catch (err) {
      this._totalErrors++;
      log.error('Exec error', { error: err.message });
      throw err;
    }
  }

  /**
   * Execute a function within a transaction.
   * @param {function(PostgresTransactionProxy): Promise<*>} fn
   * @returns {Promise<*>}
   */
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txProxy = new PostgresTransactionProxy(client, this);
      const result = await fn(txProxy);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get adapter metrics.
   */
  getMetrics() {
    return {
      type: 'postgres',
      host: this._config?.host,
      database: this._config?.database,
      totalQueries: this._totalQueries,
      totalErrors: this._totalErrors,
      poolTotal: this.pool?.totalCount || 0,
      poolIdle: this.pool?.idleCount || 0,
      poolWaiting: this.pool?.waitingCount || 0,
    };
  }

  /**
   * Close the connection pool.
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      log.info('PostgreSQL pool closed');
    }
  }

  /**
   * Full-text search using tsvector.
   * Replaces SQLite FTS5 MATCH queries.
   * @param {string} table - Target table (e.g. 'episodic_memory')
   * @param {string} column - Column with tsvector index (e.g. 'content')
   * @param {string} query - Search query
   * @param {Object} [opts] - { limit, offset, orderBy }
   * @returns {Promise<Array>}
   */
  async fullTextSearch(table, column, query, opts = {}) {
    const limit = Math.min(opts.limit || 50, 200);
    const offset = opts.offset || 0;
    // SEC-005 fix: Validate against whitelist, not just character removal
    const allowedTables = ['episodic_memory', 'semantic_memory', 'memories', 'entities'];
    const allowedColumns = ['content', 'source_type', 'channel_id', 'tags', 'type', 'name'];
    if (!allowedTables.includes(table)) {
      throw new Error(`Invalid FTS table: ${table}`);
    }
    if (!allowedColumns.includes(column)) {
      throw new Error(`Invalid FTS column: ${column}`);
    }
    const safeTable = table;
    const safeColumn = column;

    const sql = `
      SELECT *, ts_rank(${safeColumn}_tsv, plainto_tsquery('english', $1)) AS rank
      FROM ${safeTable}
      WHERE ${safeColumn}_tsv @@ plainto_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await this.pool.query(sql, [query, limit, offset]);
    return result.rows;
  }

  // ─── Internal ───

  /**
   * Translate SQL from SQLite dialect to PostgreSQL.
   * @param {string} sql
   * @returns {string}
   */
  _translate(sql) {
    return translateSQLiteToPostgres(sql);
  }

  // ─── Schema Creation (PostgreSQL) ───

  async createTables() {
    await this.pool.query(`
      -- Extensions
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      -- Sessions
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        channel_id      TEXT,
        thread_ts       TEXT,
        agent_type      TEXT NOT NULL,
        function_type   TEXT DEFAULT '',
        state_json      TEXT,
        last_activity   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_activity DESC);
      CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel_id, last_activity DESC);

      -- L2: Episodic Memory
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
        metadata          JSONB DEFAULT '{}',
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        content_tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_episodic_conv ON episodic_memory(conversation_key, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodic_user ON episodic_memory(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodic_channel ON episodic_memory(channel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_episodic_fts ON episodic_memory USING GIN(content_tsv);

      -- L3: Semantic Memory
      CREATE TABLE IF NOT EXISTS semantic_memory (
        id                SERIAL PRIMARY KEY,
        content           TEXT NOT NULL,
        content_hash      TEXT UNIQUE NOT NULL,
        source_type       TEXT DEFAULT 'conversation',
        source_id         TEXT DEFAULT '',
        channel_id        TEXT DEFAULT '',
        user_id           TEXT DEFAULT '',
        tags              JSONB DEFAULT '[]',
        promotion_reason  TEXT DEFAULT '',
        pool_id           TEXT DEFAULT 'team',
        memory_type       TEXT DEFAULT 'Fact',
        archived          BOOLEAN DEFAULT FALSE,
        last_accessed     TIMESTAMPTZ DEFAULT NOW(),
        access_count      INTEGER DEFAULT 0,
        metadata          JSONB DEFAULT '{}',
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        content_tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_semantic_pool ON semantic_memory(pool_id, archived, last_accessed DESC);
      CREATE INDEX IF NOT EXISTS idx_semantic_memory_type ON semantic_memory(memory_type, archived);
      CREATE INDEX IF NOT EXISTS idx_semantic_fts ON semantic_memory USING GIN(content_tsv);

      -- L4: Entity Memory
      CREATE TABLE IF NOT EXISTS entities (
        id           SERIAL PRIMARY KEY,
        entity_type  TEXT NOT NULL,
        entity_id    TEXT NOT NULL,
        name         TEXT DEFAULT '',
        properties   JSONB DEFAULT '{}',
        last_seen    TIMESTAMPTZ DEFAULT NOW(),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (entity_type, entity_id)
      );
      CREATE TABLE IF NOT EXISTS entity_relationships (
        id            SERIAL PRIMARY KEY,
        source_type   TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        target_type   TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        relation      TEXT NOT NULL,
        weight        DOUBLE PRECISION DEFAULT 1.0,
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (source_type, source_id, target_type, target_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_lookup ON entities(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS idx_rel_source ON entity_relationships(source_type, source_id);
      CREATE INDEX IF NOT EXISTS idx_rel_target ON entity_relationships(target_type, target_id);

      -- Cost tracking
      CREATE TABLE IF NOT EXISTS cost_log (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        model         TEXT NOT NULL,
        input_tokens  INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cost_usd      DOUBLE PRECISION DEFAULT 0,
        session_id    TEXT DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_cost_user ON cost_log(user_id, created_at DESC);

      -- GitHub Events
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
        created_at    TIMESTAMPTZ DEFAULT NOW()
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
        id            SERIAL PRIMARY KEY,
        source_layer  TEXT NOT NULL,
        target_layer  TEXT NOT NULL,
        content_hash  TEXT NOT NULL,
        reason        TEXT DEFAULT '',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );

      -- Memory Graph (8 typed nodes)
      CREATE TABLE IF NOT EXISTS memories (
        id              SERIAL PRIMARY KEY,
        type            TEXT NOT NULL CHECK(type IN ('fact','preference','decision','identity','event','observation','goal','todo')),
        content         TEXT NOT NULL,
        content_hash    TEXT UNIQUE NOT NULL,
        source_channel  TEXT DEFAULT '',
        source_user     TEXT DEFAULT '',
        importance      DOUBLE PRECISION DEFAULT 0.5,
        base_importance DOUBLE PRECISION DEFAULT 0.5,
        access_count    INTEGER DEFAULT 0,
        last_accessed   TIMESTAMPTZ DEFAULT NOW(),
        archived        BOOLEAN DEFAULT FALSE,
        metadata        JSONB DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        content_tsv     TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
      CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING GIN(content_tsv);

      -- Memory Edges
      CREATE TABLE IF NOT EXISTS memory_edges (
        id          SERIAL PRIMARY KEY,
        source_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id   INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation    TEXT NOT NULL CHECK(relation IN ('related_to','updates','contradicts','caused_by','part_of')),
        weight      DOUBLE PRECISION DEFAULT 1.0,
        metadata    JSONB DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(source_id, target_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(relation);

      -- Tasks
      CREATE TABLE IF NOT EXISTS tasks (
        id          SERIAL PRIMARY KEY,
        title       TEXT NOT NULL,
        description TEXT DEFAULT '',
        priority    TEXT DEFAULT 'medium',
        status      TEXT DEFAULT 'open',
        assignee    TEXT DEFAULT '',
        due_date    TEXT,
        created_by  TEXT DEFAULT 'system',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

      -- Incidents
      CREATE TABLE IF NOT EXISTS incidents (
        id                SERIAL PRIMARY KEY,
        title             TEXT NOT NULL,
        description       TEXT DEFAULT '',
        severity          TEXT NOT NULL,
        affected_systems  TEXT DEFAULT '',
        status            TEXT DEFAULT 'open',
        created_by        TEXT DEFAULT 'system',
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_incidents_severity ON incidents(severity, status);

      -- Cron Jobs
      CREATE TABLE IF NOT EXISTS cron_jobs (
        name        TEXT UNIQUE NOT NULL,
        cron_expr   TEXT NOT NULL,
        task_type   TEXT NOT NULL,
        task_config JSONB DEFAULT '{}',
        enabled     BOOLEAN DEFAULT TRUE,
        last_run    TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    log.info('PostgreSQL schema created');
  }

  async migrate() {
    // PostgreSQL migrations — check and add missing columns
    try {
      // Check if memory_type exists on semantic_memory
      const { rows } = await this.pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'semantic_memory' AND column_name = 'memory_type'
      `);
      if (rows.length === 0) {
        await this.pool.query("ALTER TABLE semantic_memory ADD COLUMN IF NOT EXISTS memory_type TEXT DEFAULT 'Fact'");
        log.info('Migration: added memory_type to semantic_memory');
      }
    } catch (err) {
      log.warn('Migration warning (memory_type)', { error: err.message });
    }

    try {
      const { rows } = await this.pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'memories' AND column_name = 'base_importance'
      `);
      if (rows.length === 0) {
        await this.pool.query('ALTER TABLE memories ADD COLUMN IF NOT EXISTS base_importance DOUBLE PRECISION DEFAULT 0.5');
        log.info('Migration: added base_importance to memories');
      }
    } catch (err) {
      log.warn('Migration warning (base_importance)', { error: err.message });
    }
  }
}

/**
 * Transaction proxy for PostgreSQL.
 * Uses a dedicated client connection (not pool) within BEGIN/COMMIT.
 */
class PostgresTransactionProxy {
  constructor(client, adapter) {
    this.client = client;
    this.adapter = adapter;
    this.type = 'postgres';
  }

  async get(sql, params = []) {
    const pgSql = this.adapter._translate(sql);
    const result = await this.client.query(pgSql, params);
    return result.rows[0] || null;
  }

  async all(sql, params = []) {
    const pgSql = this.adapter._translate(sql);
    const result = await this.client.query(pgSql, params);
    return result.rows;
  }

  async run(sql, params = []) {
    let pgSql = this.adapter._translate(sql);
    const isInsert = /^\s*INSERT\b/i.test(pgSql);
    if (isInsert && !/\bRETURNING\b/i.test(pgSql)) {
      const tableMatch = pgSql.match(/INSERT\s+INTO\s+(\w+)/i);
      const targetTable = tableMatch ? tableMatch[1].toLowerCase() : '';
      const textPkTables = ['sessions', 'user_mappings', 'cron_jobs'];
      if (!textPkTables.includes(targetTable)) {
        pgSql = pgSql.replace(/;?\s*$/, ' RETURNING id');
      }
    }
    const result = await this.client.query(pgSql, params);
    return {
      changes: result.rowCount || 0,
      lastInsertRowid: (isInsert && result.rows?.[0]?.id) ?? null,
    };
  }

  async exec(sql) {
    await this.client.query(sql);
  }
}

module.exports = { PostgresAdapter };
