# EFFY v4.0 Migration - Blast Radius Analysis

**Date:** March 30, 2026
**Scope:** Code review preparation for 138 modified files across 6 phases

---

## Executive Summary

The Effy v4.0 migration touches 3 critical dependency hubs:
1. **Database Adapter Layer** (src/db/adapter.js) - 11 direct dependents
2. **Gateway Pipeline** (src/gateway/gateway.js) - 36 internal imports
3. **Request Middleware** (src/core/middleware.js) - 4 direct dependents

**Blast Radius:** 22-30 files require deep review. Prioritize in this order.

---

## Tier 1: Core Migration Targets (17 Files)

### Phase 1: Security Patches (8 files)
Direct impact on request handling and LLM communication.

| File | Dependents | Dependencies | Risk Level |
|------|-----------|--------------|-----------|
| src/shared/llm-client.js | 3 | 4 | HIGH |
| src/reflection/engine.js | 3 | 2 | HIGH |
| src/reflection/distiller.js | 1 | 6 | MEDIUM |
| src/memory/compaction.js | 1 | 3 | MEDIUM |
| src/core/middleware.js | **4** | 1 | **CRITICAL** |
| src/core/coalescer.js | 2 | 1 | MEDIUM |
| src/core/circuit-breaker.js | **3** | 1 | **CRITICAL** |
| src/core/pool.js | 2 | 2 | HIGH |

**Key Files to Review:**
- `src/core/middleware.js` - 4 direct dependents including gateway pipeline
- `src/core/circuit-breaker.js` - 3 dependents control error handling and state management

### Phase 2: DB Layer (6 files)
Highest coupling complexity. Gateway depends on DB index heavily.

| File | Dependents | Dependencies | Risk Level |
|------|-----------|--------------|-----------|
| src/db/adapter.js | **11** | 4 | **CRITICAL** |
| src/db/index.js | **5** | 6 | **CRITICAL** |
| src/db/db-compat.js | 2 | 4 | HIGH |
| src/db/pg-adapter.js | 1 | 3 | MEDIUM |
| src/db/sqlite-adapter.js | 1 | 4 | MEDIUM |
| src/db/fts-helper.js | 1 | 2 | MEDIUM |

**Key Files to Review:**
- `src/db/adapter.js` - **WIDEST IMPACT** (11 dependents)
  - Used by: agents/runtime.js, agents/self-awareness.js, app.js, db/db-compat.js, gateway/gateway-steps.js
- `src/db/index.js` - Central DB export
  - Used by: app.js, distributed/verify.js, evaluation/examples.js, gateway/gateway-steps.js, gateway/gateway.js

### Phase 4: Gateway (3 files)
Request routing and step execution. Heaviest imports (36 in gateway.js).

| File | Dependents | Dependencies | Risk Level |
|------|-----------|--------------|-----------|
| src/gateway/gateway.js | **6** | **36** | **CRITICAL** |
| src/gateway/gateway-steps.js | 1 | 24 | HIGH |
| src/gateway/gateway-pipeline.js | **1** | 2 | MEDIUM |

**Key Files to Review:**
- `src/gateway/gateway.js` - **MOST COMPLEX**
  - Imports 36 modules (routes, agents, core, config)
  - Used by: app.js, gateway-pipeline.js, test suites
- `src/gateway/gateway-steps.js` - New step execution (24 imports)
  - Depends on: agents/runtime, core/middleware, core/router, dashboard/router

---

## Tier 2: Direct Dependents (5-8 Files)

These files integrate the Tier 1 changes into the application.

### Gateway Integration Points
```
src/app.js
├─ imports: src/gateway/gateway.js, src/db/index.js
└─ Role: Main entry point, instantiates gateway
```

### Agent Integration
```
src/agents/runtime.js
├─ imports: src/shared/llm-client.js, src/db/adapter.js
└─ Role: Agent execution engine using DB adapter
```

```
src/agents/self-awareness.js
├─ imports: src/db/adapter.js
└─ Role: Agent introspection using DB backend
```

### Pipeline Wiring
```
src/gateway/gateway-pipeline.js
├─ imports: src/gateway/gateway.js, src/gateway/gateway-steps.js
└─ Role: Orchestrates step execution
```

---

## Tier 3: Config & Build Files (5 Files)

Environment affects all phases. Changes here may require full rebuild/retest.

| File | Status | Tier 1 Impact |
|------|--------|--------------|
| **package.json** | Modified | Dependency versions for db/gateway |
| **Dockerfile** | Modified | Build environment, Node version |
| **.nvmrc** | Modified | Node runtime version spec |
| **.github/workflows/ci.yml** | Modified | Test execution environment |
| **.github/workflows/release.yml** | Modified | Deployment pipeline |

**Review Checklist:**
- [ ] package.json: Verify new deps (pg, better-sqlite3 versions)
- [ ] .nvmrc: Check Node.js version compatibility
- [ ] Dockerfile: Confirm build stages, dependencies installed
- [ ] CI workflow: All test suites still execute
- [ ] Release workflow: Deployment mirrors test environment

---

## Risk Assessment by Zone

### Zone 1: DATABASE LAYER (CRITICAL)
**Files:** src/db/adapter.js, src/db/index.js, src/db/db-compat.js
**Blast Scope:** 11-16 dependents
**What changed:**
- New adapter abstraction (pg vs sqlite switching)
- Compatibility layer for legacy queries
- FTS helper refactored

**Deep Review Required:**
- [ ] Connection pooling behavior with both backends
- [ ] Migration path for existing data
- [ ] Query compatibility between adapters
- [ ] Performance regression in main queries
- [ ] Transaction handling edge cases

---

### Zone 2: GATEWAY PIPELINE (CRITICAL)
**Files:** src/gateway/gateway.js, src/gateway/gateway-steps.js
**Blast Scope:** 6 direct dependents, 36 internal imports
**What changed:**
- Feature flag integration
- Step registry wiring
- 16 new step functions in gateway-steps.js

**Deep Review Required:**
- [ ] Feature flag logic doesn't break non-flagged paths
- [ ] Step registry prevents missing steps at runtime
- [ ] Backward compatibility for existing request payloads
- [ ] Error propagation through pipeline
- [ ] Middleware integration with new steps

---

### Zone 3: MIDDLEWARE & CIRCUIT-BREAKING (HIGH)
**Files:** src/core/middleware.js, src/core/circuit-breaker.js
**Blast Scope:** 4-7 dependents (touches request lifecycle)
**What changed:**
- Security patches applied
- Circuit breaker state machine updated

**Deep Review Required:**
- [ ] Middleware doesn't leak memory with long-lived connections
- [ ] Circuit breaker transitions don't deadlock
- [ ] Error handling doesn't swallow critical failures
- [ ] State recovery after partial failures

---

### Zone 4: CONFIGURATION PROPAGATION (HIGH)
**Files:** package.json, Dockerfile, .nvmrc, CI/CD workflows
**Blast Scope:** Affects all 138 modified files indirectly
**What changed:**
- New DB driver versions
- Updated Node.js version
- Workflow dependency versions

**Deep Review Required:**
- [ ] All new deps are security-patched
- [ ] Docker build succeeds in CI environment
- [ ] Node version is LTS and widely supported
- [ ] Workflows have no broken syntax
- [ ] Release process validated

---

### Zone 5: SECONDARY EFFECTS (MONITOR)
**Files:** All direct dependents of Tier 1 files

Review for:
- Unhandled exceptions from modified dependencies
- Missing feature flag checks
- Broken import paths
- Version incompatibilities

---

## Dependency Graph Visualization

```
package.json / .nvmrc / Dockerfile
    ↓
src/config.js
    ↓
┌─────────────────────────────────────────────┐
│  CRITICAL HUBS                              │
├─────────────────────────────────────────────┤
│                                             │
│  src/db/adapter.js ─────┐                   │
│       (11 dependents)   │                   │
│  src/db/index.js ───────┤                   │
│       (5 dependents)    ├─→ src/app.js      │
│  src/gateway/gateway.js─┤   (main entry)    │
│       (6 dependents)    │                   │
│                         │                   │
└─────────────────────────┼───────────────────┘
                          │
            ┌─────────────┴─────────────┐
            ↓                           ↓
    src/agents/runtime.js    src/agents/
    (db-dependent)           self-awareness.js
```

---

## Review Order (Recommended)

1. **Phase 2 DB Files** (3-4 hours)
   - Focus: src/db/adapter.js (widest impact)
   - Verify: All 11 dependents work with changes

2. **Phase 4 Gateway** (3-4 hours)
   - Focus: src/gateway/gateway.js (most complex)
   - Verify: 36 imports all resolve correctly

3. **Phase 1 Core** (2-3 hours)
   - Focus: src/core/middleware.js, src/core/circuit-breaker.js
   - Verify: Request lifecycle remains intact

4. **Phase 6 Config** (1-2 hours)
   - Verify: All environment setup correct
   - Validate: CI/CD workflows execute

5. **Integration Testing** (2-3 hours)
   - Verify: Tier 2 files integrate correctly
   - Test: DB + gateway + middleware together

---

## Total Estimated Review Time

- **Quick Pass (blockers):** 2-3 hours
- **Deep Review (all critical zones):** 10-15 hours
- **Full Review (including Tier 2):** 15-20 hours

---

## Files Not in 30-File Cap (But Mentioned in Impacts)

If you exceed the 30-file cap, prioritize:
1. src/app.js (entry point)
2. src/agents/runtime.js (uses db/llm-client)
3. src/agents/self-awareness.js (uses db)
4. src/reflection/index.js (uses engine/distiller)
5. src/observer/index.js (uses engine)
