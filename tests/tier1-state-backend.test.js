/**
 * tier1-state-backend.test.js — v4.0 State backend tests (local fallback mode).
 *
 * Tests all local implementations that don't require Redis.
 * Redis-backed tests require integration environment (tier2).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  StateBackendFactory,
  LocalWorkingMemory,
  LocalConcurrencyGovernor,
  LocalRateLimiter,
  LocalCircuitBreakerState,
  LocalEmbeddingCache,
} = require('../src/state');

// ─── StateBackendFactory ───

describe('StateBackendFactory', () => {
  it('initializes in local mode without Redis config', async () => {
    const factory = new StateBackendFactory({});
    await factory.initialize();
    assert.equal(factory.mode, 'local');
    await factory.shutdown();
  });

  it('creates all module instances', async () => {
    const factory = new StateBackendFactory({});
    await factory.initialize();

    const wm = factory.createWorkingMemory();
    const cc = factory.createConcurrencyGovernor();
    const rl = factory.createRateLimiter();
    const cb = factory.createCircuitBreaker();
    const ec = factory.createEmbeddingCache();

    assert.ok(wm instanceof LocalWorkingMemory);
    assert.ok(cc instanceof LocalConcurrencyGovernor);
    assert.ok(rl instanceof LocalRateLimiter);
    assert.ok(cb instanceof LocalCircuitBreakerState);
    assert.ok(ec instanceof LocalEmbeddingCache);

    await factory.shutdown();
  });
});

// ─── LocalWorkingMemory ───

describe('LocalWorkingMemory', () => {
  let wm;
  beforeEach(() => { wm = new LocalWorkingMemory({ ttlSec: 5, maxEntries: 3 }); });

  it('append and get entries', async () => {
    await wm.append('conv1', { role: 'user', content: 'hello' });
    await wm.append('conv1', { role: 'assistant', content: 'hi' });

    const data = await wm.get('conv1');
    assert.ok(data);
    assert.equal(data.entries.length, 2);
    assert.equal(data.entries[0].role, 'user');
  });

  it('trims entries beyond maxEntries', async () => {
    await wm.append('conv1', { role: 'user', content: '1' });
    await wm.append('conv1', { role: 'assistant', content: '2' });
    await wm.append('conv1', { role: 'user', content: '3' });
    await wm.append('conv1', { role: 'assistant', content: '4' });

    const data = await wm.get('conv1');
    assert.equal(data.entries.length, 3);  // Max 3
    assert.equal(data.entries[0].content, '2');  // Oldest trimmed
  });

  it('sets needsSummary at 80% capacity', async () => {
    await wm.append('conv1', { role: 'user', content: '1' });
    await wm.append('conv1', { role: 'assistant', content: '2' });
    await wm.append('conv1', { role: 'user', content: '3' });

    const data = await wm.get('conv1');
    assert.equal(data.needsSummary, true);  // 3/3 > 80%
  });

  it('clear removes conversation', async () => {
    await wm.append('conv1', { role: 'user', content: 'hello' });
    await wm.clear('conv1');
    const data = await wm.get('conv1');
    assert.equal(data, null);
  });

  it('get returns null for unknown conversation', async () => {
    const data = await wm.get('unknown');
    assert.equal(data, null);
  });

  it('listActive returns active keys', async () => {
    await wm.append('conv1', { role: 'user', content: 'a' });
    await wm.append('conv2', { role: 'user', content: 'b' });
    const keys = await wm.listActive();
    assert.ok(keys.includes('conv1'));
    assert.ok(keys.includes('conv2'));
  });
});

// ─── LocalConcurrencyGovernor ───

describe('LocalConcurrencyGovernor', () => {
  let cc;
  beforeEach(() => { cc = new LocalConcurrencyGovernor({ global: 3, perUser: 2, perChannel: 2 }); });

  it('grants within limits', async () => {
    const result = await cc.acquire('req1', 'U1', 'C1');
    assert.equal(result.granted, true);
  });

  it('denies at global limit', async () => {
    await cc.acquire('req1', 'U1', 'C1');
    await cc.acquire('req2', 'U2', 'C2');
    await cc.acquire('req3', 'U3', 'C3');
    const result = await cc.acquire('req4', 'U4', 'C4');
    assert.equal(result.granted, false);
    assert.equal(result.reason, 'global_limit');
  });

  it('denies at per-user limit', async () => {
    await cc.acquire('req1', 'U1', 'C1');
    await cc.acquire('req2', 'U1', 'C2');
    const result = await cc.acquire('req3', 'U1', 'C3');
    assert.equal(result.granted, false);
    assert.equal(result.reason, 'user_limit');
  });

  it('release frees a slot', async () => {
    await cc.acquire('req1', 'U1', 'C1');
    await cc.acquire('req2', 'U2', 'C2');
    await cc.acquire('req3', 'U3', 'C3');

    const released = await cc.release('req1');
    assert.equal(released, true);

    const result = await cc.acquire('req4', 'U4', 'C4');
    assert.equal(result.granted, true);
  });

  it('release is idempotent', async () => {
    await cc.acquire('req1', 'U1', 'C1');
    await cc.release('req1');
    const result = await cc.release('req1');
    assert.equal(result, false);  // Already released
  });

  it('getStatus reports counts', async () => {
    await cc.acquire('req1', 'U1', 'C1');
    await cc.acquire('req2', 'U2', 'C2');
    const status = await cc.getStatus();
    assert.equal(status.globalActive, 2);
  });
});

// ─── LocalRateLimiter ───

describe('LocalRateLimiter', () => {
  let rl;
  beforeEach(() => { rl = new LocalRateLimiter({ windowMs: 1000, maxRequests: 3 }); });

  it('allows within limit', async () => {
    const r1 = await rl.check('U1', 'req1');
    assert.equal(r1.allowed, true);
    assert.equal(r1.remaining, 2);
  });

  it('blocks at limit', async () => {
    await rl.check('U1', 'req1');
    await rl.check('U1', 'req2');
    await rl.check('U1', 'req3');
    const r4 = await rl.check('U1', 'req4');
    assert.equal(r4.allowed, false);
    assert.equal(r4.remaining, 0);
    assert.ok(r4.retryAfterMs > 0);
  });

  it('different users have independent limits', async () => {
    await rl.check('U1', 'req1');
    await rl.check('U1', 'req2');
    await rl.check('U1', 'req3');

    const r = await rl.check('U2', 'req4');
    assert.equal(r.allowed, true);
  });

  it('reset clears user history', async () => {
    await rl.check('U1', 'req1');
    await rl.check('U1', 'req2');
    await rl.check('U1', 'req3');
    await rl.reset('U1');

    const r = await rl.check('U1', 'req4');
    assert.equal(r.allowed, true);
  });
});

// ─── LocalCircuitBreakerState ───

describe('LocalCircuitBreakerState', () => {
  let cb;
  beforeEach(() => { cb = new LocalCircuitBreakerState({ failureThreshold: 3, resetTimeoutMs: 100 }); });

  it('starts CLOSED', async () => {
    const open = await cb.isOpen('agent1');
    assert.equal(open, false);
  });

  it('opens after threshold failures', async () => {
    await cb.recordFailure('agent1', { category: 'network' });
    await cb.recordFailure('agent1', { category: 'network' });
    await cb.recordFailure('agent1', { category: 'network' });

    const open = await cb.isOpen('agent1');
    assert.equal(open, true);
  });

  it('transitions OPEN → HALF_OPEN after reset timeout', async () => {
    await cb.recordFailure('agent1', { category: 'network' });
    await cb.recordFailure('agent1', { category: 'network' });
    await cb.recordFailure('agent1', { category: 'network' });
    assert.equal(await cb.isOpen('agent1'), true);

    // Wait for reset timeout
    await new Promise(r => setTimeout(r, 150));
    assert.equal(await cb.isOpen('agent1'), false);  // HALF_OPEN allows traffic
  });

  it('success in HALF_OPEN closes circuit', async () => {
    await cb.recordFailure('a1', {});
    await cb.recordFailure('a1', {});
    await cb.recordFailure('a1', {});

    await new Promise(r => setTimeout(r, 150));
    await cb.isOpen('a1');  // triggers HALF_OPEN

    await cb.recordSuccess('a1');
    const state = await cb.getState('a1');
    assert.equal(state.state, 'CLOSED');
  });

  it('reset clears state', async () => {
    await cb.recordFailure('a1', {});
    await cb.recordFailure('a1', {});
    await cb.recordFailure('a1', {});
    await cb.reset('a1');

    assert.equal(await cb.isOpen('a1'), false);
  });
});

// ─── LocalEmbeddingCache ───

describe('LocalEmbeddingCache', () => {
  let ec;
  beforeEach(() => { ec = new LocalEmbeddingCache(); });

  it('returns null for miss', async () => {
    const result = await ec.get('hash1');
    assert.equal(result, null);
  });

  it('stores and retrieves embeddings', async () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    await ec.set('hash1', embedding);
    const result = await ec.get('hash1');
    assert.deepEqual(result, embedding);
  });

  it('tracks hit/miss stats', async () => {
    await ec.get('miss1');
    await ec.set('h1', new Float32Array([1]));
    await ec.get('h1');

    const stats = ec.getStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.localHits, 1);
  });

  it('invalidate removes entry', async () => {
    await ec.set('h1', new Float32Array([1]));
    await ec.invalidate('h1');
    const result = await ec.get('h1');
    assert.equal(result, null);
  });
});
