# Effy v3.6.3 Review / Debug Log

Date: 2026-03-20
Workspace: `/Users/drake/Documents/New project/effy-github-sync`

## Scope

- Reviewed feature surface from README, `src/`, and existing tier1/tier2 suites.
- Exercised core flows through unit, integration, E2E, and stress tests.
- Focused edge-case audit on:
  - agent routing / admin guard / tool registry
  - datasource / shell / file security boundaries
  - observer / proactive engine / feedback loop
  - dashboard auth / SSE / metrics
  - reflection / committee voting
  - context hub SSRF / prompt injection / BM25
  - task / incident / cron / mailbox stress

## Debug Timeline

1. Confirmed the current working directory was not the requested ZIP project and extracted `effy-v3.6.3.zip` into `effy-review/`.
2. Ran `npm run test:tier1`.
   - Initial failure was environmental: missing `dotenv` / `yaml`.
3. Tried `npm install`.
   - Install failed because `better-sqlite3` fell back to native build on Node `v25.6.1`, and the machine did not have Xcode Command Line Tools.
   - This is a reproducible environment edge case for this project, whose `package.json` targets Node `>=22`.
4. Unblocked the test run with:
   - `npm install --ignore-scripts --omit=optional`
5. Re-ran `npm run test:tier1`.
   - Result: 411 / 411 pass.
6. Ran `npm run test:tier2`.
   - Initial review pass exposed Observer regressions in passive filtering / proactive branch ordering.
7. Fixed the first Observer issues and added regression coverage:
   - emoji-only and non-string observation payload handling
   - `ACTIVE` proactive proposal branch ordering
8. Started a second pass with a deeper audit lens:
   - re-init / destroy lifecycle safety
   - repeated `start()` idempotence for schedulers
   - config precedence and nullish-default handling
   - variable interpolation across JSON / string / object boundaries
   - CORS origin normalization and numeric boundary parsing
9. Found additional runtime bugs that were not surfaced by the earlier suite:
   - Observer `init()` could create duplicate processing loops on re-init
   - `MorningBriefing.start()` and `DocumentIngestion.start()` could leave old timers alive
   - `DocumentIngestion` could ignore `opts.config` precedence and mishandle falsy interval values
   - `WorkflowEngine` variable substitution could corrupt JSON-like payloads containing quotes/newlines or standalone object placeholders
   - Dashboard CORS could be over-permissive without exact-origin normalization
   - Dashboard activity limit parsing treated `'0'` as default instead of lower-bound clamp
10. Added deeper regression suites:
   - `tests/tier2-lifecycle-workflow.test.js`
   - expanded `tests/tier2-dashboard.test.js`
   - expanded `tests/tier2-observer.test.js`
11. Re-ran targeted validation:
   - `node --test tests/tier2-dashboard.test.js tests/tier2-lifecycle-workflow.test.js tests/tier2-observer.test.js`
   - Result: 73 / 73 pass
12. Re-ran full verification:
   - `npm run test:tier1`
   - `npm run test:tier2`
   - `npm test`
13. Final result:
   - 699 / 699 tests passing

## Findings And Fixes

### 1. Observer accepted emoji-only noise as meaningful input

- File: `src/observer/passive-listener.js`
- Problem:
  - Code only checked `trim().length < 2`.
  - Messages like `👍👍` or punctuation-only payloads could enter observation buffers even though the comment said pure emoji/symbol noise should be filtered.
  - Non-string payloads could also throw at `.trim()`.
- Fix:
  - Added a meaningful-text guard.
  - Filter now requires a string payload, at least 2 trimmed chars, and at least one Unicode letter/number.
- Regression coverage:
  - emoji-only message is filtered
  - short-but-meaningful agreement (`ㅇㅇ`) is preserved
  - non-string payload is filtered safely

### 2. ProactiveEngine never sent Level 3 active proposals

- File: `src/observer/proactive-engine.js`
- Problem:
  - For `LEVEL.ACTIVE`, high-confidence insights matched the `nudge` branch first.
  - That returned early, so channel-level active proposals were unreachable.
- Fix:
  - Prioritized the `ACTIVE` branch before `NUDGE`.
  - Preserved nudge behavior for lower-confidence cases.
- Regression coverage:
  - ACTIVE + high confidence now sends a channel-level proposal
  - invalid channels are suppressed before silent logging

### 3. Observer re-init could leak duplicate background loops

- File: `src/observer/index.js`
- Problem:
  - `init()` could be called more than once during gateway/bootstrap reload scenarios.
  - Existing timer and component references were not torn down first, so a second `init()` could leave duplicate proactive intervals alive.
  - `enabled: false` during re-init also needed to fully clear old runtime state instead of only short-circuiting future setup.
- Fix:
  - `init()` now destroys any existing state before rebuilding.
  - `destroy()` now nulls timer and component references consistently and supports silent teardown during re-init.
  - `intervalMs` switched to nullish-coalescing so legitimate falsy values are not accidentally replaced.
- Regression coverage:
  - re-init clears the previous interval
  - re-init into `enabled: false` leaves the observer fully disabled with no live timer

### 4. Scheduler-style features were not idempotent on repeated start

- Files:
  - `src/features/morning-briefing.js`
  - `src/features/doc-ingestion.js`
- Problem:
  - Calling `start()` twice could stack timers/intervals instead of replacing the previous schedule.
  - This is a real lifecycle edge case during hot reloads, repeated bootstrap, or admin-triggered restarts.
  - `DocumentIngestion` also needed explicit `opts.config` precedence and nullish interval fallback behavior.
- Fix:
  - `start()` now begins with `stop()` in both modules.
  - `stop()` now nulls the internal timer handle.
  - `DocumentIngestion` now respects injected config precedence, uses `??` for `intervalMs`, and `unref()`s its interval when available.
- Regression coverage:
  - repeated `start()` clears the old scheduler
  - injected ingestion config is honored correctly

### 5. Workflow variable interpolation could corrupt structured payloads

- File: `src/features/workflow-engine.js`
- Problem:
  - The earlier variable resolution approach relied on broad JSON-string replacement behavior.
  - Values containing quotes/newlines could produce corrupted strings.
  - Standalone placeholders for objects/arrays could become stringified blobs instead of real structured values.
- Fix:
  - Replaced it with recursive resolution over strings, arrays, and objects.
  - Standalone `${var}` placeholders can now inject cloned object/array values as proper runtime structures.
  - Embedded placeholders inside longer strings still stringify safely.
- Regression coverage:
  - quoted / multiline strings remain intact
  - standalone object placeholders remain objects

### 6. Dashboard boundary handling had exact-origin and numeric clamp bugs

- File: `src/dashboard/api/metrics.js`
- Problem:
  - CORS validation needed exact origin normalization, not broad host/port acceptance.
  - Without that, unrelated origins sharing the same port could become incorrectly trusted.
  - Activity limit parsing also had a coercion edge case where `'0'` was treated like missing input instead of being clamped to the lower bound.
- Fix:
  - Added `normalizeOrigin()` and `isAllowedDashboardOrigin()` for exact-origin checks.
  - Allowlist now permits only `localhost`, `127.0.0.1`, detected LAN IP, or exact `externalUrl` origin.
  - Added `parseActivityLimit()` with explicit parse / clamp semantics.
- Regression coverage:
  - unrelated same-port origins are rejected
  - `externalUrl` uses exact-origin matching
  - `'0'` is clamped to `1`

## Edge Cases Covered In Audit

### Agent / Routing / Governance

- unknown agent fallback
- per-agent tier ceilings/floors
- deprioritized model cooldown fallback
- admin-only tool enforcement
- backward-compatible alias behavior

### Security / Platform Boundaries

- path traversal in filesystem and doc fetch
- SSRF variants including IPv6, encoded localhost, credentials, decimal IP
- prompt injection patterns across XML / template syntaxes
- shell chaining / dangerous command blocking
- SQL query safety and FTS sanitization

### Observer / Proactive / Feedback

- bot / DM / excluded channel filtering
- low-signal noise filtering
- disabled pattern suppression after repeated dismissals
- invalid proactive channel suppression
- active vs nudge routing thresholds
- observer re-init and disabled-state teardown

### State / Stress / Throughput

- mailbox overflow and oldest-drop behavior
- dashboard SSE connection cap
- insight store max-cap / expiry / merge
- 1000-message observer burst
- large BM25 index and repeated searches
- repeated scheduler start idempotence
- workflow variable substitution across nested object/array payloads
- dashboard CORS same-port spoof attempts
- numeric clamp behavior for `limit=0`

## Verification Summary

- `node --test tests/tier2-dashboard.test.js tests/tier2-lifecycle-workflow.test.js tests/tier2-observer.test.js` -> pass
- `npm run test:tier1` -> pass
- `npm run test:tier2` -> pass
- `npm test` -> pass
- Final full-suite status: 703 tests, 703 pass, 0 fail

## Hardcoding Audit

### Confirmed runtime hardcoding risks

1. Dashboard UI falls back to fabricated mock production data
   - File: `src/dashboard/app.jsx`
   - The runtime dashboard renders hardcoded overview/agent/activity/session metrics when API fetches are null or failing.
   - This includes named users, request counts, costs, and a fixed month label (`March 2026`).
   - Risk: operators can see believable but false system state instead of a loading / error state.

2. Workflow execution identity and memory scope are hardcoded
   - File: `src/features/workflow-engine.js`
   - Every workflow step executes as `agentId: 'ops'` with `accessiblePools: ['team']` and `writablePools: ['team']`.
   - Risk: workflows cannot honor least privilege, cannot target non-team pools cleanly, and may behave differently from the triggering agent's intended context.

3. Budget downgrade target is hardcoded to a specific model ID
   - File: `src/core/budget-gate.js`
   - Budget enforcement always downgrades to `claude-haiku-4-5-20251001` instead of using configured tier1/default model metadata.
   - Risk: changing configured models will leave budget behavior pointing at stale vendor-specific IDs.

4. UI locale / time presentation is partially hardcoded
   - Files:
     - `src/features/morning-briefing.js`
     - `src/dashboard/app.jsx`
   - `ko-KR`, KST-centric wording, and fixed locale formatting are embedded directly in runtime output.
   - Risk: behavior is fine for a Korea-only deployment, but it is not configuration-driven and will not localize correctly for multi-region teams.

### Items reviewed but considered acceptable

- Vendor API endpoints in ingestion / integrations are expected protocol constants, not deployment secrets.
- No real production credentials or live API keys were found hardcoded in runtime source files.
- Example tokens and secrets found in docs/tests are placeholders or test fixtures, not active application configuration.

## Patch Pass 3 — Hardcoding / Commonization Cleanup

### Resolved in this pass

1. Dashboard stopped fabricating production-looking mock state
   - Added `GET /dashboard/api/snapshot` to aggregate all dashboard payloads in one request.
   - Reworked `src/dashboard/app.jsx` to:
     - use a single snapshot poll + SSE activity stream
     - show explicit API degradation state instead of fake metrics
     - remove fixed month / locale / trend numbers
     - replace hardcoded side-panel counts with real memory / operations data

2. Workflow execution context is now configuration-driven
   - `src/features/workflow-engine.js` now resolves `agentId`, readable pools, and writable pools from:
     - step override
     - caller context
     - workflow definition
     - agent config defaults
   - This removed the previous `ops` / `team` hardcoding.

3. Model selection defaults are centralized
   - Added `src/shared/model-config.js`.
   - Replaced scattered fallback logic in:
     - runtime
     - model router
     - budget gate
     - reflection modules
     - memory summarization / bulletin / indexer
     - gateway compaction
     - GitHub webhook summarization
   - Budget downgrades now follow configured tier1 model instead of a vendor ID literal.

4. Locale-sensitive output is no longer frozen to one UI string
   - Dashboard time / month labels now use runtime locale.
   - Morning briefing date formatting now uses configurable locale + timezone fallback instead of a fixed `ko-KR` formatter.

### New regression coverage added

- `tests/tier1-model-config.test.js`
  - centralized model-config merge behavior
  - budget downgrade respects configured tier1 model
- `tests/tier2-lifecycle-workflow.test.js`
  - workflow execution context resolution and pool precedence
- `tests/tier2-dashboard.test.js`
  - snapshot envelope shape
  - zero-budget percent guard

### Verification after patch pass 3

- `node --test tests/tier1-model-config.test.js tests/tier1-model-router.test.js tests/tier2-lifecycle-workflow.test.js tests/tier2-dashboard.test.js` -> pass (76 / 76)
- `node --test tests/tier2-gateway-e2e.test.js tests/tier2-runtime-integration.test.js tests/tier2-gateway-e2e-r2.test.js` -> pass (153 / 153)
- `node --test tests/tier2-stress.test.js tests/tier2-stress-chub.test.js tests/tier2-stress-chub-r2.test.js` -> pass (38 / 38)
- `npm test` -> pass (703 / 703)

## Environment Notes

- Native `npm install` currently fails on this machine with Node `v25.6.1` because `better-sqlite3` has no matching prebuilt binary and requires Xcode CLT for source build.
- For full native dependency install, one of the following is needed:
  - run under a Node 22/24 environment compatible with the locked dependency set
  - or install Xcode Command Line Tools so `node-gyp` can build `better-sqlite3`
