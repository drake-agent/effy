/**
 * Tier 1 — Binding Router Tests.
 *
 * 순수 로직: 바인딩 매칭 우선순위 검증.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { BindingRouter } = require('../src/gateway/binding-router');

function makeMsg({ senderId, channelId, accountId, channelType } = {}) {
  return {
    sender: { id: senderId || 'U1' },
    channel: {
      channelId: channelId || 'C1',
      accountId: accountId || 'T1',
      type: channelType || 'slack',
    },
  };
}

describe('BindingRouter — Priority Matching', () => {
  const bindings = [
    { agentId: 'code', match: { channel: 'slack', channelId: 'C_eng' } },
    { agentId: 'ops', match: { channel: 'slack', channelId: 'C_ops' } },
    { agentId: 'strategy', match: { peer: 'U_CEO' } },
    { agentId: 'knowledge', match: { channel: 'discord' } },
  ];
  const router = new BindingRouter(bindings, 'general');

  it('should match peer binding (highest priority)', () => {
    const result = router.match(makeMsg({ senderId: 'U_CEO', channelId: 'C_eng' }));
    assert.equal(result.agentId, 'strategy', 'peer > channelId');
  });

  it('should match channelId binding', () => {
    const result = router.match(makeMsg({ channelId: 'C_eng' }));
    assert.equal(result.agentId, 'code');
  });

  it('should match channelId with type constraint', () => {
    // C_eng binding has channel: 'slack', so discord won't match
    const result = router.match(makeMsg({ channelId: 'C_eng', channelType: 'discord' }));
    assert.equal(result.agentId, 'knowledge', 'type mismatch should fall through to type-level');
  });

  it('should match channel type binding', () => {
    const result = router.match(makeMsg({ channelId: 'C_unknown', channelType: 'discord' }));
    assert.equal(result.agentId, 'knowledge');
  });

  it('should return default when nothing matches', () => {
    const result = router.match(makeMsg({ channelId: 'C_xyz', channelType: 'webhook' }));
    assert.equal(result.agentId, 'general');
    assert.equal(result.binding, null);
  });
});

describe('BindingRouter — Edge Cases', () => {
  it('should work with empty bindings', () => {
    const router = new BindingRouter([], 'fallback');
    const result = router.match(makeMsg());
    assert.equal(result.agentId, 'fallback');
  });

  it('should work with custom default agent', () => {
    const router = new BindingRouter([], 'custom_default');
    const result = router.match(makeMsg());
    assert.equal(result.agentId, 'custom_default');
  });
});
