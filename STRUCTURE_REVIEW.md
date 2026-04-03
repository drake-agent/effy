# Structure Critic Review: v4.0 Migration
**Methodology**: Newcomer Failure Prediction — identifying where a new developer will misunderstand code and break something.

---

## CRITICAL ISSUES (Will cause runtime failures)

### 1. **DATABASE API CONFUSION: Sync vs. Async Mismatch** ⚠️ **HIGH RISK**

**File**: `src/db/db-compat.js` (lines 37-48)

**Problem**: The function advertises "async" but contains a synchronous SQLite code path that violates the async contract:

```javascript
async function dbGet(sql, params = []) {
  _ensureInit();
  const adapter = getAdapter();

  if (adapter.type === 'sqlite' && adapter.db) {
    // ❌ NO await! Sync path returns Promise implicitly
    try {
      return adapter.db.prepare(sql).get(...params) || null;  // SYNC
    } catch (err) {
      log.error('dbGet error (sqlite)', { sql: sql.slice(0, 100), error: err.message });
      throw err;
    }
  }

  // Async path for PostgreSQL
  return adapter.get(sql, params);  // Returns Promise
}
```

**Why it fails**:
- A newcomer writes: `const result = await dbGet(...)` ✓ Works
- Later writes: `const result = dbGet(...)` (forgot await) — Silently receives a value (not Promise) on SQLite, crashes on PostgreSQL with "result is not a Promise" or type mismatch

**Same issue in**: `dbAll()` (line 57), `dbRun()` (line 79), `dbExec()` (line 101)

**Fix needed**: Either:
1. Make all paths async: `return new Promise(r => r(adapter.db.prepare(...).get(...)))`
2. Or separate into `dbGetSync()` / `dbGetAsync()` with clear naming

---

### 2. **TRANSACTION API MISMATCH: Return Type Contract Broken**

**File**: `src/db/index.js` (lines 101-111)

**Problem**: `PgCompat.transaction()` violates the better-sqlite3 API contract:

```javascript
transaction(fn) {
  // better-sqlite3 스타일: db.transaction(() => { ... })() 호출 패턴 지원
  return async () => {
    return this._adapter.transaction(async (tx) => {
      const txDb = { prepare: (sql) => new PgTxStatement(tx, sql) };
      return fn(txDb);
    });
  };
}
```

**Expected** (SQLite): `db.transaction(fn)()` returns value synchronously
**Actual** (PostgreSQL): Returns `async () => { ... }` — a function, not the result

**Why it fails**:
```javascript
// Old code expects (from SQLite):
const result = db.transaction(() => { db.prepare(...).run(...); })();
// On PostgreSQL: result is an async function, not transaction result
```

**Usage in gateway-steps.js**: Not used in main path, but will break if introduced.

---

### 3. **GATEWAY V2 PIPELINE INCOMPLETE CONTEXT PASSING**

**File**: `src/gateway/gateway-steps.js` (lines 360-362) vs. `src/gateway/gateway.js` (lines 590, 608)

**Problem**: Step functions don't have access to `mw.traceId`, which is used in logging:

```javascript
// gateway-steps.js: No access to mw object
ctx.result = await runAgent({ ... });

// gateway.js (legacy): Has mw.traceId
log.info(`trace=${mw.traceId} agent=${agentId} ...`);
```

**Missing from pipeline context**:
- `ctx.traceId` is set in `middlewareStep()` (line 39) ✓
- But `respondStep()` uses `traceId` (line 456) — correctly set
- However, `outcomeTrackingPost()` logs (line 512): `traceId: ctx.traceId` — may be undefined if pipeline fails early

**Why it fails**: If middleware is skipped or halted, traceId is undefined. Logging becomes: `trace=undefined` instead of actual ID.

**Fix needed**: Ensure `ctx.traceId` is initialized in pipeline context creation before any step runs.

---

### 4. **SILENT ERROR SWALLOWING IN POST-PROCESSING STEPS**

**File**: `src/gateway/gateway-steps.js` (lines 479-485)

```javascript
async function entityUpdatePost(ctx) {
  if (ctx.halted) return;
  try {
    const { getUserProfileCached } = require('../shared/ms-graph');
    const profile = await getUserProfileCached(ctx.userId);
    ...
  } catch {  // ❌ Empty catch — error disappears
    entity.upsert('user', ctx.userId, ctx.msg.sender?.name || '', {}).catch(() => {});
  }
  ...
  entity.upsert('channel', ctx.channelId, '', {}).catch(() => {});  // ❌ Also silent
}
```

**Why it fails**: A new developer adds logic to this function, makes a typo, gets no error signal because all errors are swallowed. Code silently fails.

**Same pattern in**:
- `onboardingStep()` (line 107): `try { ... } catch { /* onboarding optional */ }`
- `helpStep()` (line 119): `try { ... } catch { /* help optional */ }`
- `nlConfigStep()` (line 133): `try { ... } catch { /* nl-config optional */ }`
- Multiple places in `contextAssembleStep()` (lines 322-350)

**Fix needed**: Add at least `log.debug()` with error context, so developers can find issues.

---

## STRUCTURAL PROBLEMS (Will cause confusion/maintenance debt)

### 5. **COPY-PASTE LOGIC DIVERGENCE: V1 vs. V2 Pipeline**

**File**: `src/gateway/gateway.js` (lines 228-262) vs. `src/gateway/gateway-steps.js` (lines 44-108)

**Problem**: The onboarding step was partially duplicated during extraction. Subtle logic difference:

**V1 (gateway.js, line 206-207)**:
```javascript
if (session?.pendingMessage && session.pendingMessage.length > 2 && session.step?.endsWith('_done')) {
  msg.content.text = session.pendingMessage;  // ← MUTATES original msg
}
```

**V2 (gateway-steps.js, line 57-59)**:
```javascript
if (session?.pendingMessage && session.pendingMessage.length > 2 && session.step?.endsWith('_done')) {
  msg.content.text = session.pendingMessage;  // ← SAME mutation
}
```

While identical here, the mutation of `ctx.msg` in step functions is dangerous — if a post-step snapshot uses `msg` later, it sees the mutated version. This is a ticking time bomb.

**Better approach**: Don't mutate `ctx.msg`; set `ctx.effectiveText` instead.

---

### 6. **MISSING JSDoc: Critical State Transitions**

**File**: `src/gateway/gateway-steps.js`

Missing documentation on:
- When `ctx.halted = true` is set vs. when it causes early return
- Expected shape of `ctx.routing` after `functionRouteStep()`
- Why `ctx.effectiveText` vs. `msg.content.text`
- Transaction state passing in `workingMemoryStep()` — is `ctx.correctionResult` initialized before use?

**Line 267-268**: `ctx.correctionResult = { detected: false, ... }` is set, but if reflection module is missing, it's never overwritten — good defensive init. ✓

**Line 305**: `ctx.accessiblePools` is set here, but used later in `agentRuntimeStep()`. No null-check. If step is skipped, undefined access later.

---

### 7. **DEAD CODE & UNREACHABLE PATHS**

**File**: `src/db/db-compat.js` (lines 211-213)

```javascript
// Line 211-213: Unreachable fallback
return adapter.db
  ? adapter.db.prepare(sql).all(sanitized, limit, offset)
  : adapter.all(sql, [sanitized, limit, offset]);
```

If we reach this code for PostgreSQL, `adapter.db` is null/undefined. The ternary is misleading — `adapter.db` doesn't exist for PG, so the first branch is dead code.

**Should be**:
```javascript
if (adapter.type === 'sqlite' && adapter.db) {
  return adapter.db.prepare(sql).all(...);
}
return adapter.all(sql, ...);
```

---

### 8. **NAMING INCONSISTENCY: dbTransaction vs. dbExec**

**File**: `src/db/index.js` (line 267 exports)

```javascript
const { dbGet, dbAll, dbRun, dbExec, dbTransaction, ... } = require('./db-compat');
```

**Why confusing**:
- `dbRun()` — write operation (INSERT/UPDATE/DELETE)
- `dbExec()` — raw multi-statement SQL (DDL)
- `dbTransaction()` — transactional wrapper

A newcomer writes: "I need to execute a transaction" → guesses `dbExec()` instead of `dbTransaction()`.

**Worse**: `dbExec()` in `db-compat.js` (line 101) returns `Promise<void>`, but `dbTransaction()` (line 125) returns `Promise<*>`. Different return contracts for similar operations.

---

### 9. **REFLECTION DISTILLER: IMPORT CYCLES RISK**

**File**: `src/reflection/distiller.js` (lines 142, 245)

```javascript
async _getRecentEpisodic(hours = 24) {
  const { getDb } = require('../db');  // ← Late require
  const db = getDb();
  ...
}

async _enforceGlobalAntiBloat() {
  const { getDb } = require('../db');  // ← Late require (duplicate)
  const db = getDb();
  ...
}
```

**Problems**:
1. **Late requires** inside async methods — anti-pattern. Each call re-executes require lookup.
2. **No API choice**: Should use `dbGet` / `dbAll` / `dbRun` (async) but uses `getDb().prepare()` (mixed sync/async).
3. **Inconsistent with new API**: Everywhere else in v4.0 uses `dbGet`, but distiller uses old `getDb()` pattern.

**Expected**: Move require to top, use dual-mode API:
```javascript
const { dbGet, dbAll, dbRun } = require('../db');

async _getRecentEpisodic(hours = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  return await dbAll(`SELECT ... WHERE created_at > ?`, [since]);
}
```

---

### 10. **REFLECTION ENGINE: UNINITIALIZED CONTEXT ACCESS**

**File**: `src/reflection/engine.js` (lines 276-278)

```javascript
ctx.correctionResult = reflection.detectCorrection(effectiveText, sessionKey, {
  agentId: ctx.agentId, userId: ctx.userId, channelId: ctx.channelId,
  previousAgentResponse: lastAssistant?.content,
});
```

**Issue**: `lastAssistant` is obtained from `workingMemory.get(sessionKey)` (line 274), but there's no null-check. If working memory is empty or corrupted:
- `prevMsgs` is undefined
- `.slice()` throws
- Exception is caught (line 289) with generic log

**Better**: Explicit null-check + early return:
```javascript
const prevMsgs = workingMemory.get(sessionKey);
if (!prevMsgs || prevMsgs.length === 0) {
  ctx.correctionResult = { detected: false, ... };
  return;
}
```

---

### 11. **GATEWAY PIPELINE: MISSING STEP REGISTRY DOCUMENTATION**

**File**: `src/gateway/gateway-steps.js` (lines 560-584)

The `STEP_REGISTRY` is a magic exported object. But:
- No JSDoc describing registry contract
- No type hints for `fn(ctx): Promise<void>`
- No validation that all steps returned by `STEP_REGISTRY[name]` are `async`

A new developer might add a sync function to the registry by accident.

**Better**:
```javascript
/**
 * @type {Object<string, (ctx: PipelineContext) => Promise<void>>}
 * All step functions MUST be async and follow (ctx) => Promise<void> signature.
 * Setting ctx.halted = true causes early pipeline termination.
 */
const STEP_REGISTRY = { ... };
```

---

## MODERATE ISSUES (Potential bugs under load)

### 12. **RACE CONDITION IN LRU EVICTION**

**File**: `src/reflection/engine.js` (lines 108-124)

```javascript
_trackSessionCorrection(sessionKey, correction) {
  // R3-ARCH-2: true LRU — lastAccess 타임스탬프 기반 eviction
  if (this._sessionCorrections.size >= MAX_SESSIONS && !this._sessionCorrections.has(sessionKey)) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, bucket] of this._sessionCorrections) {
      if ((bucket.lastAccess || 0) < oldestTime) {
        oldestTime = bucket.lastAccess || 0;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const oldBucket = this._sessionCorrections.get(oldestKey);
      if (oldBucket?.timer) clearTimeout(oldBucket.timer);
      this._sessionCorrections.delete(oldestKey);
    }
  }
```

**Issue**: No lock. If two concurrent calls to `_trackSessionCorrection()` happen:
1. Both see `size >= MAX_SESSIONS`
2. Both try to find oldest and delete
3. First deletes, second may delete same key again (no-op) or corrupt state

**Impact**: Under 500+ simultaneous users, two corrections from different sessions could interfere.

**Fix**: Use a simple flag or a Set to mark "eviction in progress".

---

### 13. **DISTILLER: PARTIAL FAILURE NOT TRACKED CORRECTLY**

**File**: `src/reflection/distiller.js` (lines 72-122)

```javascript
let skipped = 0;
let failed = 0;

for (const candidate of candidates.slice(0, this.maxDailyPromotions)) {
  if (await this._isDuplicate(candidate.content)) { skipped++; continue; }

  let shouldPromote = true;
  if (this.committee?.enabled) {
    try {
      const result = await this.committee.proposeAndVote({...});
      const hasRealVotes = result.votes?.some(v => v.vote !== 'defer' || !v.reasoning?.startsWith('投票失敗'));
      shouldPromote = (result.status === 'approved' || ...) && hasRealVotes !== false;
      if (!shouldPromote) { skipped++; ... }
    } catch (committeeErr) {
      log.warn(`Committee vote failed, auto-approving: ...`);
      // ❌ Falls through — shouldPromote still true, proceeds to save
    }
  }

  if (!shouldPromote) continue;

  try {
    await this.semantic.save({...});
    promotionCount++;
  } catch (err) {
    failed++;
    log.warn(`Distillation save failed: ...`);
  }
}
```

**Issue**: When committee vote throws (line 98), the code logs "auto-approving" but never sets `shouldPromote = false`. So even if vote fails, the candidate is still promoted. This is intentional ("auto-approve") but misleading — comment says "auto-approving" but doesn't check result status properly.

**Line 91**: The condition `hasRealVotes !== false` is confusing. `hasRealVotes` can be:
- `true` (votes exist, not all defer)
- `false` (no votes, or all are defer)
- `undefined` (no .votes array)

The `!== false` check means undefined → proceed, which may be unintended.

---

## DOCUMENTATION GAPS (Low risk but maintenance debt)

### 14. **API MIGRATION PATH UNCLEAR**

Files affected: `src/db/index.js`, `src/db/db-compat.js`

The README doc (lines 3-17 of `index.js`) says:

```
Backward-compatible with existing code:
  const { getDb } = require('../db');
  const db = getDb();
  const row = await db.prepare('SELECT ...').get(param);  ← MIX of sync/async

New adapter API (recommended for new code):
  const { dbGet, dbAll, dbRun, dbExec } = require('../db');
  const row = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
```

**Problem**: It says "await db.prepare()" but on SQLite this is sync, on PostgreSQL async. Which is correct? A newcomer will copy this pattern blindly.

**Should clarify**:
```
⚠️ For PostgreSQL ALWAYS use await, for SQLite it's optional (but do it anyway).
Better: Use dbGet/dbAll/dbRun for all new code — uniform across both databases.
```

---

### 15. **GATEWAY PIPELINE CONTEXT NOT FULLY DOCUMENTED**

**File**: `src/gateway/gateway-pipeline.js` (lines 60-76)

The `PipelineContext` typedef is partially documented, but missing:
- When is `halted` flag checked (before or after step runs)?
- What happens if a step throws?
- Can steps add new properties to ctx?
- Is ctx shallow or deep copied?

**Example confusion**: In post-steps (line 164-195), context is partially deep-copied (msg and routing), but other properties like `result` are shared. A post-step modifying `ctx.result` affects dashboard broadcast later.

---

## SUMMARY TABLE

| Issue # | Severity | Type | File | Impact |
|---------|----------|------|------|--------|
| 1 | 🔴 CRITICAL | API Design | db-compat.js | Runtime failures (sync/async confusion) |
| 2 | 🔴 CRITICAL | API Contract | index.js | Transaction code will break |
| 3 | 🟠 HIGH | Context | gateway-steps.js | Missing traceId in logs |
| 4 | 🟠 HIGH | Error Handling | gateway-steps.js | Silent failures in post-steps |
| 5 | 🟡 MEDIUM | Duplication | gateway.js vs steps.js | Logic drift risk |
| 6 | 🟡 MEDIUM | Documentation | gateway-steps.js | Context state unclear |
| 7 | 🟡 MEDIUM | Code Quality | db-compat.js | Dead code in FTS path |
| 8 | 🟡 MEDIUM | Naming | db/index.js | Confusing API names |
| 9 | 🟡 MEDIUM | Pattern | distiller.js | Anti-pattern late requires |
| 10 | 🟡 MEDIUM | Null Safety | engine.js | Uninitialized access |
| 11 | 🟡 MEDIUM | Documentation | gateway-steps.js | No step registry contract |
| 12 | 🟠 HIGH | Concurrency | engine.js | Race in LRU eviction |
| 13 | 🟡 MEDIUM | Logic | distiller.js | Misleading auto-approve |
| 14 | 🔵 LOW | Docs | index.js | Migration path unclear |
| 15 | 🔵 LOW | Docs | gateway-pipeline.js | Context contract unclear |

---

## RECOMMENDATIONS FOR NEWCOMERS

1. **Never use `getDb()` for new code** — always use `dbGet()`, `dbAll()`, `dbRun()`, `dbExec()`
2. **Always await database calls** — even on SQLite, for API consistency
3. **Check for `ctx.halted` before major operations** in step functions
4. **Test with both SQLite and PostgreSQL** — they have different async contracts
5. **Use `log.debug()` instead of empty `catch` blocks** — helps future debugging
6. **Document context mutations** if a step modifies `ctx` state
7. **Reference `STEP_REGISTRY` only through `gateway-pipeline.js`** — don't access directly

