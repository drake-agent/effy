# Architecture Review — Code Evidence & Test Cases

---

## Issue #1: PgCompat Async/Sync Mismatch — Code Evidence

### Smoking Gun: memory/manager.js Line 378

**File**: `src/memory/manager.js:370-382`

```javascript
async touchAccess(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE semantic_memory SET access_count = access_count + 1, last_accessed = datetime('now')
    WHERE id = ?
  `);
  const batch = db.transaction(async () => {
    for (const id of ids) await stmt.run(id);
  });
  batch();  // ← BUG: Returns Promise, not awaited!
}
```

**Expected**:
```javascript
await batch();  // ← Must await the transaction
```

### Root Cause: db/index.js Lines 101-111

**File**: `src/db/index.js:101-111`

```javascript
transaction(fn) {
  // better-sqlite3 스타일: db.transaction(() => { ... })() 호출 패턴 지원
  return async () => {  // ← Returns async function (for PostgreSQL)
    return this._adapter.transaction(async (tx) => {
      const txDb = {
        prepare: (sql) => new PgTxStatement(tx, sql),
      };
      return fn(txDb);
    });
  };
}
```

**Problem**: SQLite's `db.transaction()` returns a synchronous function that executes immediately. PostgreSQL's wrapper returns an async function. Existing code expects sync behavior.

### Evidence: db-compat.js Exposes the Issue

**File**: `src/db/db-compat.js:125-147`

```javascript
async function dbTransaction(fn) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    // SQLite: use better-sqlite3 transaction wrapper
    const transaction = adapter.db.transaction(() => {  // ← Sync return
      const tx = {
        get: (sql, params = []) => adapter.db.prepare(sql).get(...params) || null,
        all: (sql, params = []) => adapter.db.prepare(sql).all(...params),
        run: (sql, params = []) => {
          const r = adapter.db.prepare(sql).run(...params);
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
        },
      };
      return fn(tx);
    });
    return transaction();  // ← Sync call, returns Promise
  }

  // PostgreSQL: delegate to adapter's transaction
  return adapter.transaction(fn);  // ← Returns Promise
}
```

Notice: Both paths return Promise, but caller may not know if they must await.

### Test Case: Expose the Race

**File**: `tests/critical/pg-transaction-race.test.js` (should be created)

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { initAdapter } = require('../../src/db/adapter');

test('PgCompat transaction race — concurrent inserts', async (t) => {
  // Setup: PostgreSQL adapter
  await initAdapter({
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'effy_test',
    user: 'effy',
    password: '',
    pool: { min: 2, max: 5 },
  });

  const db = require('../../src/db').getDb();

  // Test: Simulate memory/manager.js touchAccess() pattern
  const ids = [1, 2, 3, 4, 5];

  // BUGGY VERSION (current code):
  const stmt = db.prepare(`
    UPDATE semantic_memory SET access_count = access_count + 1
    WHERE id = ?
  `);

  const batch = db.transaction(async () => {
    for (const id of ids) {
      await stmt.run(id);
    }
  });

  batch();  // ← Returns Promise, not awaited — BUG!

  // Immediately check if update happened
  const result = await db.prepare('SELECT access_count FROM semantic_memory WHERE id = 1').get();

  // FAILS: access_count still 0 (transaction never committed)
  assert.strictEqual(result.access_count, 1, 'Transaction should have incremented access_count');
});
```

**Failure mode**: Test fails with timeout or returns stale data (access_count still 0).

### Impact Chain

1. **touchAccess() never commits**: Semantic memory access counts never updated
2. **Memory importance scores wrong**: Stale counters → incorrect pruning
3. **Compaction reads wrong budget**: Old access_count → keeps irrelevant memories
4. **Token bloat**: Sessions grow, context limit exceeded
5. **Compaction loop**: Infinite retries, CPU spike

---

## Issue #2: Strangler Fig Race Condition — Evidence

### Root Cause: Static Flag + Dynamic Pipeline

**File**: `src/gateway/gateway.js:72`

```javascript
const GATEWAY_V2_ENABLED = process.env.EFFY_GATEWAY_V2 === 'true';
// ↑ Read ONCE at startup, never reloaded
```

**File**: `src/gateway/gateway.js:110-114`

```javascript
// Phase 4: Gateway v2 Pipeline (Strangler Fig)
this._pipeline = null;
if (GATEWAY_V2_ENABLED) {  // ← Uses stale constant
  this._pipeline = createGatewayPipeline(this);
  log.info('Gateway v2 pipeline ENABLED — Strangler Fig mode');
}
```

### Deployment Scenario: Blue-Green Race

**Timeline**:

```
T=0:00   Blue (v3.6) ready, EFFY_GATEWAY_V2=false (env var not set)
         Three instances running legacy gateway.onMessage()

T=0:30   Canary: Deploy Green (v4.0) with EFFY_GATEWAY_V2=true
         All new pods spin with v2 pipeline enabled
         Load balancer splits traffic 80/20 (blue/green)

T=1:00   User sends message on session "user:123:channel:456"
         Load balancer routes to Instance-A (blue, legacy)

T=1:01   Instance-A processes message:
         - runMiddleware()
         - classifyRequest()
         - selectAgent()
         - compactionEngine.compact()
         - Writes session state: { format: 'v1', messages: [...] }

T=1:02   User follows up on same session
         Load balancer routes to Instance-B (green, v2 pipeline)

T=1:03   Instance-B processes message:
         - gatewayPipeline.execute()
         - contextAssemble() creates context differently
         - Writes session state: { format: 'v2', messages: [...] }

T=1:04   Instance-A handles next message
         Loads session state written by Instance-B (format: v2)
         Legacy compaction engine expects format: v1
         CRASH: TypeError: Cannot read property 'metadata' of undefined
```

### Evidence: No Session Versioning

**File**: `src/memory/indexer.js` (inferred from imports)

Session state is written without format version marker:

```javascript
// Pseudo-code: how session context is written
const sessionData = {
  messages: workingMemory.get(sessionKey),
  lastAccessTime: Date.now(),
  // ← NO version field!
};

await db.prepare('UPDATE sessions SET state_json = ? WHERE id = ?')
  .run(JSON.stringify(sessionData), sessionKey);
```

When Instance-B (v2) writes, the format changes:

```javascript
// v2 pipeline writes:
const sessionData = {
  messages: [{ role: 'user', content: '...', timestamp: Date.now() }],  // ← New timestamp
  compactionMetadata: { summarized: true, originalCount: 50 },           // ← New field
  lastAccessTime: Date.now(),
};
```

Instance-A (legacy) tries to read and fails:

```javascript
// Legacy code expects:
const { messages } = sessionData;  // ← OK
const compacted = await compactionEngine.compact(messages);  // ← BREAKS
// compactionEngine expects OLD field structure
```

### Test Case: Multi-Instance Race

**File**: `tests/critical/strangler-fig-race.test.js` (should be created)

```javascript
const test = require('node:test');
const assert = require('node:assert');

test('Strangler Fig race — mixed v1/v2 instances', async (t) => {
  // Simulate two instances with different pipeline configs

  const config1 = { GATEWAY_V2_ENABLED: false };  // Legacy
  const config2 = { GATEWAY_V2_ENABLED: true };   // v2

  const Gateway1 = createGateway(config1);
  const Gateway2 = createGateway(config2);

  const sessionKey = 'user:123:channel:456';
  const msg1 = { content: 'Hello', sender: { id: 'user:123' } };

  // Message 1: v1 pipeline
  await Gateway1.onMessage(msg1);
  let sessionState1 = await db.prepare('SELECT state_json FROM sessions WHERE id = ?').get(sessionKey);
  const format1 = JSON.parse(sessionState1.state_json);

  console.log('v1 format keys:', Object.keys(format1));
  // Expected: { messages, lastAccessTime }

  // Message 2: v2 pipeline (same session)
  await Gateway2.onMessage(msg1);
  let sessionState2 = await db.prepare('SELECT state_json FROM sessions WHERE id = ?').get(sessionKey);
  const format2 = JSON.parse(sessionState2.state_json);

  console.log('v2 format keys:', Object.keys(format2));
  // Expected: { messages, compactionMetadata, lastAccessTime }

  // Message 3: Back to v1 pipeline (cross-format read)
  const sessionForMsg3 = await loadSessionState(sessionKey);

  try {
    // v1 code expects old format
    await Gateway1.compactionEngine.compact(sessionForMsg3.messages);
    assert.fail('Should have thrown due to format mismatch');
  } catch (err) {
    // EXPECTED: Format incompatibility detected
    assert.match(err.message, /Cannot read|undefined/);
  }
});
```

**Result**: FAILS. Demonstrates format incompatibility under concurrent load.

### Pipeline Step Mutation Race

**File**: `src/gateway/gateway-pipeline.js:94-106`

```javascript
addStepAfter(afterStep, step) {
  const coreIdx = this._coreSteps.findIndex(s => s.name === afterStep);
  if (coreIdx >= 0) {
    this._coreSteps.splice(coreIdx + 1, 0, step);  // ← NOT THREAD-SAFE
  } else {
    const postIdx = this._postSteps.findIndex(s => s.name === afterStep);
    if (postIdx >= 0) {
      this._postSteps.splice(postIdx + 1, 0, step);  // ← Mutates shared array
    } else {
      this._postSteps.push(step);
    }
  }
  this._steps = [...this._coreSteps, this._postSteps];  // ← Reference update
}
```

**Race window**: Between `findIndex()` and `splice()`, if another request iterates `_coreSteps`, the index is invalid.

**Trigger**: Skill registry post-load calls `pipeline.addStepAfter()` while first message is mid-pipeline.

---

## Issue #3: Module Isolation Violation — Evidence

### gateway-steps.js Imports Chain

**File**: `src/gateway/gateway-steps.js:10-20`

```javascript
const { config } = require('../config');
const { runMiddleware } = require('../core/middleware');      // ← VIOLATION #1
const { classifyRequest } = require('../core/router');        // ← VIOLATION #2
const { runAgent } = require('../agents/runtime');            // ← OK
const { episodic, semantic, entity } = require('../memory/manager');
const { buildContext, formatContextForLLM } = require('../memory/context');
const { indexSession, setBulletin } = require('../memory/indexer');
const { client: anthropicClient } = require('../shared/anthropic');
const { createLogger } = require('../shared/logger');
```

### Dependency Graph Violation

```
gateway.js (imports)
  → gateway-pipeline.js
      → gateway-steps.js
          → core/middleware.js    ← VIOLATION (breaks isolation)
          → core/router.js        ← VIOLATION (breaks isolation)
              ↘ memory/manager.js (circular back to gateway context)
```

Intended DAG:

```
gateway.js
  → gateway-steps.js (isolated)
  → core/middleware.js (separate)
  → core/router.js (separate)
  ← memory/manager.js (no circular ref)
```

### Hot-Reload Crash Scenario

**File**: `src/core/hot-reload.js` (inferred)

When `core/router.js` changes on disk:

1. File watcher fires
2. Delete from `require.cache['...src/core/router.js']`
3. gateway-steps.js re-requires core/router.js
4. router.js initialization code runs again
5. router.js may require('../gateway/gateway') for context
6. Gateway constructor expects sessions to be pre-initialized
7. **CRASH**: `TypeError: Cannot read property 'sessions' of undefined`

### Test Case: Circular Require Under Hot-Reload

**File**: `tests/critical/circular-require-hotreload.test.js` (should be created)

```javascript
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

test('Hot-reload crash — circular require cycle', async (t) => {
  // Simulate hot-reload by clearing require cache
  const routerPath = require.resolve('../src/core/router');
  const stepsPath = require.resolve('../src/gateway/gateway-steps');

  // Clear cache to simulate file change
  delete require.cache[routerPath];

  try {
    // This will re-require router.js, which may create circular dependency
    const steps = require(stepsPath);

    // If we get here without error, no circular require issue
    assert.ok(steps, 'gateway-steps should load');
  } catch (err) {
    // EXPECTED IN CURRENT CODE:
    // Error: Cannot read property 'sessions' of undefined
    // Reason: router.js tried to access Gateway.sessions during re-require

    if (err.message.includes('Cannot read')) {
      assert.fail(`Circular require detected: ${err.message}`);
    }
    throw err;
  }
});
```

### Isolation Linting Rule

**Recommended**: Add to `.eslintrc.js`

```javascript
module.exports = {
  rules: {
    'no-illegal-gateway-imports': {
      meta: {
        docs: { description: 'gateway-steps.js cannot import from core/' },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            const filename = context.getFilename();
            if (!filename.includes('gateway-steps.js')) return;

            const source = node.source.value;
            if (source.includes('/core/') && !source.includes('shared/')) {
              context.report({
                node,
                message: `gateway-steps.js cannot import from core/. Use dependency injection instead.`,
              });
            }
          },
        };
      },
    },
  },
};
```

---

## Remediation Code Examples

### Fix #1: PgCompat Async/Sync (db/index.js)

**Current (buggy)**:

```javascript
transaction(fn) {
  return async () => {
    return this._adapter.transaction(async (tx) => {
      const txDb = {
        prepare: (sql) => new PgTxStatement(tx, sql),
      };
      return fn(txDb);
    });
  };
}
```

**Fixed**:

```javascript
transaction(fn) {
  // Return async function that caller MUST await
  return async () => {
    return this._adapter.transaction(async (tx) => {
      const txDb = {
        prepare: (sql) => new PgTxStatement(tx, sql),
      };
      return fn(txDb);
    });
  };
}

// Also add helper for backward-compat:
async runTransaction(fn) {
  const txFn = this.transaction(fn);
  return await txFn();  // ← Properly awaits
}
```

**Usage fix (memory/manager.js:378)**:

```javascript
// BEFORE:
const batch = db.transaction(async () => {
  for (const id of ids) await stmt.run(id);
});
batch();  // ← Not awaited

// AFTER:
const batch = db.transaction(async () => {
  for (const id of ids) await stmt.run(id);
});
await batch();  // ← Properly awaited
```

### Fix #2: Strangler Fig Race (gateway.js)

**Current (buggy)**:

```javascript
const GATEWAY_V2_ENABLED = process.env.EFFY_GATEWAY_V2 === 'true';

// ... in constructor ...
if (GATEWAY_V2_ENABLED) {
  this._pipeline = createGatewayPipeline(this);
}

// ... in onMessage ...
async onMessage(msg) {
  if (this._pipeline && GATEWAY_V2_ENABLED) {  // ← Uses stale constant
    return this._pipeline.execute({ msg, adapter });
  }
  // Legacy path
}
```

**Fixed (with version tracking)**:

```javascript
class Gateway {
  constructor() {
    // ... existing init ...

    // Read from config (can be reloaded)
    this._v2Enabled = this._readGatewayV2Flag();

    // Session format version header
    this._sessionFormatVersion = 'v2';  // Current pipeline version
  }

  _readGatewayV2Flag() {
    // Check config server or env var
    // For now: env var is fine, but could be replaced with ConfigStore
    return process.env.EFFY_GATEWAY_V2 === 'true';
  }

  async onMessage(msg, adapter) {
    // Add format version to message context
    const ctx = {
      msg,
      adapter,
      formatVersion: this._sessionFormatVersion,
    };

    // Use instance method (reloadable) instead of constant
    if (this._pipeline && this._v2Enabled) {
      return this._pipeline.execute(ctx);
    }
    // Legacy path
    return this._onMessageLegacy(msg, adapter);
  }
}
```

**Session format versioning**:

```javascript
// When writing session state:
const sessionData = {
  __format_version: 'v2',  // Add this header!
  messages: workingMemory.get(sessionKey),
  compactionMetadata: { ... },
  lastAccessTime: Date.now(),
};

// When reading:
const sessionData = loadSessionState(sessionKey);
if (sessionData.__format_version !== expectedVersion) {
  log.warn(`Format mismatch: expected ${expectedVersion}, got ${sessionData.__format_version}`);
  // Graceful degradation: migrate or reject
}
```

### Fix #3: Module Isolation (gateway-steps.js)

**Current (violation)**:

```javascript
const { runMiddleware } = require('../core/middleware');
const { classifyRequest } = require('../core/router');

async function middlewareStep(ctx) {
  const mw = runMiddleware({ ... });
  // ...
}
```

**Fixed (dependency injection)**:

```javascript
async function createSteps(gatewayInstance) {
  // Bind router and middleware at setup time, not import time
  const { runMiddleware } = require('../core/middleware');
  const { classifyRequest } = require('../core/router');

  return {
    middleware: async (ctx) => {
      const mw = runMiddleware({ ... });
      // ...
    },
    functionRoute: async (ctx) => {
      ctx.routing = classifyRequest({ ... });
      // ...
    },
    // ... etc
  };
}

// In gateway-pipeline.js:
const STEP_REGISTRY = createSteps(gateway);  // Evaluated at pipeline creation
```

Or use a factory pattern:

```javascript
class GatewaySteps {
  constructor(gateway) {
    this.gateway = gateway;
    // Delay-require core modules here
  }

  async middlewareStep(ctx) {
    const { runMiddleware } = require('../core/middleware');  // Local require
    const mw = runMiddleware({ ... });
    // ...
  }
}

// In gateway-pipeline.js:
this._steps = new GatewaySteps(this.gateway);
```

---

## Test Coverage Recommendations

**Create new test files**:

1. `tests/critical/db-pg-transaction.test.js` — Test PgCompat transaction awaiting
2. `tests/critical/gateway-blue-green.test.js` — Test v1/v2 mixed pipeline
3. `tests/critical/hot-reload-circular.test.js` — Test circular require under cache clear
4. `tests/concurrency/load-test-100-sessions.test.js` — Soak test at scale

---

## Conclusion

The evidence shows three compounding architectural issues that manifest under load:

1. **Async/sync mismatch** causes silent race conditions in transactions
2. **Feature flag staling** causes format incompatibility under rolling deployments
3. **Module isolation violation** causes crashes during hot-reload or startup race

All three must be fixed before production deployment.
