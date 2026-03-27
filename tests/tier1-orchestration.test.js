/**
 * tier1-orchestration.test.js — AgentBus + TeamRegistry + UnifiedMemoryQuery 테스트
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ─── AgentBus ───

const { AgentBus } = require('../src/agents/agent-bus');
const { AgentMailbox } = require('../src/agents/mailbox');
const { AgentCommGraph } = require('../src/agents/comm-graph');

describe('AgentBus', () => {
  let bus, mailbox, graph;

  beforeEach(() => {
    mailbox = new AgentMailbox();
    graph = new AgentCommGraph();
    graph.registerAgent('general', { capabilities: ['chat'] });
    graph.registerAgent('ops', { capabilities: ['oncall'] });
    graph.addLink('general', 'ops', 'peer');

    bus = new AgentBus({
      commGraph: graph,
      mailbox,
      executeAgent: async (agentId, query, ctx) => {
        return `[${agentId}] Answer to: ${query}`;
      },
    });
  });

  it('ask: 동기 질문 → 결과 수신', async () => {
    const result = await bus.ask('general', 'ops', '이번 주 온콜 누구?');
    assert.equal(result.success, true);
    assert.ok(result.response.includes('[ops]'));
    assert.equal(result.source, 'agent:ops');
  });

  it('ask: CommGraph 권한 없는 에이전트 → 차단', async () => {
    graph.registerAgent('secret', {});
    // general → secret 링크 없음
    const result = await bus.ask('general', 'secret', '비밀 정보?');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Communication denied'));
  });

  it('ask: 깊이 제한 초과 → 거부', async () => {
    const result = await bus.ask('general', 'ops', 'test', { depth: 3 });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('depth limit'));
  });

  it('ask: 타임아웃 → 실패', async () => {
    const slowBus = new AgentBus({
      commGraph: graph,
      mailbox,
      executeAgent: async () => {
        await new Promise(r => setTimeout(r, 5000)); // 5초 대기
        return 'too late';
      },
    });
    const result = await slowBus.ask('general', 'ops', 'test', { timeoutMs: 100 });
    assert.equal(result.success, false);
    assert.ok(result.error.includes('timeout'));
  });

  it('ask: 동시 요청 제한', async () => {
    const slowBus = new AgentBus({
      commGraph: graph,
      mailbox,
      executeAgent: async () => {
        await new Promise(r => setTimeout(r, 2000));
        return 'ok';
      },
    });

    // 5개 동시 실행 (MAX_CONCURRENT_ASKS = 5)
    const promises = [];
    for (let i = 0; i < 6; i++) {
      promises.push(slowBus.ask('general', 'ops', `query-${i}`, { timeoutMs: 100 }));
    }
    const results = await Promise.all(promises);
    // 최소 1개는 concurrent limit에 걸려야 함
    const rejected = results.filter(r => !r.success && r.error?.includes('concurrent'));
    assert.ok(rejected.length >= 1, 'At least one should be rejected by concurrent limit');
  });

  it('ask: 캐시 — 동일 질문 반복 시 캐시 히트', async () => {
    let callCount = 0;
    const countBus = new AgentBus({
      commGraph: graph,
      mailbox,
      executeAgent: async (agentId, query) => {
        callCount++;
        return `response-${callCount}`;
      },
    });

    const r1 = await countBus.ask('general', 'ops', 'same question');
    const r2 = await countBus.ask('general', 'ops', 'same question');
    assert.equal(callCount, 1, 'Should call executeAgent only once');
    assert.equal(r1.response, r2.response);
    assert.ok(r2.source.includes('cached'));
  });

  it('tell: 비동기 전송 → Mailbox에 큐잉', () => {
    const result = bus.tell('general', 'ops', '배포 상태 알려줘');
    assert.equal(result.success, true);

    const messages = mailbox.receive('ops');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].message, '배포 상태 알려줘');
  });

  it('tell: CommGraph 권한 없으면 차단', () => {
    graph.registerAgent('secret', {});
    const result = bus.tell('general', 'secret', 'test');
    assert.equal(result.success, false);
  });

  it('broadcast: 연결된 모든 에이전트에 질문', async () => {
    graph.registerAgent('code', { capabilities: ['coding'] });
    graph.addLink('general', 'code', 'peer');

    const results = await bus.broadcast('general', '전체 상태?');
    assert.ok(results.length >= 2, 'Should reach ops and code');
    assert.ok(results.every(r => r.success));
  });

  it('stats 추적', async () => {
    await bus.ask('general', 'ops', 'test');
    bus.tell('general', 'ops', 'test');

    const stats = bus.getStats();
    assert.equal(stats.askCount, 1);
    assert.equal(stats.askSuccess, 1);
    assert.equal(stats.tellCount, 1);
  });
});

// ─── TeamRegistry ───

const { TeamRegistry } = require('../src/agents/team-registry');

describe('TeamRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new TeamRegistry();
    registry.register('ops', {
      capabilities: ['oncall', 'incidents', 'deployments', 'monitoring'],
      dataSources: ['pagerduty', 'grafana'],
      description: 'Operations team agent for infrastructure and incidents',
    });
    registry.register('marketing', {
      capabilities: ['campaigns', 'analytics', 'schedules', 'content'],
      dataSources: ['hubspot', 'google-analytics'],
      description: 'Marketing team agent for campaigns and content',
    });
    registry.register('code', {
      capabilities: ['coding', 'reviews', 'architecture', 'debugging'],
      dataSources: ['github', 'jira'],
      description: 'Engineering agent for code reviews and architecture',
    });
  });

  it('findByCapability: 정확 매칭', () => {
    const result = registry.findByCapability('oncall');
    assert.deepEqual(result, ['ops']);
  });

  it('findByCapability: 부분 매칭', () => {
    const result = registry.findByCapability('deploy');
    assert.ok(result.includes('ops'));
  });

  it('findByCapability: offline 에이전트 제외', () => {
    registry.setStatus('ops', 'offline');
    const result = registry.findByCapability('oncall');
    assert.deepEqual(result, []);
  });

  it('findByTopic: 자연어 주제 → 적합한 에이전트 순위', () => {
    // 영어 키워드로 테스트 (한국어는 공백 기반 토큰화가 capability와 매칭 안 됨)
    const results = registry.findByTopic('campaigns content schedules');
    assert.ok(results.length > 0);
    assert.equal(results[0].agentId, 'marketing', 'Marketing should be top match');
  });

  it('findByTopic: 여러 에이전트 매칭 시 점수 순', () => {
    const results = registry.findByTopic('deployment monitoring');
    assert.ok(results.length > 0);
    assert.equal(results[0].agentId, 'ops');
  });

  it('findByTopic: 데이터소스 매칭', () => {
    const results = registry.findByTopic('github PR 현황');
    assert.ok(results.some(r => r.agentId === 'code'));
  });

  it('loadFromConfig', () => {
    const fresh = new TeamRegistry();
    fresh.loadFromConfig([
      { id: 'hr', capabilities: ['hiring', 'benefits'], description: 'HR team' },
    ]);
    assert.equal(fresh.listAgents().length, 1);
    assert.equal(fresh.getAgentProfile('hr').capabilities[0], 'hiring');
  });

  it('register 갱신 — 기존 인덱스 정리', () => {
    registry.register('ops', {
      capabilities: ['new-capability'],
      dataSources: [],
    });
    // 기존 oncall 인덱스에서 제거됨
    const result = registry.findByCapability('oncall');
    assert.deepEqual(result, []);
    // 새 capability 인덱스에 추가됨
    const newResult = registry.findByCapability('new-capability');
    assert.deepEqual(newResult, ['ops']);
  });

  it('touch: heartbeat 업데이트', () => {
    registry.setStatus('ops', 'offline');
    registry.touch('ops');
    assert.equal(registry.getAgentProfile('ops').status, 'online');
  });
});

// ─── UnifiedMemoryQuery ───

const { UnifiedMemoryQuery } = require('../src/memory/unified-query');

describe('UnifiedMemoryQuery', () => {
  it('memory scope만 검색', async () => {
    const mockSearch = {
      search: (query) => ({
        results: [
          { content: 'Test memory', type: 'fact', importance: 0.8, sourceChannel: 'C1', sourceUser: 'U1', createdAt: '2025-01-01' },
        ],
        searchTime: 5,
      }),
    };

    const uq = new UnifiedMemoryQuery({ search: mockSearch });
    const result = await uq.query('test', { scope: ['memory'] });

    assert.ok(result.results.length > 0);
    assert.equal(result.results[0].sourceType, 'memory');
    assert.ok(result.results[0].relevance > 0);
  });

  it('agent scope — TeamRegistry + AgentBus 연동', async () => {
    const teamReg = new TeamRegistry();
    teamReg.register('ops', { capabilities: ['oncall', 'schedules'] });

    const mockBus = {
      ask: async (from, to, query) => ({
        success: true,
        response: `oncall: Drake (this week)`,
        source: `agent:${to}`,
      }),
    };

    const uq = new UnifiedMemoryQuery({
      agentBus: mockBus,
      teamRegistry: teamReg,
    });

    // 영어 키워드 사용 (findByTopic이 공백 기반 토큰화)
    const result = await uq.query('oncall schedules this week', {
      scope: ['agents'],
      fromAgent: 'general',
    });

    assert.ok(result.results.length > 0, `Expected agent results, got ${result.results.length}`);
    assert.equal(result.results[0].sourceType, 'agent');
    assert.ok(result.results[0].content.includes('Drake'));
  });

  it('모든 소스 병렬 검색', async () => {
    const mockSearch = {
      search: () => ({
        results: [{ content: 'from memory', type: 'fact', importance: 0.7 }],
      }),
    };

    const mockChub = {
      searchDocs: async () => [{ title: 'Doc', content: 'from knowledge', score: 0.8 }],
    };

    const teamReg = new TeamRegistry();
    teamReg.register('ops', { capabilities: ['test'] });

    const mockBus = {
      ask: async () => ({ success: true, response: 'from agent', source: 'agent:ops' }),
    };

    const uq = new UnifiedMemoryQuery({
      search: mockSearch,
      chub: mockChub,
      agentBus: mockBus,
      teamRegistry: teamReg,
    });

    const result = await uq.query('test query', {
      scope: ['memory', 'knowledge', 'agents'],
      fromAgent: 'general',
    });

    assert.ok(result.results.length >= 2, 'Should have results from multiple sources');
    const sourceTypes = result.results.map(r => r.sourceType);
    assert.ok(sourceTypes.includes('memory'));
  });

  it('중복 제거', async () => {
    const mockSearch = {
      search: () => ({
        results: [
          { content: 'Same content here for testing dedup', type: 'fact', importance: 0.5 },
          { content: 'Same content here for testing dedup', type: 'decision', importance: 0.9 },
        ],
      }),
    };

    const uq = new UnifiedMemoryQuery({ search: mockSearch });
    const result = await uq.query('test', { scope: ['memory'] });

    // 중복 제거 후 높은 relevance만 남아야 함
    assert.equal(result.results.length, 1);
  });

  it('소스 실패 시 다른 소스는 정상 작동', async () => {
    const mockSearch = {
      search: () => { throw new Error('DB connection failed'); },
    };

    const mockChub = {
      searchDocs: async () => [{ title: 'Doc', content: 'still works', score: 0.5 }],
    };

    const uq = new UnifiedMemoryQuery({ search: mockSearch, chub: mockChub });
    const result = await uq.query('test', { scope: ['memory', 'knowledge'] });

    // memory 실패해도 knowledge는 정상
    assert.ok(result.results.length > 0);
    assert.equal(result.sources.memory, 0);
    assert.ok(result.sources.knowledge > 0);
  });

  it('stats 추적', async () => {
    const mockSearch = {
      search: () => ({ results: [{ content: 'x', type: 'fact', importance: 0.5 }] }),
    };
    const uq = new UnifiedMemoryQuery({ search: mockSearch });

    await uq.query('q1', { scope: ['memory'] });
    await uq.query('q2', { scope: ['memory'] });

    const stats = uq.getStats();
    assert.equal(stats.queries, 2);
    assert.ok(stats.totalResults > 0);
  });
});
