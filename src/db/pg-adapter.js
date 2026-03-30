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

    // ARCH2-003 fix: Validate pool configuration
    const poolMin = Math.max(config.pool?.min || 2, 0);
    const poolMax = Math.max(config.pool?.max || 10, 1);
    if (poolMin > poolMax) {
      throw new Error(`Invalid pool config: min (${poolMin}) > max (${poolMax})`);
    }
    const port = parseInt(config.port || '5432', 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port: ${config.port}`);
    }

    this.pool = new Pool({
      host: config.host || 'localhost',
      port,
      database: config.database || 'effy',
      user: config.user || 'effy',
      password: config.password || '',
      ssl: config.ssl || false,
      min: poolMin,
      max: poolMax,
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
    // BUG2-016 fix: Declare client before try so finally can safely check it.
    // BUG2-011 fix: Preserve original error if ROLLBACK also fails.
    let client = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const txProxy = new PostgresTransactionProxy(client, this);
      const result = await fn(txProxy);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          log.error('ROLLBACK failed after transaction error', { error: rollbackErr.message });
          // Preserve the original error, not the rollback error
        }
      }
      throw err;
    } finally {
      if (client) client.release();
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
      // ARCH2-005 fix: Log pool status before closing to detect in-flight queries
      const waitingCount = this.pool.waitingCount || 0;
      if (waitingCount > 0) {
        log.warn(`Closing PostgreSQL pool with ${waitingCount} waiting clients`);
      }
      try {
        await this.pool.end();
      } catch (err) {
        log.error('Error closing PostgreSQL pool', { error: err.message });
      }
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
    const allowedTables = ['episodic_memory', 'semantic_memory', 'memories', 'entities', 'agent_messages'];
    const allowedColumns = ['content', 'source_type', 'channel_id', 'tags', 'type', 'name', 'message'];
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

      -- v3.9: Circuit Breaker Error Log
      CREATE TABLE IF NOT EXISTS circuit_breaker_log (
        id          SERIAL PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        category    TEXT NOT NULL,
        message     TEXT DEFAULT '',
        provider    TEXT DEFAULT 'generic',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_cb_log_agent ON circuit_breaker_log(agent_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cb_log_category ON circuit_breaker_log(category, created_at DESC);

      -- v3.9: Agent Messages (Mailbox persistence)
      CREATE TABLE IF NOT EXISTS agent_messages (
        id          SERIAL PRIMARY KEY,
        msg_id      TEXT UNIQUE NOT NULL,
        from_agent  TEXT NOT NULL,
        to_agent    TEXT NOT NULL,
        message     TEXT NOT NULL,
        context     JSONB DEFAULT '{}',
        status      TEXT DEFAULT 'pending' CHECK(status IN ('pending','delivered','dead_letter')),
        retry_count INTEGER DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        delivered_at TIMESTAMPTZ,
        message_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', message)) STORED
      );
      CREATE INDEX IF NOT EXISTS idx_agent_msg_to ON agent_messages(to_agent, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_from ON agent_messages(from_agent, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_status ON agent_messages(status);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_fts ON agent_messages USING GIN(message_tsv);

      -- v3.9: Bulletins (channel-scoped persistence)
      CREATE TABLE IF NOT EXISTS bulletins (
        id          SERIAL PRIMARY KEY,
        agent_id    TEXT NOT NULL,
        channel_id  TEXT NOT NULL DEFAULT '_global',
        content     TEXT NOT NULL,
        tokens      INTEGER DEFAULT 0,
        generated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(agent_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_bulletins_agent ON bulletins(agent_id, channel_id);

      -- v3.9: Compaction Jobs (background tracking)
      CREATE TABLE IF NOT EXISTS compaction_jobs (
        id            SERIAL PRIMARY KEY,
        session_id    TEXT NOT NULL,
        channel_id    TEXT DEFAULT '',
        tier          TEXT NOT NULL CHECK(tier IN ('background','aggressive','emergency')),
        status        TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
        messages_before INTEGER DEFAULT 0,
        messages_after  INTEGER DEFAULT 0,
        tokens_saved    INTEGER DEFAULT 0,
        error_message   TEXT,
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_compaction_status ON compaction_jobs(status, created_at DESC);

      -- v4.0: Session Snapshots (Redis backup for graceful degradation)
      CREATE TABLE IF NOT EXISTS session_snapshots (
        session_id      TEXT PRIMARY KEY,
        data            JSONB NOT NULL,
        working_memory  JSONB,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_snapshots_expires ON session_snapshots(expires_at);

      -- v4.0: Distributed Locks (PostgreSQL fallback when Redis is unavailable)
      CREATE TABLE IF NOT EXISTS distributed_locks (
        lock_key        TEXT PRIMARY KEY,
        holder_id       TEXT NOT NULL,
        acquired_at     TIMESTAMPTZ DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_distributed_locks_expires ON distributed_locks(expires_at);

      -- v4.0: Event Outbox (reliable cross-instance events without Redis)
      CREATE TABLE IF NOT EXISTS event_outbox (
        id              SERIAL PRIMARY KEY,
        event_type      TEXT NOT NULL,
        payload         JSONB NOT NULL,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        processed_at    TIMESTAMPTZ,
        processor_id    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_event_outbox_unprocessed ON event_outbox(created_at) WHERE processed_at IS NULL;
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

    // v4.0: Stateless architecture tables
    try {
      const { rows } = await this.pool.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'session_snapshots'
      `);
      if (rows.length === 0) {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS session_snapshots (
            session_id TEXT PRIMARY KEY, data JSONB NOT NULL, working_memory JSONB,
            created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_session_snapshots_expires ON session_snapshots(expires_at);
          CREATE TABLE IF NOT EXISTS distributed_locks (
            lock_key TEXT PRIMARY KEY, holder_id TEXT NOT NULL,
            acquired_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_distributed_locks_expires ON distributed_locks(expires_at);
          CREATE TABLE IF NOT EXISTS event_outbox (
            id SERIAL PRIMARY KEY, event_type TEXT NOT NULL, payload JSONB NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(), processed_at TIMESTAMPTZ, processor_id TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_event_outbox_unprocessed ON event_outbox(created_at) WHERE processed_at IS NULL;
        `);
        log.info('Migration: added v4.0 stateless architecture tables');
      }
    } catch (err) {
      log.warn('Migration warning (v4.0 stateless tables)', { error: err.message });
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
