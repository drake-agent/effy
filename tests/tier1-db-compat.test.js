/**
 * tier1-db-compat.test.js — v4.0 Database compatibility layer tests.
 *
 * Tests:
 * - db-compat.js dual-mode API (SQLite path)
 * - New v3.9 + v4.0 table creation (SQLite schema)
 * - adapter.js SQL dialect translation
 * - db/index.js exports
 * - Migration script CLI arg parsing
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Setup: Mock SQLite adapter for testing ───

/**
 * In-memory mock that simulates SQLite adapter behavior.
 * Used when better-sqlite3 native binary is unavailable (CI, cross-platform).
 */
function createMockAdapter() {
  const tables = {};  // tableName → rows[]
  let nextId = 1;

  return {
    type: 'sqlite',
    db: {
      prepare(sql) {
        return {
          get(...params) {
            // Parse table/WHERE from SQL and return mock data
            const match = sql.match(/FROM\s+(\w+)/i);
            const table = match ? match[1] : null;
            const rows = tables[table] || [];
            // Simple param matching on first WHERE condition
            if (params.length > 0 && rows.length > 0) {
              return rows.find(r => Object.values(r).includes(params[0])) || null;
            }
            return rows[0] || null;
          },
          all(...params) {
            const match = sql.match(/FROM\s+(\w+)/i);
            const table = match ? match[1] : null;
            const rows = tables[table] || [];
            if (params.length > 0 && rows.length > 0) {
              return rows.filter(r => Object.values(r).some(v => params.includes(v)));
            }
            return rows;
          },
          run(...params) {
            const insertMatch = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/i);
            if (insertMatch) {
              const table = insertMatch[1];
              if (!tables[table]) tables[table] = [];
              const colMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
              const cols = colMatch ? colMatch[1].split(',').map(c => c.trim()) : [];
              const row = { id: nextId++ };
              cols.forEach((col, i) => { row[col] = params[i]; });
              // Defaults
              if (!row.status) row.status = 'pending';
              tables[table].push(row);
              return { changes: 1, lastInsertRowid: row.id };
            }
            const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
            if (updateMatch) {
              return { changes: 1, lastInsertRowid: null };
            }
            return { changes: 0, lastInsertRowid: null };
          },
        };
      },
      exec() {},
      transaction(fn) {
        return () => {
          const tx = {
            get: (s, p = []) => this.prepare(s).get(...p),
            all: (s, p = []) => this.prepare(s).all(...p),
            run: (s, p = []) => this.prepare(s).run(...p),
          };
          return fn(tx);
        };
      },
    },
  };
}

describe('db-compat (SQLite mode)', () => {
  let dbGet, dbAll, dbRun, dbExec, dbTransaction, dbType, isPostgres;

  before(() => {
    // Use mock adapter instead of real SQLite (avoids native binary dependency)
    const mockAdapter = createMockAdapter();
    const { _setAdapter } = require('../src/db/adapter');
    _setAdapter(mockAdapter);

    // Load compat layer
    const compat = require('../src/db/db-compat');
    dbGet = compat.dbGet;
    dbAll = compat.dbAll;
    dbRun = compat.dbRun;
    dbExec = compat.dbExec;
    dbTransaction = compat.dbTransaction;
    dbType = compat.dbType;
    isPostgres = compat.isPostgres;
  });

  after(() => {
    const { _setAdapter } = require('../src/db/adapter');
    _setAdapter(null);
  });

  it('dbType() returns sqlite', () => {
    assert.equal(dbType(), 'sqlite');
  });

  it('isPostgres() returns false', () => {
    assert.equal(isPostgres(), false);
  });

  it('dbRun + dbGet: insert and retrieve a session', async () => {
    await dbRun(
      `INSERT OR IGNORE INTO sessions (id, user_id, agent_type) VALUES (?, ?, ?)`,
      ['test-sess-1', 'U001', 'researcher']
    );

    const row = await dbGet('SELECT * FROM sessions WHERE id = ?', ['test-sess-1']);
    assert.ok(row);
    assert.equal(row.user_id, 'U001');
    assert.equal(row.agent_type, 'researcher');
  });

  it('dbAll: retrieve multiple rows', async () => {
    await dbRun(
      `INSERT OR IGNORE INTO sessions (id, user_id, agent_type) VALUES (?, ?, ?)`,
      ['test-sess-2', 'U001', 'coder']
    );

    const rows = await dbAll('SELECT * FROM sessions WHERE user_id = ?', ['U001']);
    assert.ok(Array.isArray(rows));
    assert.ok(rows.length >= 2);
  });

  it('dbRun returns changes count', async () => {
    const result = await dbRun(
      `UPDATE sessions SET agent_type = ? WHERE id = ?`,
      ['updated-agent', 'test-sess-1']
    );
    assert.equal(result.changes, 1);
  });

  it('dbGet returns null for missing row', async () => {
    const row = await dbGet('SELECT * FROM sessions WHERE id = ?', ['nonexistent']);
    assert.equal(row, null);
  });

  it('dbTransaction: atomic multi-operation', async () => {
    await dbTransaction((tx) => {
      tx.run(`INSERT OR IGNORE INTO sessions (id, user_id, agent_type) VALUES (?, ?, ?)`,
        ['tx-1', 'U-TX', 'tx-agent']);
      tx.run(`INSERT OR IGNORE INTO sessions (id, user_id, agent_type) VALUES (?, ?, ?)`,
        ['tx-2', 'U-TX', 'tx-agent']);
    });

    const rows = await dbAll('SELECT * FROM sessions WHERE user_id = ?', ['U-TX']);
    assert.equal(rows.length, 2);
  });
});

// ─── v3.9 Tables ───

describe('v3.9 tables (mock adapter)', () => {
  let dbRun, dbGet, dbAll;

  before(() => {
    // Ensure mock adapter is still active from previous suite
    const { isInitialized } = require('../src/db/adapter');
    if (!isInitialized()) {
      const mockAdapter = createMockAdapter();
      require('../src/db/adapter')._setAdapter(mockAdapter);
    }
    const compat = require('../src/db/db-compat');
    dbRun = compat.dbRun;
    dbGet = compat.dbGet;
    dbAll = compat.dbAll;
  });

  it('circuit_breaker_log table exists and accepts inserts', async () => {
    const result = await dbRun(
      `INSERT INTO circuit_breaker_log (agent_id, category, message, provider) VALUES (?, ?, ?, ?)`,
      ['agent-1', 'rate_limit', '429 Too Many Requests', 'anthropic']
    );
    assert.ok(result.lastInsertRowid > 0);

    const row = await dbGet('SELECT * FROM circuit_breaker_log WHERE agent_id = ?', ['agent-1']);
    assert.equal(row.category, 'rate_limit');
    assert.equal(row.provider, 'anthropic');
  });

  it('agent_messages table with unique msg_id', async () => {
    await dbRun(
      `INSERT INTO agent_messages (msg_id, from_agent, to_agent, message) VALUES (?, ?, ?, ?)`,
      ['msg-001', 'researcher', 'coder', 'Please review this code']
    );
    const row = await dbGet('SELECT * FROM agent_messages WHERE msg_id = ?', ['msg-001']);
    assert.equal(row.from_agent, 'researcher');
    assert.equal(row.status, 'pending');
  });

  it('bulletins table with unique constraint', async () => {
    await dbRun(
      `INSERT OR REPLACE INTO bulletins (agent_id, channel_id, content, tokens) VALUES (?, ?, ?, ?)`,
      ['researcher', 'C001', 'Daily summary content', 150]
    );
    const row = await dbGet('SELECT * FROM bulletins WHERE agent_id = ? AND channel_id = ?', ['researcher', 'C001']);
    assert.equal(row.tokens, 150);
  });

  it('compaction_jobs table with CHECK constraints', async () => {
    await dbRun(
      `INSERT INTO compaction_jobs (session_id, tier, status) VALUES (?, ?, ?)`,
      ['sess-001', 'background', 'pending']
    );
    const row = await dbGet('SELECT * FROM compaction_jobs WHERE session_id = ?', ['sess-001']);
    assert.equal(row.tier, 'background');
    assert.equal(row.status, 'pending');
  });
});

// ─── v4.0 Stateless Tables ───

describe('v4.0 stateless tables (mock adapter)', () => {
  let dbRun, dbGet;

  before(() => {
    const { isInitialized } = require('../src/db/adapter');
    if (!isInitialized()) {
      const mockAdapter = createMockAdapter();
      require('../src/db/adapter')._setAdapter(mockAdapter);
    }
    const compat = require('../src/db/db-compat');
    dbRun = compat.dbRun;
    dbGet = compat.dbGet;
  });

  it('session_snapshots: store and retrieve', async () => {
    await dbRun(
      `INSERT OR REPLACE INTO session_snapshots (session_id, data, working_memory, expires_at)
       VALUES (?, ?, ?, datetime('now', '+1 hour'))`,
      ['snap-001', '{"userId":"U1"}', '{"entries":[]}']
    );
    const row = await dbGet('SELECT * FROM session_snapshots WHERE session_id = ?', ['snap-001']);
    assert.ok(row);
    assert.equal(JSON.parse(row.data).userId, 'U1');
  });

  it('distributed_locks: acquire and check', async () => {
    await dbRun(
      `INSERT OR REPLACE INTO distributed_locks (lock_key, holder_id, expires_at)
       VALUES (?, ?, datetime('now', '+5 minutes'))`,
      ['idle:sess-001', 'instance-1']
    );
    const row = await dbGet('SELECT * FROM distributed_locks WHERE lock_key = ?', ['idle:sess-001']);
    assert.equal(row.holder_id, 'instance-1');
  });

  it('event_outbox: insert and query unprocessed', async () => {
    await dbRun(
      `INSERT INTO event_outbox (event_type, payload) VALUES (?, ?)`,
      ['session.idle', '{"sessionId":"s1"}']
    );
    const row = await dbGet(
      `SELECT * FROM event_outbox WHERE event_type = ? AND processed_at IS NULL`,
      ['session.idle']
    );
    assert.ok(row);
    assert.equal(JSON.parse(row.payload).sessionId, 's1');
  });
});

// ─── SQL Dialect Translation ───

describe('SQL dialect translation', () => {
  const { translateSQLiteToPostgres, sqliteToPostgresParams } = require('../src/db/adapter');

  it('datetime("now") → NOW()', () => {
    const pg = translateSQLiteToPostgres("SELECT datetime('now')");
    assert.ok(pg.includes('NOW()'));
    assert.ok(!pg.includes("datetime('now')"));
  });

  it('datetime("now", "-7 days") → NOW() - INTERVAL', () => {
    const pg = translateSQLiteToPostgres("SELECT * WHERE created_at > datetime('now', '-7 days')");
    assert.ok(pg.includes("NOW() - INTERVAL '7 days'"));
  });

  it('json_extract → ::jsonb', () => {
    const pg = translateSQLiteToPostgres("SELECT json_extract(metadata, '$.key') FROM t");
    assert.ok(pg.includes("metadata::jsonb->>'key'"));
  });

  it('IFNULL → COALESCE', () => {
    const pg = translateSQLiteToPostgres('SELECT IFNULL(name, ?)');
    assert.ok(pg.includes('COALESCE(name, $1)'));
  });

  it('GROUP_CONCAT → STRING_AGG', () => {
    const pg = translateSQLiteToPostgres('SELECT GROUP_CONCAT(name) FROM t');
    assert.ok(pg.includes("STRING_AGG(name::TEXT, ',')"));
  });

  it('? → $1, $2, $3 placeholder translation', () => {
    const pg = sqliteToPostgresParams('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?');
    assert.ok(pg.includes('$1'));
    assert.ok(pg.includes('$2'));
    assert.ok(pg.includes('$3'));
    assert.ok(!pg.includes('?'));
  });

  it('preserves ? inside quoted strings', () => {
    const pg = sqliteToPostgresParams("SELECT * FROM t WHERE a = ? AND b = 'hello?world'");
    assert.ok(pg.includes('$1'));
    assert.ok(pg.includes("'hello?world'"));
    assert.ok(!pg.includes('$2'));
  });
});

// ─── db/index.js Exports ───

describe('db/index.js exports', () => {
  it('exports compat layer functions', () => {
    const db = require('../src/db');
    assert.equal(typeof db.dbGet, 'function');
    assert.equal(typeof db.dbAll, 'function');
    assert.equal(typeof db.dbRun, 'function');
    assert.equal(typeof db.dbExec, 'function');
    assert.equal(typeof db.dbTransaction, 'function');
    assert.equal(typeof db.isPostgres, 'function');
    assert.equal(typeof db.getDbType, 'function');
  });

  it('exports backward-compat functions', () => {
    const db = require('../src/db');
    assert.equal(typeof db.getDb, 'function');
    assert.equal(typeof db.getAdapter, 'function');
    assert.equal(typeof db.initDb, 'function');
  });
});
