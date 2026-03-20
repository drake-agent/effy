const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('Lifecycle: Observer init/destroy', () => {
  const { Observer } = require('../src/observer');

  it('should clear previous timer on re-init and fully disable on enabled=false', () => {
    const observer = new Observer();
    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;

    const created = [];
    const cleared = [];

    try {
      global.setInterval = (fn, ms) => {
        const timer = { fn, ms, unref() {} };
        created.push(timer);
        return timer;
      };
      global.clearInterval = (timer) => {
        cleared.push(timer);
      };

      observer.init({ config: { detection: { intervalMs: 123 } } });
      observer.init({ config: { detection: { intervalMs: 456 } } });

      assert.strictEqual(created.length, 2);
      assert.strictEqual(cleared.length, 1, 're-init should clear previous interval');
      assert.strictEqual(observer._initialized, true);

      observer.init({ config: { enabled: false } });
      assert.strictEqual(observer._initialized, false);
      assert.strictEqual(observer.listener, null);
      assert.strictEqual(cleared.length, 2, 'disabling after init should clear active interval');
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      observer.destroy({ silent: true });
    }
  });
});

describe('Lifecycle: MorningBriefing / DocumentIngestion start idempotence', () => {
  const { MorningBriefing } = require('../src/features/morning-briefing');
  const { DocumentIngestion } = require('../src/features/doc-ingestion');

  it('should clear previous MorningBriefing timer when start() is called twice', () => {
    const briefing = new MorningBriefing({});
    briefing.enabled = true;

    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timers = [];
    const cleared = [];

    try {
      global.setTimeout = (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      };
      global.clearTimeout = (timer) => {
        cleared.push(timer);
      };

      briefing.start();
      briefing.start();

      assert.strictEqual(timers.length, 2);
      assert.strictEqual(cleared.length, 1);

      briefing.stop();
      assert.strictEqual(cleared.length, 2);
      assert.strictEqual(briefing._timer, null);
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }
  });

  it('should clear previous DocumentIngestion interval when start() is called twice', () => {
    const ingestion = new DocumentIngestion({
      config: {
        enabled: true,
        intervalMs: 123,
        sources: [{ id: 'local-docs', type: 'local', path: '/tmp/does-not-matter' }],
      },
    });
    ingestion.run = async () => {};

    const originalSetInterval = global.setInterval;
    const originalClearInterval = global.clearInterval;
    const created = [];
    const cleared = [];

    try {
      global.setInterval = (fn, ms) => {
        const timer = { fn, ms, unref() {} };
        created.push(timer);
        return timer;
      };
      global.clearInterval = (timer) => {
        cleared.push(timer);
      };

      ingestion.start();
      ingestion.start();

      assert.strictEqual(created.length, 2);
      assert.strictEqual(cleared.length, 1);
      assert.strictEqual(ingestion.intervalMs, 123, 'opts.config should take precedence');

      ingestion.stop();
      assert.strictEqual(cleared.length, 2);
      assert.strictEqual(ingestion._timer, null);
    } finally {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    }
  });
});

describe('WorkflowEngine: variable resolution edge cases', () => {
  const { WorkflowEngine } = require('../src/features/workflow-engine');

  it('should preserve quoted strings without corrupting JSON', () => {
    const engine = new WorkflowEngine({});
    const resolved = engine._resolveVariables(
      { text: 'Deploy note: ${note}' },
      { note: 'say "hello"\nand retry' },
    );

    assert.strictEqual(resolved.text, 'Deploy note: say "hello"\nand retry');
  });

  it('should inject non-string variables as real objects when the placeholder is standalone', () => {
    const engine = new WorkflowEngine({});
    const resolved = engine._resolveVariables(
      { payload: '${task_payload}', tags: ['${tag_obj}'] },
      {
        task_payload: { severity: 'sev1', owners: ['ops', 'code'] },
        tag_obj: { name: 'incident' },
      },
    );

    assert.deepStrictEqual(resolved.payload, { severity: 'sev1', owners: ['ops', 'code'] });
    assert.deepStrictEqual(resolved.tags, [{ name: 'incident' }]);
  });
});

describe('WorkflowEngine: execution context resolution', () => {
  const { WorkflowEngine } = require('../src/features/workflow-engine');
  const configModule = require('../src/config');
  const originalAgents = JSON.parse(JSON.stringify(configModule.config.agents || {}));

  beforeEach(() => {
    configModule.config.agents = {
      list: [
        {
          id: 'general',
          default: true,
          memory: { shared_read: ['team', 'design'], shared_write: ['team'] },
        },
        {
          id: 'ops',
          memory: { shared_read: ['team', 'engineering'], shared_write: ['team'] },
        },
        {
          id: 'code',
          memory: { shared_read: ['team', 'engineering'], shared_write: ['engineering'] },
        },
      ],
    };
  });

  afterEach(() => {
    configModule.config.agents = JSON.parse(JSON.stringify(originalAgents));
  });

  it('should derive the default agent and pool access from agent config', async () => {
    const calls = [];
    const engine = new WorkflowEngine({
      executeTool: async (tool, input, toolContext) => {
        calls.push({ tool, input, toolContext });
        return { ok: true };
      },
    });

    engine.register('default-scope', {
      steps: [{ tool: 'search_knowledge', input: { q: 'hello' } }],
    });

    await engine.execute('default-scope', { userId: 'U1', channelId: 'C1', threadId: 'T1' });

    assert.equal(calls.length, 1);
    assert.deepStrictEqual(calls[0].toolContext.messageContext, {
      userId: 'U1',
      channelId: 'C1',
      threadId: 'T1',
      agentId: 'general',
    });
    assert.deepStrictEqual(calls[0].toolContext.accessiblePools, ['team', 'design']);
    assert.deepStrictEqual(calls[0].toolContext.writablePools, ['team']);
  });

  it('should honor workflow and step overrides without falling back to ops/team', async () => {
    const calls = [];
    const engine = new WorkflowEngine({
      executeTool: async (tool, input, toolContext) => {
        calls.push({ tool, input, toolContext });
        return { ok: true };
      },
    });

    engine.register('incident', {
      agentId: 'ops',
      accessiblePools: ['workflow-read'],
      writablePools: ['workflow-write'],
      steps: [
        { tool: 'create_task', input: { title: 'triage' } },
        {
          tool: 'save_knowledge',
          agentId: 'code',
          accessiblePools: ['step-read'],
          writablePools: ['step-write'],
          input: { text: 'playbook' },
        },
      ],
    });

    await engine.execute('incident', {
      userId: 'U2',
      channelId: 'C2',
      accessiblePools: ['ctx-read'],
      writablePools: ['ctx-write'],
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].toolContext.messageContext.agentId, 'ops');
    assert.deepStrictEqual(calls[0].toolContext.accessiblePools, ['ctx-read']);
    assert.deepStrictEqual(calls[0].toolContext.writablePools, ['ctx-write']);
    assert.equal(calls[1].toolContext.messageContext.agentId, 'code');
    assert.deepStrictEqual(calls[1].toolContext.accessiblePools, ['step-read']);
    assert.deepStrictEqual(calls[1].toolContext.writablePools, ['step-write']);
  });
});
