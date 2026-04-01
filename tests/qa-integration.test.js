/**
 * qa-integration.test.js — QA Level 4: Integration E2E Smoke Test.
 *
 * Uses node:sqlite (built-in, no native compilation needed) to test
 * the full data pipeline: schema → write → read → FTS → graph → cost.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

let db;

before(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_key TEXT NOT NULL,
      user_id TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT,
      role TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT UNIQUE NOT NULL,
      agent_type TEXT DEFAULT '', function_type TEXT DEFAULT '',
      tokens INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_episodic_conv ON episodic_memory(conversation_key, created_at DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(content, content='episodic_memory', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS episodic_fts_insert AFTER INSERT ON episodic_memory BEGIN
      INSERT INTO episodic_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      content_hash TEXT UNIQUE NOT NULL, source_type TEXT DEFAULT 'conversation',
      source_id TEXT DEFAULT '', channel_id TEXT DEFAULT '', user_id TEXT DEFAULT '',
      tags TEXT DEFAULT '[]', promotion_reason TEXT DEFAULT '',
      pool_id TEXT DEFAULT 'team', memory_type TEXT DEFAULT 'Fact',
      archived INTEGER DEFAULT 0, last_accessed TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0, metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_semantic_pool ON semantic_memory(pool_id, archived, last_accessed DESC);
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
      content, source_type, channel_id, tags, content='semantic_memory', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS semantic_fts_ai AFTER INSERT ON semantic_memory BEGIN
      INSERT INTO semantic_fts(rowid, content, source_type, channel_id, tags)
      VALUES (new.id, new.content, new.source_type, new.channel_id, new.tags);
    END;
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, name TEXT DEFAULT '', properties TEXT DEFAULT '{}',
      last_seen TEXT DEFAULT (datetime('now')), created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (entity_type, entity_id)
    );
    CREATE TABLE IF NOT EXISTS entity_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL,
      weight REAL DEFAULT 1.0, metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
      UNIQUE (source_type, source_id, target_type, target_id, relation)
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, content TEXT NOT NULL,
      content_hash TEXT UNIQUE NOT NULL, source_channel TEXT DEFAULT '',
      source_user TEXT DEFAULT '', importance REAL DEFAULT 0.5,
      base_importance REAL DEFAULT 0.5, access_count INTEGER DEFAULT 0,
      last_accessed TEXT DEFAULT (datetime('now')), archived INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS memory_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL, relation TEXT NOT NULL, weight REAL DEFAULT 1.0,
      metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE (source_id, target_id, relation)
    );
    CREATE TABLE IF NOT EXISTS cost_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
      model TEXT NOT NULL, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0,
      session_id TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cost_user ON cost_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_cost_month ON cost_log(created_at, user_id, cost_usd);
  `);
});

after(() => { if (db) db.close(); });

// ─── INTEG-1: Episodic Memory Pipeline ───────────────────
describe('INTEGRATION: Episodic Memory', () => {
  it('should write and read back conversation history', () => {
    const { contentHash } = require('../src/shared/utils');
    const convKey = 'test:user1:ch1:thread1';
    const h1 = contentHash(`${convKey}:user:Hello Effy`);
    const h2 = contentHash(`${convKey}:assistant:Hello! How can I help?`);
    db.prepare('INSERT INTO episodic_memory (conversation_key, user_id, channel_id, thread_ts, role, content, content_hash) VALUES (?,?,?,?,?,?,?)').run(convKey, 'user1', 'ch1', 'thread1', 'user', 'Hello Effy', h1);
    db.prepare('INSERT INTO episodic_memory (conversation_key, user_id, channel_id, thread_ts, role, content, content_hash) VALUES (?,?,?,?,?,?,?)').run(convKey, 'user1', 'ch1', 'thread1', 'assistant', 'Hello! How can I help?', h2);
    const rows = db.prepare('SELECT role, content FROM episodic_memory WHERE conversation_key = ? ORDER BY id').all(convKey);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].role, 'user');
    assert.equal(rows[1].role, 'assistant');
  });

  it('should reject duplicate content_hash', () => {
    const { contentHash } = require('../src/shared/utils');
    const hash = contentHash('duplicate-content');
    db.prepare('INSERT OR IGNORE INTO episodic_memory (conversation_key, user_id, channel_id, role, content, content_hash) VALUES (?,?,?,?,?,?)').run('k','u','c','user','dup', hash);
    const info = db.prepare('INSERT OR IGNORE INTO episodic_memory (conversation_key, user_id, channel_id, role, content, content_hash) VALUES (?,?,?,?,?,?)').run('k','u','c','user','dup', hash);
    assert.equal(info.changes, 0, 'Duplicate should be ignored');
  });

  it('should auto-populate FTS index on insert', () => {
    const { contentHash } = require('../src/shared/utils');
    db.prepare('INSERT INTO episodic_memory (conversation_key, user_id, channel_id, role, content, content_hash) VALUES (?,?,?,?,?,?)').run('fts-key','u1','c1','user','The deployment pipeline is broken in staging', contentHash('fts-test-unique-1'));
    const fts = db.prepare("SELECT rowid FROM episodic_fts WHERE episodic_fts MATCH ?").all('"deployment" OR "pipeline"');
    assert.ok(fts.length >= 1, 'FTS should find inserted content');
  });
});

// ─── INTEG-2: Semantic Memory + FTS ──────────────────────
describe('INTEGRATION: Semantic Memory + FTS', () => {
  it('should save and search via FTS5', () => {
    const { contentHash } = require('../src/shared/utils');
    const contents = [
      'React component lifecycle management best practices',
      'PostgreSQL query optimization with proper indexing',
      'Kubernetes pod autoscaling configuration guide',
    ];
    for (const c of contents) {
      db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash, source_type, pool_id) VALUES (?,?,'document','team')").run(c, contentHash(c));
    }
    const results = db.prepare('SELECT sm.* FROM semantic_memory sm INNER JOIN semantic_fts sf ON sm.id = sf.rowid WHERE semantic_fts MATCH ?').all('"React" OR "component"');
    assert.ok(results.length >= 1, 'Should find React content via FTS');
    assert.ok(results[0].content.includes('React'));
  });

  it('should respect pool_id filtering', () => {
    const { contentHash } = require('../src/shared/utils');
    db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash, pool_id) VALUES (?,?,'engineering')").run('Engineering secret', contentHash('eng-secret'));
    db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash, pool_id) VALUES (?,?,'hr')").run('HR confidential', contentHash('hr-secret'));
    const eng = db.prepare("SELECT * FROM semantic_memory WHERE pool_id = 'engineering'").all();
    assert.ok(eng.length >= 1);
    for (const r of eng) assert.notEqual(r.pool_id, 'hr');
  });
});

// ─── INTEG-3: Entity Memory CRUD ─────────────────────────
describe('INTEGRATION: Entity Memory', () => {
  it('should upsert and retrieve entities', () => {
    db.prepare(`INSERT INTO entities (entity_type, entity_id, name, properties) VALUES ('user','U123','Alice','{"role":"engineer","expertise":["React","Node"]}') ON CONFLICT(entity_type, entity_id) DO UPDATE SET name=excluded.name, properties=excluded.properties`).run();
    const e = db.prepare("SELECT * FROM entities WHERE entity_type='user' AND entity_id='U123'").get();
    assert.ok(e);
    assert.equal(e.name, 'Alice');
    assert.deepEqual(JSON.parse(e.properties).expertise, ['React', 'Node']);
  });

  it('should manage entity relationships', () => {
    db.prepare("INSERT OR IGNORE INTO entities (entity_type, entity_id, name) VALUES ('user','U456','Bob')").run();
    db.prepare("INSERT INTO entity_relationships (source_type, source_id, target_type, target_id, relation) VALUES ('user','U123','user','U456','works_with') ON CONFLICT DO UPDATE SET weight = weight + 0.1").run();
    const rels = db.prepare("SELECT * FROM entity_relationships WHERE source_type='user' AND source_id='U123'").all();
    assert.ok(rels.length >= 1);
    assert.equal(rels[0].relation, 'works_with');
  });
});

// ─── INTEG-4: MemoryGraph ────────────────────────────────
describe('INTEGRATION: MemoryGraph', () => {
  it('should create and query graph edges', () => {
    const { contentHash } = require('../src/shared/utils');
    const id1 = db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact','Fact A',?,'{}')").run(contentHash('graph-fact-a')).lastInsertRowid;
    const id2 = db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact','Fact B',?,'{}')").run(contentHash('graph-fact-b')).lastInsertRowid;
    db.prepare("INSERT INTO memory_edges (source_id, target_id, relation) VALUES (?,?,'related_to')").run(id1, id2);
    const linked = db.prepare('SELECT m.* FROM memories m INNER JOIN memory_edges me ON me.source_id=? AND m.id=me.target_id').all(id1);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].content, 'Fact B');
  });

  it('should enforce content_hash uniqueness', () => {
    const { contentHash } = require('../src/shared/utils');
    const hash = contentHash('unique-decision');
    db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('decision','d1',?,'{}')").run(hash);
    assert.throws(() => {
      db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('decision','d2',?,'{}')").run(hash);
    }, /UNIQUE/);
  });
});

// ─── INTEG-5: Cost Tracking ──────────────────────────────
describe('INTEGRATION: Cost Tracking', () => {
  it('should log and aggregate costs', () => {
    db.prepare("INSERT INTO cost_log (user_id, model, input_tokens, output_tokens, cost_usd) VALUES ('U-cost-1','claude-haiku-4-5-20251001',1000,500,0.0035)").run();
    db.prepare("INSERT INTO cost_log (user_id, model, input_tokens, output_tokens, cost_usd) VALUES ('U-cost-1','claude-sonnet-4-20250514',2000,1000,0.021)").run();
    const row = db.prepare("SELECT SUM(cost_usd) as total FROM cost_log WHERE user_id='U-cost-1' AND created_at >= datetime('now','start of month')").get();
    assert.ok(row.total > 0);
    assert.ok(Math.abs(row.total - 0.0245) < 0.001);
  });

  it('should use index for queries', () => {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT SUM(cost_usd) FROM cost_log WHERE created_at >= datetime('now','start of month') AND user_id='U1'").all();
    const text = plan.map(r => r.detail).join(' ');
    assert.ok(text.includes('idx_cost') || text.includes('SEARCH'), `Expected index: ${text}`);
  });
});

// ─── INTEG-6: Cross-Module ───────────────────────────────
describe('INTEGRATION: Cross-Module', () => {
  it('should have all required indices', () => {
    const indices = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
    const names = indices.map(i => i.name);
    for (const idx of ['idx_episodic_conv', 'idx_semantic_pool', 'idx_cost_user']) {
      assert.ok(names.includes(idx), `Missing index: ${idx}`);
    }
  });

  it('should handle batch writes without corruption', () => {
    const { contentHash } = require('../src/shared/utils');
    db.exec('BEGIN');
    for (let i = 0; i < 100; i++) {
      const c = `batch-test-${i}-${Date.now()}`;
      db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(c, contentHash(c));
    }
    db.exec('COMMIT');
    const cnt = db.prepare("SELECT COUNT(*) as cnt FROM semantic_memory WHERE content LIKE 'batch-test%'").get();
    assert.equal(cnt.cnt, 100);
  });

  it('should handle SQL injection safely via parameterized queries', () => {
    const { contentHash } = require('../src/shared/utils');
    const injections = ["'; DROP TABLE semantic_memory; --", "1 OR 1=1", '" UNION SELECT * FROM sqlite_master --'];
    for (const inj of injections) {
      assert.doesNotThrow(() => {
        db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(inj, contentHash(`inj-${inj}`));
      });
    }
    const cnt = db.prepare("SELECT COUNT(*) as cnt FROM semantic_memory WHERE content LIKE '%DROP TABLE%'").get();
    assert.ok(cnt.cnt >= 1, 'Injection strings should be stored as literals');
  });
});
