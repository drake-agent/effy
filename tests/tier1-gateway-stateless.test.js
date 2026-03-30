/**
 * tier1-gateway-stateless.test.js — Phase 3: Gateway Stateless Refactor tests.
 *
 * Tests the adapter layer that bridges StateBackendFactory instances
 * to the Gateway-compatible API surface.
 *
 * Suites:
 * 1. GatewayWorkingMemory — add/get/clear/replace/maybeSummarize
 * 2. GatewayConcurrencyGovernor — waitForSlot/release/stats
 * 3. GatewayStateBridge — factory integration + lifecycle
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── Mock StateBackendFactory (no Redis) ───
// We test with the real Local* fallbacks from state-backend.js
const {
  LocalWorkingMemory,
  LocalConcurrencyGovernor,
  LocalRateLimiter,
  LocalCircuitBreakerState,
} = require('../src/state/state-backend');

// The adapters we'll build
const {
  GatewayWorkingMemory,
  GatewayConcurrencyGovernor,
  GatewayStateBridge,
} = require('../src/gateway/state-adapters');

// ═══════════════════════════════════════════════════════════════
// Suite 1: GatewayWorkingMemory
// ═══════════════════════════════════════════════════════════════

describe('GatewayWorkingMemory', () => {
  let wm;

  beforeEach(() => {
    const backend = new LocalWorkingMemory({ ttlSec: 1800, maxEntries: 50 });
    wm = new GatewayWorkingMemory(backend);
  });

  it('add() stores and get() retrieves entries as array', async () => {
    wm.add('conv:1', { role: 'user', content: 'hello' });
    // add is fire-and-forget but internally async — wait a tick
    await new Promise(r => setImmediate(r));
    const entries = wm.get('conv:1');
    assert.ok(Array.isArray(entries), 'get() should return an array');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].role, 'user');
    assert.equal(entries[0].content, 'hello');
  });

  it('get() returns empty array for unknown conversation', () => {
    const entries = wm.get('nonexistent');
    assert.ok(Array.isArray(entries));
    assert.equal(entries.length, 0);
  });

  it('add() appends multiple entries in order', async () => {
    wm.add('conv:1', { role: 'user', content: 'msg1' });
    wm.add('conv:1', { role: 'assistant', content: 'reply1' });
    wm.add('conv:1', { role: 'user', content: 'msg2' });
    await new Promise(r => setImmediate(r));
    const entries = wm.get('conv:1');
    assert.equal(entries.length, 3);
    assert.equal(entries[0].content, 'msg1');
    assert.equal(entries[2].content, 'msg2');
  });

  it('clear() removes conversation data', async () => {
    wm.add('conv:1', { role: 'user', content: 'hello' });
    await new Promise(r => setImmediate(r));
    wm.clear('conv:1');
    const entries = wm.get('conv:1');
    assert.equal(entries.length, 0);
  });

  it('replace() substitutes all entries', async () => {
    wm.add('conv:1', { role: 'user', content: 'old1' });
    wm.add('conv:1', { role: 'assistant', content: 'old2' });
    await new Promise(r => setImmediate(r));

    wm.replace('conv:1', [
      { role: 'assistant', content: '[Summary] context' },
      { role: 'user', content: 'recent' },
    ]);
    await new Promise(r => setImmediate(r));

    const entries = wm.get('conv:1');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].content, '[Summary] context');
    assert.equal(entries[1].content, 'recent');
  });

  it('replace() works on non-existent conversation', async () => {
    wm.replace('new:conv', [{ role: 'user', content: 'fresh' }]);
    await new Promise(r => setImmediate(r));
    const entries = wm.get('new:conv');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'fresh');
  });

  it('tracks needsSummary flag', async () => {
    const backend = new LocalWorkingMemory({ ttlSec: 1800, maxEntries: 50 });
    // GatewayWorkingMemory triggers needsSummary when entries > summarizeThreshold (default 30)
    wm = new GatewayWorkingMemory(backend, { summarizeThreshold: 5 });

    // Add 6 entries (> threshold of 5 → should trigger needsSummary)
    for (let i = 0; i < 6; i++) {
      wm.add('conv:1', { role: i % 2 === 0 ? 'user' : 'assistant', content: `msg${i}` });
    }
    await new Promise(r => setImmediate(r));

    assert.equal(wm.needsSummary('conv:1'), true);
  });

  it('size property returns active conversation count', async () => {
    wm.add('conv:1', { role: 'user', content: 'a' });
    wm.add('conv:2', { role: 'user', content: 'b' });
    await new Promise(r => setImmediate(r));
    assert.equal(wm.size, 2);
  });

  it('destroy() clears all state', async () => {
    wm.add('conv:1', { role: 'user', content: 'a' });
    wm.add('conv:2', { role: 'user', content: 'b' });
    await new Promise(r => setImmediate(r));
    wm.destroy();
    assert.equal(wm.size, 0);
    assert.equal(wm.get('conv:1').length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 2: GatewayConcurrencyGovernor
// ═══════════════════════════════════════════════════════════════

describe('GatewayConcurrencyGovernor', () => {
  let gov;

  beforeEach(() => {
    const backend = new LocalConcurrencyGovernor({ global: 3, perUser: 2, perChannel: 2 });
    gov = new GatewayConcurrencyGovernor(backend);
  });

  it('waitForSlot() grants within limits', async () => {
    const result = await gov.waitForSlot('user1', 'ch1');
    assert.equal(result, true);
  });

  it('release() frees a slot', async () => {
    await gov.waitForSlot('user1', 'ch1');
    gov.release('user1', 'ch1');
    // Should be able to acquire again
    const result = await gov.waitForSlot('user1', 'ch1');
    assert.equal(result, true);
  });

  it('denies when per-user limit reached', async () => {
    await gov.waitForSlot('user1', 'ch1');
    await gov.waitForSlot('user1', 'ch2');
    // perUser=2, already at limit
    const result = await gov.waitForSlot('user1', 'ch3', 100); // short timeout
    assert.equal(result, false);
  });

  it('denies when global limit reached', async () => {
    await gov.waitForSlot('user1', 'ch1');
    await gov.waitForSlot('user2', 'ch2');
    await gov.waitForSlot('user3', 'ch3');
    // global=3, at limit
    const result = await gov.waitForSlot('user4', 'ch4', 100);
    assert.equal(result, false);
  });

  it('stats reports current counts', async () => {
    await gov.waitForSlot('user1', 'ch1');
    await gov.waitForSlot('user2', 'ch1');
    const stats = gov.stats;
    assert.equal(stats.global, 2);
  });

  it('different users with same channel work independently', async () => {
    await gov.waitForSlot('user1', 'ch1');
    const result = await gov.waitForSlot('user2', 'ch1');
    assert.equal(result, true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 3: GatewayStateBridge
// ═══════════════════════════════════════════════════════════════

describe('GatewayStateBridge', () => {
  it('creates all components from factory config', () => {
    const bridge = new GatewayStateBridge({
      concurrency: { global: 10, perUser: 2, perChannel: 3 },
      rateLimit: { windowMs: 60000, maxRequests: 30 },
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
    });

    assert.ok(bridge.workingMemory, 'should have workingMemory');
    assert.ok(bridge.governor, 'should have governor');
    assert.ok(bridge.rateLimiter, 'should have rateLimiter');
    assert.ok(bridge.circuitBreakerState, 'should have circuitBreakerState');
  });

  it('workingMemory provides Gateway-compatible API', () => {
    const bridge = new GatewayStateBridge({});
    const wm = bridge.workingMemory;

    assert.equal(typeof wm.add, 'function');
    assert.equal(typeof wm.get, 'function');
    assert.equal(typeof wm.clear, 'function');
    assert.equal(typeof wm.replace, 'function');
    assert.equal(typeof wm.destroy, 'function');
  });

  it('governor provides Gateway-compatible API', () => {
    const bridge = new GatewayStateBridge({});
    const gov = bridge.governor;

    assert.equal(typeof gov.waitForSlot, 'function');
    assert.equal(typeof gov.release, 'function');
  });

  it('shutdown() cleans up all resources', () => {
    const bridge = new GatewayStateBridge({});
    bridge.workingMemory.add('conv:1', { role: 'user', content: 'test' });
    bridge.shutdown();
    assert.equal(bridge.workingMemory.size, 0);
  });

  it('mode reports local when no Redis', () => {
    const bridge = new GatewayStateBridge({});
    assert.equal(bridge.mode, 'local');
  });

  it('end-to-end: WM add → get → clear lifecycle', async () => {
    const bridge = new GatewayStateBridge({});
    const wm = bridge.workingMemory;

    wm.add('sess:1', { role: 'user', content: 'input' });
    await new Promise(r => setImmediate(r));

    const entries = wm.get('sess:1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].content, 'input');

    wm.clear('sess:1');
    assert.equal(wm.get('sess:1').length, 0);

    bridge.shutdown();
  });

  it('end-to-end: Governor acquire → release lifecycle', async () => {
    const bridge = new GatewayStateBridge({
      concurrency: { global: 2, perUser: 1, perChannel: 2 },
    });
    const gov = bridge.governor;

    const ok1 = await gov.waitForSlot('user1', 'ch1');
    assert.equal(ok1, true);

    // user1 at perUser limit
    const ok2 = await gov.waitForSlot('user1', 'ch2', 100);
    assert.equal(ok2, false);

    // release and retry
    gov.release('user1', 'ch1');
    const ok3 = await gov.waitForSlot('user1', 'ch2');
    assert.equal(ok3, true);

    bridge.shutdown();
  });
});
