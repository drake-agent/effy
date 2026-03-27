/**
 * tier1-new-modules.test.js — v3.8 신규 모듈 통합 테스트
 * Phase 1-3 전체 모듈 검증
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ──────────── Phase 1: Outcome Tracker ────────────
const { OutcomeTracker } = require('../src/memory/outcome-tracker');

describe('OutcomeTracker', () => {
  it('should record and retrieve outcomes', () => {
    const tracker = new OutcomeTracker();
    tracker.record({ agentId: 'a1', turnId: 't1', success: true, timeMs: 100, tokensUsed: 50 });
    tracker.record({ agentId: 'a1', turnId: 't2', success: false, error: 'timeout', timeMs: 5000 });
    const recent = tracker.getRecentOutcomes('a1');
    assert.equal(recent.length, 2);
    assert.equal(recent[1].success, false);
  });

  it('should track agent stats correctly', () => {
    const tracker = new OutcomeTracker();
    tracker.record({ agentId: 'a1', turnId: 't1', success: true });
    tracker.record({ agentId: 'a1', turnId: 't2', success: true });
    tracker.record({ agentId: 'a1', turnId: 't3', success: false, error: 'err' });
    const stats = tracker.getAgentStats('a1');
    assert.equal(stats.success, 2);
    assert.equal(stats.error, 1);
    assert.equal(stats.total, 3);
  });

  it('should generate outcome summary', () => {
    const tracker = new OutcomeTracker();
    tracker.record({ agentId: 'a1', turnId: 't1', success: true });
    tracker.record({ agentId: 'a1', turnId: 't2', success: false, error: 'rate_limit' });
    const summary = tracker.generateOutcomeSummary('a1');
    assert.ok(typeof summary === 'string');
    assert.ok(summary.length > 0);
  });

  it('should emit outcome:recorded event', (_, done) => {
    const tracker = new OutcomeTracker();
    tracker.on('outcome:recorded', (outcome) => {
      assert.equal(outcome.agentId, 'a1');
      done();
    });
    tracker.record({ agentId: 'a1', turnId: 't1', success: true });
  });

  it('should trim history at maxHistory', () => {
    const tracker = new OutcomeTracker({ maxHistory: 5 });
    for (let i = 0; i < 10; i++) {
      tracker.record({ agentId: 'a1', turnId: `t${i}`, success: true });
    }
    assert.ok(tracker._history.length <= 5);
  });

  it('should reset agent data', () => {
    const tracker = new OutcomeTracker();
    tracker.record({ agentId: 'a1', turnId: 't1', success: true });
    tracker.reset('a1');
    assert.equal(tracker.getRecentOutcomes('a1').length, 0);
  });
});

// ──────────── Phase 1: Sandbox Secrets ────────────
const { SandboxSecretManager } = require('../src/core/sandbox-secrets');

describe('SandboxSecretManager', () => {
  it('should register and request secrets', () => {
    const mgr = new SandboxSecretManager();
    mgr.registerSecret('API_KEY', 'sk-12345', { description: 'test key' });
    const value = mgr.requestSecret('API_KEY', { agentId: 'a1', reason: 'test' });
    assert.equal(value, 'sk-12345');
  });

  it('should return null for non-existent secrets', () => {
    const mgr = new SandboxSecretManager();
    const value = mgr.requestSecret('MISSING', { agentId: 'a1' });
    assert.equal(value, null);
  });

  it('should log access attempts', () => {
    const mgr = new SandboxSecretManager();
    mgr.registerSecret('KEY', 'val');
    mgr.requestSecret('KEY', { agentId: 'a1' });
    mgr.requestSecret('MISSING', { agentId: 'a1' });
    const logs = mgr.getAccessLog();
    assert.ok(logs.length >= 2);
  });

  it('should create safe getter function', () => {
    const mgr = new SandboxSecretManager();
    mgr.registerSecret('DB_PASS', 'secret123');
    const getter = mgr.createSecretGetter('a1');
    assert.equal(getter('DB_PASS'), 'secret123');
    assert.equal(getter('MISSING'), null);
  });

  it('should list secrets without values', () => {
    const mgr = new SandboxSecretManager();
    mgr.registerSecret('KEY1', 'v1', { description: 'first' });
    mgr.registerSecret('KEY2', 'v2', { description: 'second' });
    const list = mgr.getRegisteredSecrets();
    assert.equal(list.length, 2);
    // Must NOT contain values
    for (const item of list) {
      assert.ok(!('value' in item));
      assert.ok('name' in item);
    }
  });

  it('should validate secret names', () => {
    assert.equal(SandboxSecretManager.validateSecretName('valid_key'), true);
    assert.equal(SandboxSecretManager.validateSecretName(''), false);
    assert.equal(SandboxSecretManager.validateSecretName('a'.repeat(65)), false);
  });

  it('should remove secrets', () => {
    const mgr = new SandboxSecretManager();
    mgr.registerSecret('KEY', 'val');
    mgr.removeSecret('KEY');
    assert.equal(mgr.requestSecret('KEY', { agentId: 'a1' }), null);
  });
});

// ──────────── Phase 2: Error Classification ────────────
const { ErrorClassifier } = require('../src/shared/error-classifier');

describe('ErrorClassifier', () => {
  it('should classify Anthropic rate limit error', () => {
    const ec = new ErrorClassifier();
    const result = ec.classify('anthropic', { status: 429, type: 'rate_limit_error' });
    assert.equal(result.category, 'rate_limit');
    assert.equal(result.retriable, true);
  });

  it('should classify Anthropic auth error', () => {
    const ec = new ErrorClassifier();
    const result = ec.classify('anthropic', { status: 401, type: 'authentication_error' });
    assert.equal(result.category, 'auth');
    assert.equal(result.retriable, false);
  });

  it('should classify OpenAI context length error', () => {
    const ec = new ErrorClassifier();
    const result = ec.classify('openai', { status: 400, code: 'context_length_exceeded' });
    assert.equal(result.category, 'context_overflow');
    assert.equal(result.retriable, false);
  });

  it('should classify Google RESOURCE_EXHAUSTED', () => {
    const ec = new ErrorClassifier();
    const result = ec.classify('google', { status: 429, code: 'RESOURCE_EXHAUSTED' });
    assert.equal(result.category, 'rate_limit');
    assert.equal(result.retriable, true);
  });

  it('should fall back to generic classifier', () => {
    const ec = new ErrorClassifier();
    const result = ec.classify('unknown_provider', { status: 500 });
    assert.equal(result.category, 'network');
    assert.equal(result.retriable, true);
  });

  it('should compute exponential backoff', () => {
    const ec = new ErrorClassifier();
    const classification = ec.classify('anthropic', { status: 429, type: 'rate_limit_error' });
    const b1 = ec.computeBackoff(1, classification);
    const b2 = ec.computeBackoff(2, classification);
    assert.ok(b2 > b1, `b2(${b2}) should be > b1(${b1})`);
    assert.ok(b1 >= 500, `b1(${b1}) should be >= 500`);
  });

  it('should return correct max retries per category', () => {
    const ec = new ErrorClassifier();
    assert.ok(ec.maxRetries({ category: 'rate_limit' }) >= 3);
    assert.equal(ec.maxRetries({ category: 'auth' }), 0);
    assert.equal(ec.maxRetries({ category: 'context_overflow' }), 0);
  });

  it('should handle unknown error gracefully', () => {
    const ec = new ErrorClassifier();
    const result = ec.classify('anthropic', {});
    assert.ok(['unknown', 'network'].includes(result.category));
    assert.ok('retriable' in result);
    assert.ok('provider' in result);
  });
});

// ──────────── Phase 2: Prometheus Metrics ────────────
const { PrometheusMetrics, getMetrics } = require('../src/observability/prometheus');

describe('PrometheusMetrics', () => {
  it('should create singleton', () => {
    const m1 = getMetrics({ enabled: true });
    const m2 = getMetrics();
    assert.equal(m1, m2);
  });

  it('should not throw when prom-client missing', () => {
    const pm = new PrometheusMetrics({ enabled: true });
    // Even if prom-client is not installed, methods should not throw
    assert.doesNotThrow(() => pm.recordError('agent1', 'rate_limit', 'anthropic'));
    assert.doesNotThrow(() => pm.recordToolExecution('tool1', 'success', 100));
  });

  it('should return metrics string', async () => {
    const pm = new PrometheusMetrics({ enabled: true });
    const metrics = await pm.getMetrics();
    assert.ok(typeof metrics === 'string');
  });

  it('should return content type', () => {
    const pm = new PrometheusMetrics({ enabled: true });
    const ct = pm.getContentType();
    assert.ok(typeof ct === 'string');
  });
});

// ──────────── Phase 3: Schema Validation ────────────
const { Schema, SchemaError, AgentRequestSchema, AgentResponseSchema, MemoryEntrySchema } = require('../src/schema');

describe('Schema', () => {
  it('should validate string with min/max', () => {
    const s = Schema.string({ min: 1, max: 10 });
    assert.equal(s.parse('hello'), 'hello');
    assert.throws(() => s.parse(''), SchemaError);
    assert.throws(() => s.parse('a'.repeat(11)), SchemaError);
  });

  it('should validate number with constraints', () => {
    const n = Schema.number({ min: 0, max: 100 });
    assert.equal(n.parse(50), 50);
    assert.throws(() => n.parse(-1), SchemaError);
    assert.throws(() => n.parse(101), SchemaError);
  });

  it('should validate enum values', () => {
    const e = Schema.enum(['a', 'b', 'c']);
    assert.equal(e.parse('a'), 'a');
    assert.throws(() => e.parse('d'), SchemaError);
  });

  it('should validate object shape', () => {
    const obj = Schema.object({ name: Schema.string(), age: Schema.number() });
    const result = obj.parse({ name: 'Drake', age: 30 });
    assert.equal(result.name, 'Drake');
    assert.throws(() => obj.parse({ name: 'Drake' })); // missing age
  });

  it('should handle optional fields', () => {
    const obj = Schema.object({ name: Schema.string(), bio: Schema.string().optional() });
    const result = obj.parse({ name: 'Drake' });
    assert.equal(result.name, 'Drake');
  });

  it('should validate AgentRequestSchema', () => {
    const valid = { agentId: 'a1', content: 'Hello' };
    assert.doesNotThrow(() => AgentRequestSchema.parse(valid));
    assert.throws(() => AgentRequestSchema.parse({ agentId: '', content: 'test' }));
  });

  it('should validate AgentResponseSchema', () => {
    const valid = { success: true, output: 'Response text' };
    assert.doesNotThrow(() => AgentResponseSchema.parse(valid));
  });

  it('should validate MemoryEntrySchema', () => {
    const valid = { id: 'm1', content: 'data', type: 'episodic' };
    assert.doesNotThrow(() => MemoryEntrySchema.parse(valid));
    assert.throws(() => MemoryEntrySchema.parse({ id: 'm1', content: 'data', type: 'invalid' }));
  });
});

// ──────────── Phase 3: Type Guards ────────────
const guards = require('../src/shared/type-guards');

describe('TypeGuards', () => {
  it('should detect basic types', () => {
    assert.equal(guards.isString('hello'), true);
    assert.equal(guards.isString(123), false);
    assert.equal(guards.isNumber(42), true);
    assert.equal(guards.isNumber(NaN), false);
    assert.equal(guards.isBoolean(true), true);
    assert.equal(guards.isArray([1, 2]), true);
    assert.equal(guards.isObject({}), true);
    assert.equal(guards.isObject(null), false);
    assert.equal(guards.isObject([]), false);
  });

  it('should detect domain types', () => {
    assert.equal(guards.isToolResult({ success: true, output: 'ok' }), true);
    assert.equal(guards.isToolResult({}), false);
    assert.equal(guards.isAgentRequest({ agentId: 'a1', content: 'hi' }), true);
    assert.equal(guards.isAgentRequest({ agentId: '' }), false);
    assert.equal(guards.isErrorResponse({ error: 'err', success: false }), true);
  });

  it('should assert correctly', () => {
    assert.doesNotThrow(() => guards.assertString('hello'));
    assert.throws(() => guards.assertString(123), TypeError);
    assert.doesNotThrow(() => guards.assertNonEmptyString('hi'));
    assert.throws(() => guards.assertNonEmptyString(''), TypeError);
  });
});

// ──────────── Phase 3: Process Roles ────────────
const { ROLES, ProcessRoleManager, WorkerPool } = require('../src/core/process-roles');

describe('ProcessRoles', () => {
  it('should define 4 roles', () => {
    assert.ok(ROLES.CHANNEL);
    assert.ok(ROLES.WORKER);
    assert.ok(ROLES.COMPACTOR);
    assert.ok(ROLES.CORTEX);
  });

  it('should check enabled roles', () => {
    const mgr = new ProcessRoleManager({ roles: ['channel', 'worker'] });
    assert.equal(mgr.isEnabled('channel'), true);
    assert.equal(mgr.isEnabled('compactor'), false);
  });

  it('should check feature availability', () => {
    const mgr = new ProcessRoleManager({ roles: ['channel'] });
    assert.equal(mgr.hasFeature('http'), true);
    assert.equal(mgr.hasFeature('tools'), false); // tools are WORKER feature
  });

  it('should return default models per role', () => {
    const mgr = new ProcessRoleManager();
    const channelModel = mgr.getDefaultModel('channel');
    assert.ok(channelModel.includes('sonnet'));
    const workerModel = mgr.getDefaultModel('worker');
    assert.ok(workerModel.includes('opus'));
  });
});

describe('WorkerPool', () => {
  it('should initialize with correct defaults', () => {
    const pool = new WorkerPool({ maxWorkers: 2 });
    assert.equal(pool.maxWorkers, 2);
    assert.equal(pool.activeCount, 0);
    assert.equal(pool.queueLength, 0);
  });

  it('should track stats', () => {
    const pool = new WorkerPool();
    assert.equal(pool.stats.tasksCompleted, 0);
    assert.equal(pool.stats.errors, 0);
  });
});
