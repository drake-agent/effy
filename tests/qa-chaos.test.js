/**
 * qa-chaos.test.js — QA Level 5: Chaos Engineering.
 *
 * Uses node:sqlite (built-in) for fault injection testing.
 * Tests: DB failure, memory pressure, concurrent races,
 * malformed data, timeout, error propagation.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

let db;

before(() => {
  db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      content_hash TEXT UNIQUE NOT NULL, pool_id TEXT DEFAULT 'team',
      source_type TEXT DEFAULT 'conversation', channel_id TEXT DEFAULT '',
      user_id TEXT DEFAULT '', tags TEXT DEFAULT '[]', archived INTEGER DEFAULT 0,
      access_count INTEGER DEFAULT 0, last_accessed TEXT DEFAULT (datetime('now')),
      metadata TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')),
      memory_type TEXT DEFAULT 'Fact', promotion_reason TEXT DEFAULT '',
      source_id TEXT DEFAULT ''
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_fts USING fts5(
      content, source_type, channel_id, tags,
      content='semantic_memory', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS semantic_fts_ai AFTER INSERT ON semantic_memory BEGIN
      INSERT INTO semantic_fts(rowid, content, source_type, channel_id, tags)
      VALUES (new.id, new.content, new.source_type, new.channel_id, new.tags);
    END;
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
  `);
});

after(() => { if (db) db.close(); });

// ─── CHAOS-1: DB Connection Loss ─────────────────────────
describe('CHAOS: DB Connection Loss', () => {
  it('should throw clear error after DB close', () => {
    const tmpDb = new DatabaseSync(':memory:');
    tmpDb.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)');
    tmpDb.prepare('INSERT INTO test VALUES (1, ?)').run('hello');
    tmpDb.close();
    assert.throws(() => tmpDb.prepare('SELECT * FROM test').all(), /database/i);
  });
});

// ─── CHAOS-2: Memory Pressure ────────────────────────────
describe('CHAOS: Memory Pressure', () => {
  it('should handle 10K records without OOM', () => {
    const { contentHash } = require('../src/shared/utils');
    const stmt = db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash, pool_id) VALUES (?,?,'team')");
    db.exec('BEGIN');
    for (let i = 0; i < 10000; i++) {
      const c = `Memory pressure test entry ${i} with filler content`;
      stmt.run(c, contentHash(c));
    }
    db.exec('COMMIT');
    const cnt = db.prepare("SELECT COUNT(*) as cnt FROM semantic_memory WHERE content LIKE 'Memory pressure test%'").get();
    assert.ok(cnt.cnt >= 10000, `Only ${cnt.cnt} records`);
  });

  it('should FTS search 10K records fast', () => {
    const start = Date.now();
    const results = db.prepare('SELECT sm.id FROM semantic_memory sm INNER JOIN semantic_fts sf ON sm.id = sf.rowid WHERE semantic_fts MATCH ? LIMIT 50').all('"Memory" OR "pressure"');
    const elapsed = Date.now() - start;
    assert.ok(results.length > 0, 'Should find results');
    assert.ok(elapsed < 500, `FTS took ${elapsed}ms — too slow`);
  });

  it('should handle 1MB content', () => {
    const { contentHash } = require('../src/shared/utils');
    const big = 'x'.repeat(1_000_000);
    const hash = contentHash(big);
    assert.doesNotThrow(() => {
      db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(big, hash);
    });
    const row = db.prepare('SELECT LENGTH(content) as len FROM semantic_memory WHERE content_hash = ?').get(hash);
    assert.equal(row.len, 1_000_000);
  });
});

// ─── CHAOS-3: Concurrent Transaction Races ───────────────
describe('CHAOS: Transaction Races', () => {
  it('should handle upsert race on memory_edges', () => {
    const { contentHash } = require('../src/shared/utils');
    const id1 = db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact','race-1',?,'{}')").run(contentHash('race-n1')).lastInsertRowid;
    const id2 = db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact','race-2',?,'{}')").run(contentHash('race-n2')).lastInsertRowid;

    const upsert = db.prepare(`
      INSERT INTO memory_edges (source_id, target_id, relation, metadata)
      VALUES (?,?,'related_to','{}')
      ON CONFLICT(source_id, target_id, relation)
      DO UPDATE SET weight = weight + 1, updated_at = datetime('now')
    `);

    const errors = [];
    for (let i = 0; i < 100; i++) {
      try { upsert.run(id1, id2); } catch (e) { errors.push(e.message); }
    }
    assert.equal(errors.length, 0, `Race errors: ${errors.join(', ')}`);

    const edge = db.prepare('SELECT weight FROM memory_edges WHERE source_id=? AND target_id=?').get(id1, id2);
    assert.equal(edge.weight, 100);
  });

  it('should handle mixed FTS+write without deadlock', () => {
    const { contentHash } = require('../src/shared/utils');
    const errors = [];
    db.exec('BEGIN');
    for (let i = 0; i < 50; i++) {
      try {
        const c = `chaos-mixed-${Date.now()}-${i}-${Math.random()}`;
        db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(c, contentHash(c));
        db.prepare("SELECT COUNT(*) FROM semantic_fts WHERE semantic_fts MATCH ?").get('"chaos"');
      } catch (e) { errors.push(e.message); }
    }
    db.exec('COMMIT');
    assert.equal(errors.length, 0, `Mixed ops errors: ${errors.join(', ')}`);
  });
});

// ─── CHAOS-4: Malformed Data ─────────────────────────────
describe('CHAOS: Malformed Data', () => {
  it('should reject NULL in non-nullable fields', () => {
    assert.throws(() => {
      db.prepare("INSERT INTO semantic_memory (content, content_hash) VALUES (NULL, 'h1')").run();
    }, /NOT NULL/);
  });

  it('should handle corrupt JSON in metadata', () => {
    const { contentHash } = require('../src/shared/utils');
    db.prepare("INSERT OR IGNORE INTO memories (type,content,content_hash,metadata) VALUES ('fact','corrupt test',?,'NOT JSON {{{')").run(contentHash('corrupt-j'));
    const row = db.prepare("SELECT metadata FROM memories WHERE content_hash=?").get(contentHash('corrupt-j'));
    assert.ok(row);
    assert.throws(() => JSON.parse(row.metadata));
    let m; try { m = JSON.parse(row.metadata); } catch { m = {}; }
    assert.deepEqual(m, {});
  });

  it('should handle SQL injection via parameterized queries', () => {
    const { contentHash } = require('../src/shared/utils');
    const injections = ["'; DROP TABLE semantic_memory; --", "1 OR 1=1", "\" UNION SELECT sql FROM sqlite_master --"];
    for (const inj of injections) {
      assert.doesNotThrow(() => {
        db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(inj, contentHash(`cinj-${inj}`));
      });
    }
    const cnt = db.prepare("SELECT COUNT(*) as cnt FROM semantic_memory WHERE content LIKE '%DROP TABLE%'").get();
    assert.ok(cnt.cnt >= 1, 'Injection strings stored as literals');
  });

  it('should handle emoji and unicode', () => {
    const { contentHash } = require('../src/shared/utils');
    const inputs = [
      '🎉🚀💯 Deploy!', '日本語テスト 한국어', '\u200B\u200C zero-width', 'RTL: مرحبا',
    ];
    for (const inp of inputs) {
      db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(inp, contentHash(inp));
      const row = db.prepare('SELECT content FROM semantic_memory WHERE content_hash=?').get(contentHash(inp));
      assert.equal(row.content, inp, `Roundtrip failed: ${inp.slice(0, 20)}`);
    }
  });
});

// ─── CHAOS-5: Timeout Simulation ─────────────────────────
describe('CHAOS: Timeout', () => {
  it('should complete 1K inserts under 5s', () => {
    const { contentHash } = require('../src/shared/utils');
    const start = Date.now();
    db.exec('BEGIN');
    for (let i = 0; i < 1000; i++) {
      const c = `timeout-${i}-${Date.now()}`;
      db.prepare("INSERT OR IGNORE INTO semantic_memory (content, content_hash) VALUES (?,?)").run(c, contentHash(c));
    }
    db.exec('COMMIT');
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 5000, `Took ${elapsed}ms`);
  });
});

// ─── CHAOS-6: Error Propagation ──────────────────────────
describe('CHAOS: Error Propagation', () => {
  it('should propagate UNIQUE errors correctly', () => {
    const errors = [];
    for (let i = 0; i < 50; i++) {
      try {
        db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact',?,?,'{}')").run(`err-${i}`, 'DUPE_HASH_CHAOS');
      } catch (e) { errors.push(e.message); }
    }
    assert.equal(errors.length, 49, `Expected 49 errors, got ${errors.length}`);
    assert.ok(errors[0].includes('UNIQUE'));
  });

  it('should rollback failed transaction', () => {
    const { contentHash } = require('../src/shared/utils');
    const before = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt;
    try {
      db.exec('BEGIN');
      db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact','txn-1',?,'{}')").run(contentHash('txn-rb-1'));
      db.prepare("INSERT INTO memories (type,content,content_hash,metadata) VALUES ('fact','txn-2',?,'{}')").run(contentHash('txn-rb-2'));
      throw new Error('Simulated failure');
    } catch {
      db.exec('ROLLBACK');
    }
    const after = db.prepare('SELECT COUNT(*) as cnt FROM memories').get().cnt;
    assert.equal(after, before, 'Transaction should have rolled back');
  });
});
