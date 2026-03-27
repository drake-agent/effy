/**
 * tier1-loop-guard.test.js — LoopGuard 유닛 테스트
 * 해시 포이즈닝 방어, ping-pong 사이클, 관찰 도구 예외 등 검증
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { LoopGuard } = require('../src/core/loop-guard');

describe('LoopGuard', () => {
  // ──────────── 기본 기능 ────────────
  it('should return continue for first call', () => {
    const guard = new LoopGuard();
    const result = guard.check('agent1', 'tool_a', 'hash1');
    assert.equal(result, 'continue');
  });

  it('should warn when approaching repetition limit', () => {
    const guard = new LoopGuard({ maxRepetitions: 3 });
    guard.check('a1', 'tool_a', 'same_input');
    guard.check('a1', 'tool_a', 'same_input');
    // 3번째 = maxRepetitions - 1 도달 → warn
    const result = guard.check('a1', 'tool_a', 'same_input');
    // After 2 stored + 1 new check, repetitionCount=2 which is maxRepetitions-1 → warn
    assert.equal(result, 'warn');
  });

  it('should break when exceeding repetition limit', () => {
    const guard = new LoopGuard({ maxRepetitions: 2, maxDepth: 20 });
    guard.check('a1', 'tool_a', 'same_input');
    guard.check('a1', 'tool_b', 'other'); // avoid same-tool triple
    guard.check('a1', 'tool_a', 'same_input');
    const result = guard.check('a1', 'tool_a', 'same_input');
    assert.equal(result, 'break');
  });

  it('should escalate on depth limit', () => {
    const guard = new LoopGuard({ maxDepth: 3 });
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_b', 'h2');
    guard.check('a1', 'tool_c', 'h3');
    const result = guard.check('a1', 'tool_d', 'h4');
    assert.equal(result, 'escalate');
  });

  it('should break on time limit', () => {
    const guard = new LoopGuard({ maxDurationMs: 1 });
    guard.check('a1', 'tool_a', 'h1');
    // Force time passage
    const chain = guard.callChains.get('a1');
    chain[0].timestamp = Date.now() - 1000;
    const result = guard.check('a1', 'tool_b', 'h2');
    assert.equal(result, 'break');
  });

  // ──────────── SHA256 해시 ────────────
  it('should use SHA256 for hashInput', () => {
    const h1 = LoopGuard.hashInput('test');
    const h2 = LoopGuard.hashInput('test');
    assert.equal(h1, h2);
    assert.equal(h1.length, 16); // hex truncated to 16 chars
    assert.match(h1, /^[0-9a-f]{16}$/);
  });

  it('should produce different hashes for different inputs', () => {
    const h1 = LoopGuard.hashInput('input_a');
    const h2 = LoopGuard.hashInput('input_b');
    assert.notEqual(h1, h2);
  });

  it('should handle object input for hashInput', () => {
    const h = LoopGuard.hashInput({ key: 'value', nested: [1, 2] });
    assert.match(h, /^[0-9a-f]{16}$/);
  });

  // ──────────── Ping-pong 사이클 감지 ────────────
  it('should detect 2-element ping-pong cycle (A→B→A→B)', () => {
    const guard = new LoopGuard({ maxRepetitions: 10, maxDepth: 20 });
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_b', 'h2');
    guard.check('a1', 'tool_a', 'h3');
    const result = guard.check('a1', 'tool_b', 'h4');
    assert.equal(result, 'break'); // 2-element → break
    assert.equal(guard.stats.pingPongDetections, 1);
  });

  it('should detect 3-element ping-pong cycle (A→B→C→A→B→C)', () => {
    const guard = new LoopGuard({ maxRepetitions: 10, maxDepth: 20 });
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_b', 'h2');
    guard.check('a1', 'tool_c', 'h3');
    guard.check('a1', 'tool_a', 'h4');
    guard.check('a1', 'tool_b', 'h5');
    const result = guard.check('a1', 'tool_c', 'h6');
    assert.equal(result, 'warn'); // 3-element → warn
    assert.equal(guard.stats.pingPongDetections, 1);
  });

  it('should not false-positive on non-repeating sequences', () => {
    const guard = new LoopGuard({ maxRepetitions: 10, maxDepth: 20 });
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_b', 'h2');
    guard.check('a1', 'tool_c', 'h3');
    const result = guard.check('a1', 'tool_d', 'h4');
    assert.equal(result, 'continue');
    assert.equal(guard.stats.pingPongDetections, 0);
  });

  // ──────────── 관찰 도구 예외 ────────────
  it('should skip observation tools', () => {
    const guard = new LoopGuard({ maxRepetitions: 1 });
    // memory_search는 관찰 도구 → 항상 continue
    for (let i = 0; i < 10; i++) {
      assert.equal(guard.check('a1', 'memory_search', 'same'), 'continue');
    }
    assert.equal(guard.stats.totalChecks, 10);
    // 체인에 추가되지 않았으므로 비어있어야 함
    assert.equal(guard.getChain('a1').length, 0);
  });

  it('should allow custom observation tools', () => {
    const guard = new LoopGuard({
      maxRepetitions: 1,
      observationTools: ['my_custom_viewer'],
    });
    assert.equal(guard.check('a1', 'my_custom_viewer', 'x'), 'continue');
    assert.equal(guard.check('a1', 'my_custom_viewer', 'x'), 'continue');
  });

  // ──────────── 리셋 ────────────
  it('should reset agent chain', () => {
    const guard = new LoopGuard();
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_b', 'h2');
    assert.equal(guard.getChain('a1').length, 2);
    guard.reset('a1');
    assert.equal(guard.getChain('a1').length, 0);
  });

  it('should reset all agents', () => {
    const guard = new LoopGuard();
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a2', 'tool_b', 'h2');
    guard.resetAll();
    assert.equal(guard.getStats().activeAgents, 0);
  });

  // ──────────── 통계 ────────────
  it('should track stats correctly', () => {
    const guard = new LoopGuard({ maxRepetitions: 2, maxDepth: 20 });
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_b', 'h2'); // interleave to avoid same-tool triple
    guard.check('a1', 'tool_a', 'h1');
    guard.check('a1', 'tool_c', 'h3');
    const result = guard.check('a1', 'tool_a', 'h1'); // 3rd with same hash → break
    assert.equal(result, 'break');
    const stats = guard.getStats();
    assert.equal(stats.totalChecks, 5);
    assert.ok(stats.breaks >= 1);
  });
});
