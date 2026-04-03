/**
 * 001_initial_schema.js — Initial PostgreSQL schema for Effy v4.0.
 *
 * Creates all base tables, indexes, and extensions.
 * Extracted from pg-adapter.js createTables().
 */
module.exports = {
  name: '001_initial_schema',

  up: async (client) => {
    await client.query(`
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
      CREATE INDEX IF NOT EXISTS idx_memories_source_user ON memories(source_user);
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
  },

  down: async (client) => {
    // Drop tables in reverse dependency order
    await client.query(`
      DROP TABLE IF EXISTS event_outbox CASCADE;
      DROP TABLE IF EXISTS distributed_locks CASCADE;
      DROP TABLE IF EXISTS session_snapshots CASCADE;
      DROP TABLE IF EXISTS compaction_jobs CASCADE;
      DROP TABLE IF EXISTS bulletins CASCADE;
      DROP TABLE IF EXISTS agent_messages CASCADE;
      DROP TABLE IF EXISTS circuit_breaker_log CASCADE;
      DROP TABLE IF EXISTS cron_jobs CASCADE;
      DROP TABLE IF EXISTS incidents CASCADE;
      DROP TABLE IF EXISTS tasks CASCADE;
      DROP TABLE IF EXISTS memory_edges CASCADE;
      DROP TABLE IF EXISTS memories CASCADE;
      DROP TABLE IF EXISTS memory_promotions CASCADE;
      DROP TABLE IF EXISTS user_mappings CASCADE;
      DROP TABLE IF EXISTS github_events CASCADE;
      DROP TABLE IF EXISTS cost_log CASCADE;
      DROP TABLE IF EXISTS entity_relationships CASCADE;
      DROP TABLE IF EXISTS entities CASCADE;
      DROP TABLE IF EXISTS semantic_memory CASCADE;
      DROP TABLE IF EXISTS episodic_memory CASCADE;
      DROP TABLE IF EXISTS sessions CASCADE;
    `);
  },
};
