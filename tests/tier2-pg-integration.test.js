/**
 * tier2-pg-integration.test.js — v3.9 PostgreSQL 연동 모듈 테스트.
 *
 * 테스트 대상:
 * - CircuitBreaker (CATEGORY_POLICY, ErrorClassifier 연동)
 * - Mailbox (L1 인메모리 + PG mock)
 * - Bulletin (채널 격리 + PG mock)
 * - MemoryTransaction (트랜잭션 원자성)
 * - BackgroundCompactionRunner (큐 + 비동기 처리)
 * - GatewayPipeline (스텝 등록/실행)
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── CircuitBreaker ───

const { CircuitBreaker, CATEGORY_POLICY } = require('../src/core/circuit-breaker');

describe('CircuitBreaker v3.9', () => {
  let cb;

  beforeEach(() => {
    cb = new CircuitBreaker({ errorThreshold: 3, cooldownMs: 1000 });
  });

  it('CATEGORY_POLICY 정의 확인', () => {
    assert.ok(CATEGORY_POLICY.rate_limit);
    assert.ok(CATEGORY_POLICY.auth);
    assert.equal(CATEGORY_POLICY.rate_limit.tripCircuit, false);
    assert.equal(CATEGORY_POLICY.auth.immediateDisable, true);
    assert.equal(CATEGORY_POLICY.invalid_request.tripCircuit, false);
  });

  it('ErrorClassifier 없으면 unknown 카테고리로 처리', () => {
    const result = cb.recordError('agent-1', new Error('some error'));
    assert.equal(result.category, 'unknown');
    assert.equal(result.action, 'counted');
  });

  it('ErrorClassifier 연동 — rate_limit → global cooldown', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'rate_limit' }),
    });

    const result = cb.recordError('agent-1', new Error('429'));
    assert.equal(result.action, 'global_cooldown');
    assert.equal(result.category, 'rate_limit');
    assert.ok(result.cooldownUntil > Date.now());
  });

  it('auth 에러 → 즉시 영구 비활성화', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'auth' }),
    });

    const result = cb.recordError('agent-1', new Error('401'));
    assert.equal(result.action, 'disabled_permanent');
    assert.equal(cb.isDisabled('agent-1'), true);

    // getDisableInfo 확인
    const info = cb.getDisableInfo('agent-1');
    assert.equal(info.disabled, true);
    assert.equal(info.remaining, Infinity);
  });

  it('invalid_request → 무시', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'invalid_request' }),
    });

    const result = cb.recordError('agent-1', new Error('bad input'));
    assert.equal(result.action, 'ignored');
  });

  it('threshold 도달 → 임시 비활성화', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'timeout' }),
    });

    cb.recordError('agent-1', new Error('timeout 1'));
    cb.recordError('agent-1', new Error('timeout 2'));
    const result = cb.recordError('agent-1', new Error('timeout 3'));
    assert.equal(result.action, 'disabled');
    assert.equal(result.category, 'timeout');
  });

  it('recordSuccess → 연속 에러 카운터 리셋', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'server_error' }),
    });

    cb.recordError('agent-1', new Error('500'));
    cb.recordError('agent-1', new Error('500'));
    cb.recordSuccess('agent-1');

    // 3번째 에러여도 리셋 후이므로 counted
    const result = cb.recordError('agent-1', new Error('500'));
    assert.equal(result.action, 'counted');
    assert.equal(result.count, 1);
  });

  it('resetAgent → auth 영구 비활성화 복구', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'auth' }),
    });

    cb.recordError('agent-1', new Error('401'));
    assert.equal(cb.isDisabled('agent-1'), true);

    cb.resetAgent('agent-1');
    assert.equal(cb.isDisabled('agent-1'), false);
  });

  it('global cooldown → 모든 에이전트 비활성화', () => {
    cb.setErrorClassifier({
      classify: () => ({ category: 'rate_limit' }),
    });

    cb.recordError('agent-1', new Error('429'));
    assert.equal(cb.isDisabled('agent-2'), true); // 다른 에이전트도 비활성화
  });

  it('disabled=false → 아무것도 안 함', () => {
    const disabledCb = new CircuitBreaker({ enabled: false });
    const result = disabledCb.recordError('a', new Error('x'));
    assert.equal(result.action, 'none');
  });

  it('stats 추적', () => {
    cb.recordError('a', new Error('x'));
    const stats = cb.getStats();
    assert.equal(stats.totalErrors, 1);
  });

  it('DB 로깅 (mock)', async () => {
    let logged = false;
    cb.setDb({
      run: async () => { logged = true; },
    });

    cb.recordError('agent-1', new Error('test'));
    // DB 로깅은 비동기 — 약간 대기
    await new Promise(r => setTimeout(r, 50));
    assert.equal(logged, true);
  });
});

// ─── Mailbox v3.9 ───

const { AgentMailbox } = require('../src/agents/mailbox');

describe('AgentMailbox v3.9', () => {
  it('기본 send/receive', () => {
    const mb = new AgentMailbox();
    mb.send({ from: 'a', to: 'b', message: 'hello' });
    const msgs = mb.receive('b');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].message, 'hello');
  });

  it('PG 영속화 (mock db)', async () => {
    let persisted = false;
    const mb = new AgentMailbox({
      db: {
        run: async () => { persisted = true; return { changes: 1 }; },
      },
    });

    // SLIM: persist opt-in — L2 PG 영속화는 { persist: true } 필요
    mb.send({ from: 'a', to: 'b', message: 'test' }, { persist: true });
    await new Promise(r => setTimeout(r, 50));
    assert.equal(persisted, true);
  });

  it('delivered 마킹 (mock db)', async () => {
    let deliveredIds = [];
    const mb = new AgentMailbox({
      db: {
        run: async (sql, params) => {
          if (sql.includes('delivered')) deliveredIds.push(params[0]);
          return { changes: 1 };
        },
      },
    });

    mb.send({ from: 'a', to: 'b', message: 'test' });
    mb.receive('b');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(deliveredIds.length, 1);
  });

  it('restoreFromDb', async () => {
    const mb = new AgentMailbox({
      db: {
        run: async () => ({ changes: 0 }),
        all: async () => [
          { msg_id: 'msg-1', from_agent: 'a', to_agent: 'b', message: 'restored', context: '{}', created_at: new Date().toISOString() },
        ],
      },
    });

    const count = await mb.restoreFromDb();
    assert.equal(count, 1);
    assert.equal(mb.size('b'), 1);
    const msgs = mb.receive('b');
    assert.equal(msgs[0].message, 'restored');
  });

  it('에이전트당 큐 상한', () => {
    const mb = new AgentMailbox();
    for (let i = 0; i < 55; i++) {
      mb.send({ from: 'a', to: 'b', message: `msg-${i}` });
    }
    // MAX_PER_AGENT = 50, 초과분은 oldest 드롭
    assert.equal(mb.size('b'), 50);
  });
});

// ─── Bulletin v3.9 ───

const { MemoryBulletin } = require('../src/memory/bulletin');

describe('MemoryBulletin v3.9 (channel isolation)', () => {
  it('채널별 격리 — 다른 채널은 다른 bulletin', () => {
    const b = new MemoryBulletin();
    b._swap('agent-1', 'Channel A briefing', 100, 'C001');
    b._swap('agent-1', 'Channel B briefing', 100, 'C002');

    const a = b.get('agent-1', 'C001');
    assert.equal(a.content, 'Channel A briefing');

    const bResult = b.get('agent-1', 'C002');
    assert.equal(bResult.content, 'Channel B briefing');
  });

  it('_global 폴백 — 채널별 bulletin 없으면 global 반환', () => {
    const b = new MemoryBulletin();
    b._swap('agent-1', 'Global briefing', 50, '_global');

    const result = b.get('agent-1', 'C999');
    assert.equal(result.content, 'Global briefing');
  });

  it('clear(agentId) → 해당 에이전트의 모든 채널 삭제', () => {
    const b = new MemoryBulletin();
    b._swap('agent-1', 'A', 10, 'C1');
    b._swap('agent-1', 'B', 10, 'C2');
    b._swap('agent-2', 'C', 10, 'C1');

    b.clear('agent-1');
    assert.equal(b.get('agent-1', 'C1').content, '');
    assert.equal(b.get('agent-1', 'C2').content, '');
    assert.equal(b.get('agent-2', 'C1').content, 'C'); // 다른 에이전트 유지
  });

  it('clear(agentId, channelId) → 특정 채널만 삭제', () => {
    const b = new MemoryBulletin();
    b._swap('agent-1', 'A', 10, 'C1');
    b._swap('agent-1', 'B', 10, 'C2');

    b.clear('agent-1', 'C1');
    assert.equal(b.get('agent-1', 'C1').content, '');
    assert.equal(b.get('agent-1', 'C2').content, 'B');
  });

  it('PG 영속화 (mock)', async () => {
    let upserted = false;
    const b = new MemoryBulletin({
      db: {
        run: async () => { upserted = true; return { changes: 1 }; },
      },
    });

    b._swap('agent-1', 'test', 50, 'C1');
    await new Promise(r => setTimeout(r, 50));
    assert.equal(upserted, true);
  });

  it('restoreFromDb', async () => {
    const b = new MemoryBulletin({
      db: {
        all: async () => [
          { agent_id: 'agent-1', channel_id: 'C1', content: 'restored', tokens: 42, generated_at: new Date().toISOString() },
        ],
      },
    });

    await b.restoreFromDb();
    const result = b.get('agent-1', 'C1');
    assert.equal(result.content, 'restored');
    assert.equal(result.tokens, 42);
  });

  it('stale 판단', () => {
    const b = new MemoryBulletin({ refreshIntervalMs: 100, staleThresholdMultiplier: 1 });
    b._swap('agent-1', 'fresh', 10, '_global');
    assert.equal(b.get('agent-1').stale, false);
  });

  it('injectIntoPrompt — 채널별', () => {
    const b = new MemoryBulletin();
    b._swap('agent-1', 'Channel briefing', 50, 'C1');

    const result = b.injectIntoPrompt('agent-1', 'Base prompt', 'C1');
    assert.ok(result.includes('Channel briefing'));
    assert.ok(result.includes('Base prompt'));
  });
});

// ─── BackgroundCompactionRunner ───

const { BackgroundCompactionRunner } = require('../src/memory/background-compaction');

describe('BackgroundCompactionRunner', () => {
  it('enqueue 성공', () => {
    const runner = new BackgroundCompactionRunner({
      compactionEngine: {
        needsCompaction: () => false,
        tierThresholds: { background: 0.8, aggressive: 0.85, emergency: 0.95 },
      },
    });

    const result = runner.enqueue('session-1', [], 100000);
    assert.equal(result.enqueued, true);
  });

  it('엔진 없으면 거부', () => {
    const runner = new BackgroundCompactionRunner({});
    const result = runner.enqueue('session-1', [], 100000);
    assert.equal(result.enqueued, false);
  });

  it('중복 세션 거부', () => {
    const runner = new BackgroundCompactionRunner({
      compactionEngine: {
        needsCompaction: () => false,
        tierThresholds: {},
        compact: async () => ({}),
      },
    });

    runner.enqueue('session-1', [{ role: 'user', content: 'test' }], 100000);
    const result = runner.enqueue('session-1', [], 100000);
    assert.equal(result.enqueued, false);
    assert.ok(result.reason.includes('Already'));
  });

  it('stats 추적', () => {
    const runner = new BackgroundCompactionRunner({
      compactionEngine: { needsCompaction: () => false, tierThresholds: {} },
    });

    runner.enqueue('s1', [], 100000);
    const stats = runner.getStats();
    assert.equal(stats.enqueued, 1);
  });
});

// ─── GatewayPipeline ───

const { GatewayPipeline, PIPELINE_STEPS } = require('../src/gateway/gateway-pipeline');

describe('GatewayPipeline', () => {
  it('PIPELINE_STEPS 정의', () => {
    assert.ok(PIPELINE_STEPS.length > 10);
    assert.ok(PIPELINE_STEPS.some(s => s.name === 'middleware'));
    assert.ok(PIPELINE_STEPS.some(s => s.name === 'agentRuntime'));
    assert.ok(PIPELINE_STEPS.some(s => s.name === 'bulletinInject'));
  });

  it('addStepAfter', () => {
    const pipeline = new GatewayPipeline({});
    const before = pipeline.getSteps().length;
    pipeline.addStepAfter('middleware', { name: 'custom', phase: 'input', critical: false });
    assert.equal(pipeline.getSteps().length, before + 1);

    const idx = pipeline.getSteps().findIndex(s => s.name === 'custom');
    const mwIdx = pipeline.getSteps().findIndex(s => s.name === 'middleware');
    assert.equal(idx, mwIdx + 1);
  });

  it('removeStep', () => {
    const pipeline = new GatewayPipeline({});
    const before = pipeline.getSteps().length;
    pipeline.removeStep('nlConfig');
    assert.equal(pipeline.getSteps().length, before - 1);
    assert.ok(!pipeline.getSteps().some(s => s.name === 'nlConfig'));
  });

  it('execute — 빈 파이프라인 성공', async () => {
    const pipeline = new GatewayPipeline({});
    // 모든 built-in 스텝은 null 반환 (no-op) but still tracked
    const result = await pipeline.execute({ msg: {}, adapter: {} });
    assert.equal(result.success, true);
  });

  it('execute — 커스텀 스텝 실행', async () => {
    const pipeline = new GatewayPipeline({});
    let executed = false;
    pipeline.addStepAfter('middleware', {
      name: 'test-step',
      phase: 'test',
      critical: false,
      fn: async (ctx) => { executed = true; ctx.testValue = 42; },
    });

    const result = await pipeline.execute({});
    assert.equal(executed, true);
    assert.equal(result.context.testValue, 42);
  });

  it('execute — critical 스텝 실패 시 파이프라인 중단', async () => {
    const pipeline = new GatewayPipeline({});
    pipeline.addStepAfter('middleware', {
      name: 'fail-step',
      phase: 'test',
      critical: true,
      fn: async () => { throw new Error('Critical failure'); },
    });

    const result = await pipeline.execute({});
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Critical failure'));
  });

  it('execute — non-critical 스텝 실패 시 계속', async () => {
    const pipeline = new GatewayPipeline({});
    let afterRan = false;
    pipeline.addStepAfter('middleware', {
      name: 'soft-fail',
      phase: 'test',
      critical: false,
      fn: async () => { throw new Error('Non-critical failure'); },
    });
    pipeline.addStepAfter('soft-fail', {
      name: 'after-fail',
      phase: 'test',
      critical: false,
      fn: async () => { afterRan = true; },
    });

    const result = await pipeline.execute({});
    assert.equal(result.success, true);
    assert.equal(afterRan, true);
  });

  it('stats', async () => {
    const pipeline = new GatewayPipeline({});
    await pipeline.execute({});
    await pipeline.execute({});
    const stats = pipeline.getStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.success, 2);
  });
});
