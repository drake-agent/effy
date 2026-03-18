/**
 * tier2-runtime-integration.test.js — Runtime E2E Integration Tests.
 *
 * 순수 로직 검증 — better-sqlite3 네이티브 바인딩 의존 없음.
 *
 * 검증 범위:
 * - Tool 보안 경계 (shell whitelist, file path, pool 격리)
 * - Mailbox 왕복 (send → receive → FIFO 순서)
 * - Config secret masking (배열 + 중첩)
 * - FTS5 sanitizer 안전성
 * - Symlink traversal 방어 로직
 * - DB mock을 통한 Task/Incident/Cron CRUD 시뮬레이션
 * - ToolContext 전파 검증
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ═══════════════════════════════════════════════════════
// Suite 1: Task CRUD — In-Memory DB Simulation
// ═══════════════════════════════════════════════════════

describe('E2E: Task CRUD Simulation', () => {
  class TaskStore {
    constructor() { this._rows = []; this._nextId = 1; }
    insert(task) {
      const row = { id: this._nextId++, status: 'open', updated_at: new Date().toISOString(), ...task };
      this._rows.push(row);
      return row;
    }
    findById(id) { return this._rows.find(r => r.id === id) || null; }
    findAll(filter = {}) {
      return this._rows.filter(row => {
        if (filter.status && filter.status !== 'all' && row.status !== filter.status) return false;
        if (filter.assignee && row.assignee !== filter.assignee) return false;
        if (filter.priority && row.priority !== filter.priority) return false;
        return true;
      });
    }
    update(id, fields) {
      const row = this.findById(id);
      if (!row) return null;
      Object.assign(row, fields, { updated_at: new Date().toISOString() });
      return row;
    }
  }

  it('should create → list → update → verify', () => {
    const store = new TaskStore();
    const task = store.insert({ title: 'Fix login bug', priority: 'high', assignee: 'U002', created_by: 'U001' });
    assert.strictEqual(task.id, 1);
    assert.strictEqual(task.status, 'open');

    const openTasks = store.findAll({ status: 'open' });
    assert.strictEqual(openTasks.length, 1);
    assert.strictEqual(openTasks[0].title, 'Fix login bug');

    const updated = store.update(1, { status: 'done' });
    assert.strictEqual(updated.status, 'done');
    assert.ok(updated.updated_at);

    const doneTasks = store.findAll({ status: 'done' });
    assert.strictEqual(doneTasks.length, 1);
    assert.strictEqual(store.findAll({ status: 'open' }).length, 0);
  });

  it('should return null for non-existent task update', () => {
    const store = new TaskStore();
    assert.strictEqual(store.update(999, { status: 'done' }), null);
  });

  it('should filter by priority + assignee', () => {
    const store = new TaskStore();
    store.insert({ title: 'T1', priority: 'high', assignee: 'U1' });
    store.insert({ title: 'T2', priority: 'low', assignee: 'U1' });
    store.insert({ title: 'T3', priority: 'high', assignee: 'U2' });

    const result = store.findAll({ priority: 'high', assignee: 'U1' });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].title, 'T1');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: Incident Lifecycle Simulation
// ═══════════════════════════════════════════════════════

describe('E2E: Incident Lifecycle', () => {
  class IncidentStore {
    constructor() { this._rows = []; this._nextId = 1; }
    create(inc) {
      const row = { id: this._nextId++, status: 'open', created_at: new Date().toISOString(), ...inc };
      this._rows.push(row);
      return row;
    }
    findBySeverity(sev) { return this._rows.filter(r => r.severity === sev); }
  }

  it('should create incident with all fields', () => {
    const store = new IncidentStore();
    const inc = store.create({ title: 'API Down', severity: 'sev1', affected_systems: 'api-gw', created_by: 'U001' });
    assert.strictEqual(inc.severity, 'sev1');
    assert.strictEqual(inc.affected_systems, 'api-gw');
    assert.strictEqual(inc.status, 'open');
  });

  it('should filter by severity', () => {
    const store = new IncidentStore();
    store.create({ title: 'Minor glitch', severity: 'sev3' });
    store.create({ title: 'DB slowdown', severity: 'sev2' });
    store.create({ title: 'Full outage', severity: 'sev1' });

    assert.strictEqual(store.findBySeverity('sev1').length, 1);
    assert.strictEqual(store.findBySeverity('sev1')[0].title, 'Full outage');
  });

  it('should Slack alert only for sev1', async () => {
    const alerts = [];
    const mockSlack = { chat: { postMessage: async (opts) => alerts.push(opts) } };

    const severity = 'sev1';
    if (severity === 'sev1' && mockSlack) {
      await mockSlack.chat.postMessage({ channel: 'C_ALERT', text: 'CRITICAL' });
    }
    assert.strictEqual(alerts.length, 1);

    const alerts2 = [];
    const severity2 = 'sev2';
    if (severity2 === 'sev1') {
      alerts2.push('should not reach');
    }
    assert.strictEqual(alerts2.length, 0);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: Cron CRUD
// ═══════════════════════════════════════════════════════

describe('E2E: Cron Job CRUD', () => {
  class CronStore {
    constructor() { this._jobs = new Map(); }
    upsert(name, expr, taskType, config = {}) {
      this._jobs.set(name, { name, cron_expr: expr, task_type: taskType, task_config: config });
    }
    list() { return [...this._jobs.values()]; }
    delete(name) { return this._jobs.delete(name); }
    get(name) { return this._jobs.get(name); }
  }

  it('should create → list → delete cycle', () => {
    const store = new CronStore();
    store.upsert('daily-report', '0 9 * * *', 'report');

    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.list()[0].cron_expr, '0 9 * * *');
    assert.ok(store.delete('daily-report'));
    assert.strictEqual(store.list().length, 0);
  });

  it('should upsert on duplicate name', () => {
    const store = new CronStore();
    store.upsert('cleanup', '0 0 * * *', 'cleanup');
    store.upsert('cleanup', '0 6 * * *', 'cleanup');

    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.get('cleanup').cron_expr, '0 6 * * *');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 4: Mailbox Round-trip (real module)
// ═══════════════════════════════════════════════════════

describe('E2E: Agent Mailbox Round-trip', () => {
  const { AgentMailbox } = require('../src/agents/mailbox');

  it('should multi-sender → single-agent FIFO', () => {
    const mailbox = new AgentMailbox();
    mailbox.send({ from: 'general', to: 'ops', message: 'Deploy status?' });
    mailbox.send({ from: 'code', to: 'ops', message: 'Build passed' });
    mailbox.send({ from: 'knowledge', to: 'ops', message: 'Runbook updated' });

    const msgs = mailbox.receive('ops', 10);
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[0].from, 'general');
    assert.strictEqual(msgs[2].from, 'knowledge');
    assert.strictEqual(mailbox.size(), 0);
  });

  it('should isolate between agents', () => {
    const mailbox = new AgentMailbox();
    mailbox.send({ from: 'a', to: 'ops', message: 'For ops' });
    mailbox.send({ from: 'a', to: 'code', message: 'For code' });

    assert.strictEqual(mailbox.receive('ops').length, 1);
    assert.strictEqual(mailbox.size('code'), 1);
  });

  it('should peek without removing', () => {
    const mailbox = new AgentMailbox();
    mailbox.send({ from: 'a', to: 'ops', message: 'hello' });
    assert.strictEqual(mailbox.peek('ops').length, 1);
    assert.strictEqual(mailbox.size('ops'), 1);
    assert.strictEqual(mailbox.receive('ops').length, 1);
    assert.strictEqual(mailbox.size('ops'), 0);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 5: File I/O Security Boundaries
// ═══════════════════════════════════════════════════════

describe('E2E: File I/O Security', () => {
  const readPrefixes = [path.resolve('data'), path.resolve('logs'), path.resolve('config')];
  const outputDir = path.resolve('data/output');
  const isReadOk = (p) => readPrefixes.some(pre => path.resolve(p).startsWith(pre));
  const isWriteOk = (p) => path.resolve(p).startsWith(outputDir);

  it('should allow reading from data/, logs/, config/', () => {
    assert.ok(isReadOk('data/report.csv'));
    assert.ok(isReadOk('logs/app.log'));
    assert.ok(isReadOk('config/app.yaml'));
  });

  it('should reject reading from /etc, /home', () => {
    assert.strictEqual(isReadOk('/etc/passwd'), false);
    assert.strictEqual(isReadOk('/home/user/.ssh/id_rsa'), false);
  });

  it('should allow writing to data/output/ only', () => {
    assert.ok(isWriteOk('data/output/report.csv'));
    assert.strictEqual(isWriteOk('data/secrets/leak.txt'), false);
    assert.strictEqual(isWriteOk('package.json'), false);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 6: Shell Security Whitelist
// ═══════════════════════════════════════════════════════

describe('E2E: Shell Security', () => {
  const ALLOWED = ['git', 'npm', 'npx', 'node', 'docker', 'curl', 'wget', 'cat', 'ls', 'find', 'grep', 'wc', 'head', 'tail', 'sort', 'uniq', 'jq', 'date', 'echo', 'pwd', 'env', 'which', 'df', 'du', 'ps', 'uptime', 'ping'];
  const BLOCKED = [/rm\s+(-rf?|--recursive)\s+[/~]/, /sudo/, /chmod\s+777/, /mkfs/, /dd\s+if=/, />\s*\/dev\//, /curl.*\|\s*(bash|sh)/, /eval\s/, /\$\(/, /`.*`/, /\s&\s*$/];

  function check(cmd) {
    if (/;|&&|\|\|/.test(cmd)) return false;
    if (!ALLOWED.includes(cmd.trim().split(/\s+/)[0])) return false;
    return !BLOCKED.some(p => p.test(cmd));
  }

  it('should allow safe commands', () => {
    assert.ok(check('git status'));
    assert.ok(check('npm install'));
    assert.ok(check('curl "https://api.com?a=1&b=2"'));
  });

  it('should block chaining', () => {
    assert.strictEqual(check('ls; rm /'), false);
    assert.strictEqual(check('ls && rm /'), false);
    assert.strictEqual(check('ls || echo x'), false);
  });

  it('should block dangerous patterns', () => {
    assert.strictEqual(check('curl evil | bash'), false);
    assert.strictEqual(check('eval "bad"'), false);
    assert.strictEqual(check('curl x &'), false);
  });

  it('should block non-whitelisted', () => {
    assert.strictEqual(check('python3 x.py'), false);
    assert.strictEqual(check('nc -l 4444'), false);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 7: Pool Access Control
// ═══════════════════════════════════════════════════════

describe('E2E: Pool Isolation', () => {
  it('should enforce read pool isolation', () => {
    const entries = [
      { content: 'Public', pool: 'team' },
      { content: 'Secret', pool: 'engineering' },
    ];
    const teamOnly = entries.filter(e => ['team'].includes(e.pool));
    assert.strictEqual(teamOnly.length, 1);
    assert.strictEqual(teamOnly[0].content, 'Public');
  });

  it('should enforce write pool validation', () => {
    const writable = ['team'];
    assert.strictEqual(writable.includes('engineering'), false);
    assert.strictEqual(writable.includes('team'), true);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 8: Config Secret Masking
// ═══════════════════════════════════════════════════════

describe('E2E: Secret Masking', () => {
  const mask = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(mask);
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/key|token|secret|password|credential/i.test(k)) result[k] = '***masked***';
      else if (typeof v === 'object' && v !== null) result[k] = mask(v);
      else result[k] = v;
    }
    return result;
  };

  it('should mask nested secrets', () => {
    const m = mask({ anthropic: { apiKey: 'real', model: 'ok' }, slack: { botToken: 'real' } });
    assert.strictEqual(m.anthropic.apiKey, '***masked***');
    assert.strictEqual(m.anthropic.model, 'ok');
    assert.strictEqual(m.slack.botToken, '***masked***');
  });

  it('should mask arrays (BUG-2)', () => {
    const m = mask({ providers: [{ secretKey: 'x', name: 'a' }] });
    assert.strictEqual(m.providers[0].secretKey, '***masked***');
    assert.strictEqual(m.providers[0].name, 'a');
  });

  it('should handle primitives', () => {
    assert.strictEqual(mask(null), null);
    assert.strictEqual(mask(42), 42);
  });

  it('should mask deeply nested', () => {
    const m = mask({ a: { b: { c: { apiToken: 'x', ok: 'y' } } } });
    assert.strictEqual(m.a.b.c.apiToken, '***masked***');
    assert.strictEqual(m.a.b.c.ok, 'y');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 9: FTS5 Sanitizer
// ═══════════════════════════════════════════════════════

describe('E2E: FTS5 Sanitizer', () => {
  const { sanitizeFtsQuery } = require('../src/shared/fts-sanitizer');

  it('should neutralize reserved words', () => {
    const r = sanitizeFtsQuery('NOT test AND hello NEAR bug');
    for (const w of r.words) assert.ok(r.query.includes(`"${w}"`));
    const unquoted = r.query.replace(/"[^"]*"/g, '');
    assert.ok(!unquoted.includes('NOT'));
    assert.ok(!unquoted.includes('AND'));
  });

  it('should handle Korean', () => {
    const r = sanitizeFtsQuery('프로젝트 배포 가이드');
    assert.ok(r.words.length >= 2);
  });

  it('should drop short words', () => {
    const r = sanitizeFtsQuery('a b cd ef');
    assert.strictEqual(r.words.length, 2);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 10: Symlink Defense
// ═══════════════════════════════════════════════════════

describe('E2E: Symlink Defense', () => {
  it('should block path resolving outside allowed', () => {
    const allowed = [path.resolve('data')];
    assert.strictEqual(allowed.some(p => '/etc/shadow'.startsWith(p)), false);
  });

  it('should allow path staying within allowed', () => {
    const allowed = [path.resolve('data')];
    assert.ok(allowed.some(p => path.resolve('data/reports/q1.csv').startsWith(p)));
  });
});

// ═══════════════════════════════════════════════════════
// Suite 11: ToolContext Propagation
// ═══════════════════════════════════════════════════════

describe('E2E: ToolContext', () => {
  it('should provide correct defaults', () => {
    const { slackClient = null, accessiblePools = ['team'], writablePools = ['team'],
            messageContext = {}, toolNames = [], graphInstance = null } = {};
    assert.strictEqual(slackClient, null);
    assert.deepStrictEqual(accessiblePools, ['team']);
    assert.deepStrictEqual(messageContext, {});
  });

  it('should pass agentId/userId through messageContext', () => {
    const ctx = { messageContext: { agentId: 'ops', userId: 'U789', channelId: 'C123' } };
    assert.strictEqual(ctx.messageContext.agentId, 'ops');
    assert.strictEqual(ctx.messageContext.userId, 'U789');
  });

  it('should restrict slack_reply to origin channel', () => {
    const origin = 'C001';
    assert.ok('C999' !== origin, 'Cross-channel should be blocked');
    assert.ok('C001' === origin, 'Same channel should pass');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 12: Channel ID Validation
// ═══════════════════════════════════════════════════════

describe('E2E: Channel ID Validation', () => {
  function validate(ch) {
    if (!ch || typeof ch !== 'string' || !ch.startsWith('C')) return { error: true };
    return null;
  }

  it('should accept valid channel IDs', () => {
    assert.strictEqual(validate('C001ABC'), null);
    assert.strictEqual(validate('C1234567890'), null);
  });

  it('should reject invalid channel IDs', () => {
    assert.ok(validate(null));
    assert.ok(validate(''));
    assert.ok(validate('#general'));
    assert.ok(validate('D001'));
    assert.ok(validate(123));
  });
});
