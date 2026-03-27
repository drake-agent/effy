/**
 * tier3-v39-features.test.js — v3.9 신규 기능 테스트.
 *
 * Suite 1: DelegationTracer — 위임 체인 추적 + 요약
 * Suite 2: ActionRouter — Insight → 리더 알림 + 액션 추천
 * Suite 3: ProactiveEngine + ActionRouter 통합
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── Suite 1: DelegationTracer ───
describe('DelegationTracer', () => {
  let DelegationTracer, tracer;

  before(() => {
    ({ DelegationTracer } = require('../src/agents/delegation-tracer'));
  });

  beforeEach(() => {
    tracer = new DelegationTracer();
  });

  after(() => {
    if (tracer) tracer.destroy();
  });

  it('should start and complete a trace', () => {
    const traceId = tracer.startTrace('req-001', {
      userId: 'U001',
      channelId: 'C001',
      agentId: 'general',
      query: '마케팅팀 일정 알려줘',
    });

    assert.equal(traceId, 'req-001');

    tracer.addStep(traceId, {
      from: 'general',
      to: 'knowledge',
      query: '마케팅팀 일정 조회',
      response: '마케팅팀은 3월 15일 미팅 예정...',
      elapsed: 120,
      success: true,
    });

    tracer.addStep(traceId, {
      from: 'knowledge',
      to: 'ops',
      query: '캘린더 확인',
      response: '3/15 10:00 마케팅 전략 미팅',
      elapsed: 80,
      success: true,
    });

    tracer.completeTrace(traceId);

    const steps = tracer.getSteps(traceId);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].from, 'general');
    assert.equal(steps[0].to, 'knowledge');
    assert.equal(steps[1].from, 'knowledge');
    assert.equal(steps[1].to, 'ops');
  });

  it('should generate text summary', () => {
    const traceId = tracer.startTrace('req-002', { agentId: 'general' });

    tracer.addStep(traceId, { from: 'general', to: 'code', elapsed: 200, success: true });
    tracer.addStep(traceId, { from: 'code', to: 'ops', elapsed: 150, success: true });
    tracer.completeTrace(traceId);

    const summary = tracer.summarize(traceId, { format: 'text' });
    assert.ok(summary, 'Summary should not be null');
    assert.ok(summary.includes('general'), 'Should mention general agent');
    assert.ok(summary.includes('code'), 'Should mention code agent');
    assert.ok(summary.includes('ops'), 'Should mention ops agent');
    assert.ok(summary.includes('✅'), 'Should have success icons');
  });

  it('should generate markdown summary', () => {
    const traceId = tracer.startTrace('req-003', { agentId: 'general' });
    tracer.addStep(traceId, { from: 'general', to: 'strategy', elapsed: 300, success: true });
    tracer.completeTrace(traceId);

    const md = tracer.summarize(traceId, { format: 'markdown' });
    assert.ok(md.includes('Agent Delegation Chain'));
    assert.ok(md.includes('general'));
    assert.ok(md.includes('strategy'));
  });

  it('should generate Slack blocks', () => {
    const traceId = tracer.startTrace('req-004', { agentId: 'general' });
    tracer.addStep(traceId, { from: 'general', to: 'code', elapsed: 100, success: true });
    tracer.completeTrace(traceId);

    const blocks = tracer.summarize(traceId, { format: 'slack_blocks' });
    assert.ok(Array.isArray(blocks));
    assert.ok(blocks.length >= 2, 'Should have context + section blocks');
    assert.equal(blocks[0].type, 'context');
  });

  it('should return null for empty or missing trace', () => {
    assert.equal(tracer.summarize('nonexistent'), null);

    const traceId = tracer.startTrace('req-005');
    assert.equal(tracer.summarize(traceId), null); // no steps → null
  });

  it('should track failed steps', () => {
    const traceId = tracer.startTrace('req-006', { agentId: 'general' });
    tracer.addStep(traceId, { from: 'general', to: 'code', elapsed: 500, success: false });
    tracer.completeTrace(traceId);

    const steps = tracer.getSteps(traceId);
    assert.equal(steps[0].success, false);

    const summary = tracer.summarize(traceId, { format: 'text' });
    assert.ok(summary.includes('❌'));
  });

  it('should evict oldest when exceeding MAX_TRACES', () => {
    // Create 201 traces (MAX_TRACES = 200)
    for (let i = 0; i < 201; i++) {
      tracer.startTrace(`evict-${i}`);
    }
    // First one should have been evicted
    assert.equal(tracer.getSteps('evict-0'), null);
    assert.ok(tracer.getSteps('evict-200') !== null);
  });

  it('should attach to AgentBus events', () => {
    const EventEmitter = require('events').EventEmitter;
    const fakeBus = new EventEmitter();

    const traceId = tracer.startTrace('bus-test', { agentId: 'general' });
    tracer.attachToBus(fakeBus);

    // Simulate ask:complete
    fakeBus.emit('ask:complete', { from: 'general', to: 'code', elapsed: 100 });

    const steps = tracer.getSteps(traceId);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].from, 'general');
    assert.equal(steps[0].success, true);

    // Simulate ask:error
    fakeBus.emit('ask:error', { from: 'general', to: 'ops', elapsed: 50, error: 'timeout' });

    const steps2 = tracer.getSteps(traceId);
    assert.equal(steps2.length, 2);
    assert.equal(steps2[1].success, false);

    // Clean up the interval created by attachToBus
    tracer.destroy();
    // Re-create for subsequent tests
    tracer = new DelegationTracer();
  });

  it('should report stats', () => {
    tracer.startTrace('stat-1');
    tracer.startTrace('stat-2');
    tracer.completeTrace('stat-2');

    const stats = tracer.getStats();
    assert.equal(stats.totalTraces, 2);
    assert.equal(stats.activeTraces, 1);
    assert.equal(stats.completedTraces, 1);
  });
});

// ─── Suite 2: ActionRouter ───
describe('ActionRouter', () => {
  let ActionRouter, ACTION_TEMPLATES;

  before(() => {
    ({ ActionRouter, ACTION_TEMPLATES } = require('../src/observer/action-router'));
  });

  it('should have all expected insight type templates', () => {
    const types = ['goal_behind', 'milestone_risk', 'recurring_error', 'deployment_issue',
      'team_blocker', 'knowledge_gap', 'cross_team_conflict', 'default'];
    for (const t of types) {
      assert.ok(ACTION_TEMPLATES[t], `Missing template: ${t}`);
      assert.ok(ACTION_TEMPLATES[t].targetRoles.length > 0);
      assert.ok(ACTION_TEMPLATES[t].agentId);
      assert.ok(ACTION_TEMPLATES[t].urgency);
      assert.ok(ACTION_TEMPLATES[t].actionTemplate.includes('{{topic}}'));
    }
  });

  it('should suppress low confidence insights', async () => {
    const router = new ActionRouter({ config: { confidenceThreshold: 0.75 } });
    const result = await router.route({
      id: 'ins-1',
      type: 'goal_behind',
      confidence: 0.5,
      channel: 'C001',
      content: 'Q1 목표 뒤처짐',
    });

    assert.equal(result.action, 'suppressed');
    assert.equal(result.reason, 'below_confidence_threshold');
    assert.equal(router.getStats().suppressed, 1);
  });

  it('should suppress duplicate insights within 24h', async () => {
    const fakeEntity = {
      findByType: () => [{ entity_id: 'U999', name: 'Lead', properties: { role: 'team_lead' } }],
    };
    const fakeSlack = {
      chat: { postMessage: async () => ({ ok: true }) },
    };
    const router = new ActionRouter({
      slackClient: fakeSlack,
      entity: fakeEntity,
      config: { confidenceThreshold: 0.5 },
    });
    const insight = {
      id: 'ins-2',
      type: 'team_blocker',
      confidence: 0.9,
      channel: 'C001',
      content: 'CI pipeline broken',
    };

    // First call — should succeed (notify)
    const result1 = await router.route(insight);
    assert.equal(result1.action, 'notified');

    // Second call — should be deduplicated
    const result2 = await router.route({ ...insight, id: 'ins-2b' });
    assert.equal(result2.action, 'suppressed');
    assert.equal(result2.reason, 'duplicate_within_24h');
  });

  it('should suppress when no target leaders found', async () => {
    const router = new ActionRouter({
      entity: { findByType: () => [] }, // empty entity store
      config: { confidenceThreshold: 0.5 },
    });

    const result = await router.route({
      id: 'ins-3',
      type: 'deployment_issue',
      confidence: 0.95,
      channel: 'C002',
      content: 'Deploy 실패',
    });

    assert.equal(result.action, 'suppressed');
    assert.equal(result.reason, 'no_target_leaders_found');
  });

  it('should route and notify leaders with matching roles', async () => {
    const sentMessages = [];
    const fakeSlack = {
      chat: {
        postMessage: async (opts) => {
          sentMessages.push(opts);
          return { ok: true };
        },
      },
    };

    const fakeEntity = {
      findByType: (type) => {
        if (type === 'user') return [
          { entity_id: 'U100', name: 'Kim Lead', properties: { role: 'team_lead' } },
          { entity_id: 'U200', name: 'Park Manager', properties: { role: 'manager' } },
        ];
        return [];
      },
    };

    const router = new ActionRouter({
      slackClient: fakeSlack,
      entity: fakeEntity,
      config: { confidenceThreshold: 0.5 },
    });

    const result = await router.route({
      id: 'ins-4',
      type: 'goal_behind',
      confidence: 0.9,
      channel: 'C003',
      content: 'Q1 마케팅 목표 뒤처짐',
    });

    assert.equal(result.action, 'notified');
    assert.ok(result.targets.length > 0, 'Should have notified at least one leader');
    assert.equal(result.urgency, 'high');
    assert.ok(sentMessages.length > 0, 'Should have sent Slack DMs');
    assert.ok(sentMessages[0].text.includes('Effy Insight Alert'));
    assert.ok(sentMessages[0].text.includes('goal_behind'));
  });

  it('should enforce daily notification limit per leader', async () => {
    const sentMessages = [];
    const fakeSlack = {
      chat: { postMessage: async (opts) => { sentMessages.push(opts); return { ok: true }; } },
    };
    const fakeEntity = {
      findByType: () => [{ entity_id: 'U300', name: 'Test Lead', properties: { role: 'team_lead' } }],
    };

    const router = new ActionRouter({
      slackClient: fakeSlack,
      entity: fakeEntity,
      config: { confidenceThreshold: 0.5, maxDailyPerLeader: 2, dedupeWindowMs: 0 },
    });

    // Send 3 different insights
    for (let i = 0; i < 3; i++) {
      await router.route({
        id: `daily-${i}`,
        type: 'team_blocker',
        confidence: 0.9,
        channel: `C${i}00`,
        content: `Blocker ${i}`,
      });
    }

    // Only 2 should have been sent (maxDailyPerLeader=2)
    assert.equal(sentMessages.length, 2);
    assert.equal(router.getStats().notified, 2);
  });

  it('should get agent recommendations when agentBus available', async () => {
    const sentMessages = [];
    const fakeSlack = {
      chat: { postMessage: async (opts) => { sentMessages.push(opts); return { ok: true }; } },
    };
    const fakeEntity = {
      findByType: () => [{ entity_id: 'U400', name: 'CTO', properties: { role: 'tech_lead' } }],
    };
    const fakeAgentBus = {
      ask: async (from, to, prompt) => ({
        success: true,
        response: '1. 에러 로그 분석\n2. 핫픽스 배포\n3. 모니터링 강화',
      }),
    };

    const router = new ActionRouter({
      slackClient: fakeSlack,
      entity: fakeEntity,
      agentBus: fakeAgentBus,
      config: { confidenceThreshold: 0.5 },
    });

    const result = await router.route({
      id: 'ins-agent',
      type: 'recurring_error',
      confidence: 0.85,
      channel: 'C500',
      content: 'NullPointerException in PaymentService',
    });

    assert.equal(result.action, 'notified');
    assert.ok(result.actionRecommendation, 'Should have action recommendation');
    assert.ok(result.actionRecommendation.includes('핫픽스'));

    // DM should include the recommendation
    assert.ok(sentMessages[0].text.includes('추천 액션'));
    assert.equal(router.getStats().agentActions, 1);
  });

  it('should use default template for unknown insight types', async () => {
    const router = new ActionRouter({ config: { confidenceThreshold: 0.5 } });
    const result = await router.route({
      id: 'ins-unknown',
      type: 'totally_new_type',
      confidence: 0.9,
      channel: 'C999',
      content: 'Something happened',
    });

    // Falls back to default template, but suppressed because no entity
    assert.equal(result.action, 'suppressed');
    assert.equal(result.reason, 'no_target_leaders_found');
  });
});

// ─── Suite 3: ProactiveEngine + ActionRouter 통합 ───
describe('ProactiveEngine + ActionRouter Integration', () => {
  let ProactiveEngine, ActionRouter;

  before(() => {
    ({ ProactiveEngine } = require('../src/observer/proactive-engine'));
    ({ ActionRouter } = require('../src/observer/action-router'));
  });

  it('should inject ActionRouter via constructor', () => {
    const router = new ActionRouter();
    const engine = new ProactiveEngine({ actionRouter: router });
    assert.ok(engine.actionRouter === router);
  });

  it('should inject ActionRouter via setActionRouter', () => {
    const engine = new ProactiveEngine();
    assert.equal(engine.actionRouter, null);

    const router = new ActionRouter();
    engine.setActionRouter(router);
    assert.ok(engine.actionRouter === router);
  });

  it('should call ActionRouter during process for high confidence insights', async () => {
    let routeCalled = false;
    const fakeRouter = {
      route: async (insight) => {
        routeCalled = true;
        return { action: 'suppressed', targets: [], reason: 'no_target_leaders_found' };
      },
    };

    const fakeInsightStore = {
      getActionable: () => [{
        id: 'test-1',
        type: 'goal_behind',
        confidence: 0.85,
        channel: 'C001',
        content: 'Test insight',
      }],
      updateStatus: () => {},
    };

    const engine = new ProactiveEngine({
      actionRouter: fakeRouter,
      insightStore: fakeInsightStore,
      config: {
        defaultLevel: 2,
        confidenceThresholds: { nudge: 0.8, active: 0.9 },
      },
    });

    await engine.process();
    assert.ok(routeCalled, 'ActionRouter.route() should have been called');
  });

  it('should NOT call ActionRouter for low confidence insights', async () => {
    let routeCalled = false;
    const fakeRouter = { route: async () => { routeCalled = true; return { action: 'suppressed', targets: [] }; } };

    const fakeInsightStore = {
      getActionable: () => [{
        id: 'test-2',
        type: 'team_blocker',
        confidence: 0.3, // below nudge threshold
        channel: 'C001',
        content: 'Low confidence',
      }],
      updateStatus: () => {},
    };

    const engine = new ProactiveEngine({
      actionRouter: fakeRouter,
      insightStore: fakeInsightStore,
      config: {
        defaultLevel: 2,
        confidenceThresholds: { nudge: 0.8, active: 0.9 },
      },
    });

    await engine.process();
    assert.ok(!routeCalled, 'ActionRouter should NOT be called for low confidence');
  });

  it('should NOT call ActionRouter at SILENT level', async () => {
    let routeCalled = false;
    const fakeRouter = { route: async () => { routeCalled = true; return { action: 'suppressed', targets: [] }; } };

    const fakeInsightStore = {
      getActionable: () => [{
        id: 'test-3',
        type: 'goal_behind',
        confidence: 0.95,
        channel: 'C001',
        content: 'High confidence but silent',
      }],
      updateStatus: () => {},
    };

    const engine = new ProactiveEngine({
      actionRouter: fakeRouter,
      insightStore: fakeInsightStore,
      config: { defaultLevel: 1 }, // SILENT
    });

    await engine.process();
    assert.ok(!routeCalled, 'ActionRouter should NOT be called at SILENT level');
  });
});
