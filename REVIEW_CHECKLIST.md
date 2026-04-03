# EFFY v4.0 Code Review Checklist

**Quick Reference for Blast Radius Reviewer**

---

## Pre-Review Setup

- [ ] Clone the repository and checkout the migration branch
- [ ] Review BLAST_RADIUS_SUMMARY.txt for quick overview
- [ ] Read BLAST_RADIUS.md for detailed dependency analysis
- [ ] Set up test environment (Node.js .nvmrc version)
- [ ] Install dependencies (npm install)

---

## Session 1: Database Layer Review (3-4 hours)

**Start Here** - Database is the widest-impact component (11 dependents for adapter.js)

### File: src/db/adapter.js [CRITICAL]
- [ ] Check adapter interface consistency (pg vs sqlite)
- [ ] Verify all 11 dependents can call new methods
- [ ] Look for breaking signature changes
- [ ] Test connection pooling limits
- [ ] Verify error handling for both backends

**Dependents to test with:**
- agents/runtime.js
- agents/self-awareness.js
- app.js
- db/db-compat.js
- gateway/gateway-steps.js
- (and 6 more listed in blast radius)

### File: src/db/index.js [CRITICAL]
- [ ] Check exported API hasn't changed
- [ ] Verify db-compat integration
- [ ] Test all 5 direct dependents
- [ ] Confirm migrations path correct

### File: src/db/db-compat.js [HIGH]
- [ ] Legacy query compatibility
- [ ] Adapter switching logic
- [ ] Performance on migration queries

### Files: pg-adapter.js, sqlite-adapter.js, fts-helper.js [MEDIUM]
- [ ] Backend-specific optimizations
- [ ] Error messages from each backend

---

## Session 2: Gateway Pipeline Review (3-4 hours)

**Most Complex File** - gateway.js has 36 imports, 6 dependents

### File: src/gateway/gateway.js [CRITICAL]
- [ ] Trace all 36 imports - are they all necessary?
- [ ] Feature flag logic doesn't break non-flagged paths
- [ ] Check middleware is applied in correct order
- [ ] Verify circuit-breaker integration
- [ ] Test pool handling under load
- [ ] Confirm coalescer behavior

**Key Integration Points:**
- [ ] Config reading (src/config.js)
- [ ] Budget gate (src/core/budget-gate.js)
- [ ] Circuit breaker (src/core/circuit-breaker.js)
- [ ] Coalescer (src/core/coalescer.js)
- [ ] DB index (src/db/index.js)
- [ ] Memory compaction (src/memory/compaction.js)

### File: src/gateway/gateway-steps.js [HIGH]
- [ ] All 16 step functions defined
- [ ] No missing steps in registry
- [ ] Middleware correctly applied to each step
- [ ] Step order doesn't cause side effects
- [ ] Router integration working

### File: src/gateway/gateway-pipeline.js [MEDIUM]
- [ ] Pipeline correctly wires gateway.js and gateway-steps.js
- [ ] Step execution order
- [ ] Error handling in pipeline

---

## Session 3: Request Lifecycle Review (2-3 hours)

**High Risk** - Middleware touches every request

### File: src/core/middleware.js [CRITICAL]
- [ ] Memory leaks in middleware storage?
- [ ] Proper cleanup of request context
- [ ] 4 dependents can all use it (pipeline-steps, gateway-steps, gateway, tests)
- [ ] Backward compatibility with older code

### File: src/core/circuit-breaker.js [CRITICAL]
- [ ] State transitions are atomic
- [ ] No deadlock scenarios between states
- [ ] Recovery after failures
- [ ] Doesn't swallow exceptions needed for monitoring
- [ ] Works with 3 dependents (gateway, state/index, state/state-backend)

### File: src/core/pool.js [HIGH]
- [ ] Connection limits enforced
- [ ] Cleanup on pool shutdown
- [ ] Works with db/adapter
- [ ] Used by gateway.js correctly

### Files: src/core/coalescer.js [MEDIUM]
- [ ] Request coalescing logic correct
- [ ] Used by gateway.js

---

## Session 4: Integration Points (2-3 hours)

**Aggregate Effects** - How Tier 1 changes work together

### File: src/app.js [ENTRY POINT]
- [ ] Imports gateway.js and db/index.js correctly
- [ ] Application initialization order
- [ ] Error handling at startup
- [ ] Graceful shutdown

### File: src/agents/runtime.js [CRITICAL]
- [ ] Uses llm-client.js correctly
- [ ] DB adapter integration
- [ ] No missing features from Phase 1/2

### File: src/reflection/index.js
- [ ] Engine and distiller integration
- [ ] Observer relationship

### File: src/state/index.js, src/state/state-backend.js
- [ ] Circuit-breaker integration
- [ ] State management with new middleware

---

## Session 5: Configuration & Build (1-2 hours)

**Environment Setup** - Affects all phases

### File: package.json
- [ ] New dependencies locked to secure versions
- [ ] pg and better-sqlite3 versions compatible
- [ ] No dependency conflicts
- [ ] Scripts haven't changed unexpectedly

### File: .nvmrc
- [ ] Node.js version is LTS
- [ ] All developers using same version
- [ ] CI/CD uses same version

### File: Dockerfile
- [ ] Build succeeds locally
- [ ] Base image version pinned
- [ ] Dependencies installed correctly
- [ ] Multi-stage build if present

### Files: .github/workflows/ci.yml, release.yml
- [ ] CI workflow syntax valid
- [ ] All test commands execute
- [ ] Release workflow won't deploy broken code
- [ ] Secrets and credentials not exposed

---

## Session 6: Integration Testing (2-3 hours)

**Full System** - Verify everything works together

### End-to-End Tests
- [ ] Request flows through middleware → gateway → db
- [ ] Both DB backends work (pg + sqlite)
- [ ] Feature flags toggle correctly
- [ ] Circuit breaker opens/closes
- [ ] Error recovery works

### Performance Baseline
- [ ] Gateway latency acceptable (compare to pre-migration)
- [ ] DB queries don't regress
- [ ] No memory leaks (check after load test)
- [ ] Connection pool doesn't exhaust

### Rollback Scenario
- [ ] Migration is reversible
- [ ] Data migration didn't corrupt anything
- [ ] Rollback doesn't break dependent services

---

## Red Flags to Watch For

- [ ] Synchronous database calls in async context
- [ ] Feature flags not checked before using new APIs
- [ ] Missing null/undefined checks after changes
- [ ] Hardcoded paths or values that should be configurable
- [ ] Inconsistent error handling patterns
- [ ] Tests that pass locally but fail in CI (usually env issues)
- [ ] Config changes not reflected in documentation
- [ ] Race conditions in state transitions (circuit-breaker, pool)
- [ ] Dependency version conflicts
- [ ] Breaking changes in exported APIs

---

## Files to Skip (Already Tested or Low Risk)

These are modifications or have low blast radius:
- src/reflection/distiller.js (1 dependent)
- src/reflection/engine.js (3 dependents, but isolated)
- src/shared/llm-client.js (3 dependents, external integration)
- src/memory/compaction.js (1 dependent)
- All Phase 3 & 5 files (not in high-risk list)

---

## Sign-Off

Once all sessions complete:

- [ ] No CRITICAL issues found
- [ ] All HIGH issues documented and tracked
- [ ] Integration tests pass
- [ ] Performance within acceptable range
- [ ] Configuration validated
- [ ] Ready for staging deployment

**Reviewed by:** _______________  
**Date:** _______________  
**Status:** APPROVED / CONDITIONAL / REJECTED
