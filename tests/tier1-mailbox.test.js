/**
 * tier1-mailbox.test.js — AgentMailbox 단위 테스트.
 *
 * 3 Suites:
 * 1. 기본 send/receive 동작 (6 tests)
 * 2. 큐 상한 및 overflow (4 tests)
 * 3. 싱글톤 관리 (3 tests)
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { AgentMailbox, getAgentMailbox, resetAgentMailbox } = require('../src/agents/mailbox');

// ═══════════════════════════════════════════════════════
// Suite 1: 기본 send/receive 동작
// ═══════════════════════════════════════════════════════

describe('AgentMailbox — Basic send/receive', () => {
  let mailbox;

  beforeEach(() => {
    mailbox = new AgentMailbox();
  });

  it('should send a message and receive it', () => {
    const result = mailbox.send({ from: 'ops', to: 'general', message: 'Hello' });
    assert.ok(result.success);
    assert.ok(result.id);

    const msgs = mailbox.receive('general');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, 'ops');
    assert.equal(msgs[0].message, 'Hello');
  });

  it('should return empty array for agent with no messages', () => {
    const msgs = mailbox.receive('nonexistent');
    assert.deepEqual(msgs, []);
  });

  it('should deliver messages in FIFO order', () => {
    mailbox.send({ from: 'a', to: 'target', message: 'first' });
    mailbox.send({ from: 'b', to: 'target', message: 'second' });
    mailbox.send({ from: 'c', to: 'target', message: 'third' });

    const msgs = mailbox.receive('target');
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].message, 'first');
    assert.equal(msgs[1].message, 'second');
    assert.equal(msgs[2].message, 'third');
  });

  it('should remove messages from queue after receive', () => {
    mailbox.send({ from: 'ops', to: 'general', message: 'msg1' });
    mailbox.receive('general');
    const second = mailbox.receive('general');
    assert.equal(second.length, 0);
  });

  it('should peek without removing', () => {
    mailbox.send({ from: 'ops', to: 'general', message: 'peek me' });
    const peeked = mailbox.peek('general');
    assert.equal(peeked.length, 1);

    // Still available after peek
    const received = mailbox.receive('general');
    assert.equal(received.length, 1);
  });

  it('should reject messages without required fields', () => {
    const r1 = mailbox.send(null);
    assert.ok(!r1.success);

    const r2 = mailbox.send({ from: 'ops', to: 'general' });
    assert.ok(!r2.success);

    const r3 = mailbox.send({ from: 'ops', message: 'no target' });
    assert.ok(!r3.success);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: 큐 상한 및 overflow
// ═══════════════════════════════════════════════════════

describe('AgentMailbox — Queue limits', () => {
  let mailbox;

  beforeEach(() => {
    mailbox = new AgentMailbox();
  });

  it('should report correct size', () => {
    mailbox.send({ from: 'a', to: 'general', message: '1' });
    mailbox.send({ from: 'a', to: 'general', message: '2' });
    mailbox.send({ from: 'a', to: 'ops', message: '3' });

    assert.equal(mailbox.size(), 3);
    assert.equal(mailbox.size('general'), 2);
    assert.equal(mailbox.size('ops'), 1);
  });

  it('should drop oldest when per-agent limit exceeded', () => {
    // MAX_PER_AGENT is 50
    for (let i = 0; i < 55; i++) {
      mailbox.send({ from: 'a', to: 'target', message: `msg-${i}` });
    }

    assert.equal(mailbox.size('target'), 50);
    // Oldest 5 should have been dropped
    const msgs = mailbox.peek('target');
    assert.equal(msgs[0].message, 'msg-5');
  });

  it('should receive limited number of messages', () => {
    for (let i = 0; i < 10; i++) {
      mailbox.send({ from: 'a', to: 'target', message: `msg-${i}` });
    }

    const first3 = mailbox.receive('target', 3);
    assert.equal(first3.length, 3);
    assert.equal(first3[0].message, 'msg-0');
    assert.equal(first3[2].message, 'msg-2');

    // Remaining 7 still in queue
    assert.equal(mailbox.size('target'), 7);
  });

  it('should clear all queues', () => {
    mailbox.send({ from: 'a', to: 'general', message: '1' });
    mailbox.send({ from: 'a', to: 'ops', message: '2' });

    mailbox.clear();
    assert.equal(mailbox.size(), 0);
    assert.deepEqual(mailbox.receive('general'), []);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: 싱글톤 관리
// ═══════════════════════════════════════════════════════

describe('AgentMailbox — Singleton', () => {
  beforeEach(() => {
    resetAgentMailbox();
  });

  it('should return same instance from getAgentMailbox', () => {
    const a = getAgentMailbox();
    const b = getAgentMailbox();
    assert.strictEqual(a, b);
  });

  it('should reset singleton and create new instance', () => {
    const a = getAgentMailbox();
    a.send({ from: 'x', to: 'y', message: 'test' });

    resetAgentMailbox();
    const b = getAgentMailbox();
    assert.notStrictEqual(a, b);
    assert.equal(b.size(), 0);
  });

  it('should preserve messages across getAgentMailbox calls', () => {
    const mb = getAgentMailbox();
    mb.send({ from: 'ops', to: 'general', message: 'hello' });

    // Same instance, message should be there
    const mb2 = getAgentMailbox();
    assert.equal(mb2.size('general'), 1);
  });
});
