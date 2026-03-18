/**
 * Tier 1 — ModelRouter 4-Tier Agent-Level Routing Tests.
 *
 * v3.6.1: 5단계 라우팅 + 복잡도 분석 + fallback chain + per-tier maxTokens.
 */
const { describe, it, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

// ─── Config Mock ───
// model-router.js는 require('../config')에서 config를 읽음.
// 테스트에서는 직접 config를 주입하기 위해 require cache를 조작.
const configModule = require('../src/config');
const originalConfig = { ...configModule.config };

function setTestConfig(overrides) {
  Object.assign(configModule.config, {
    anthropic: {
      maxTokens: 4096,
      models: {
        tier1: { id: 'claude-haiku-4-5-20251001', maxTokens: 8192 },
        tier2: { id: 'claude-sonnet-4-20250514', maxTokens: 16384 },
        tier3: { id: 'claude-opus-4-20250514', maxTokens: 16384 },
        tier4: { id: 'claude-opus-4-20250514', maxTokens: 32000, extendedThinking: { enabled: true, budgetTokens: 10000 } },
      },
    },
    agents: {
      list: [
        { id: 'general', model: { range: ['tier1', 'tier2'] } },
        { id: 'code', model: { range: ['tier2', 'tier4'] } },
        { id: 'ops', model: { range: ['tier1', 'tier3'] } },
        { id: 'knowledge', model: { range: ['tier1', 'tier3'] } },
        { id: 'strategy', model: { range: ['tier2', 'tier4'] } },
      ],
    },
    modelRouter: {
      enabled: true,
      complexityUpgrade: true,
      processDefaults: { channel: 'tier1', worker: 'tier1', indexer: 'tier1' },
      fallbacks: {
        tier4: ['tier3', 'tier2', 'tier1'],
        tier3: ['tier2', 'tier1'],
        tier2: ['tier1'],
        tier1: [],
      },
      deprioritizeCooldownMs: 900000,
    },
    ...overrides,
  });
}

// ─── 테스트 시작 ───

describe('ModelRouter — Constructor & Initialization', () => {
  beforeEach(() => setTestConfig());

  it('should build agentModels map from agents.list', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const general = router.getAgentModelRange('general');
    assert.deepEqual(general, { minTier: 'tier1', maxTier: 'tier2' });

    const code = router.getAgentModelRange('code');
    assert.deepEqual(code, { minTier: 'tier2', maxTier: 'tier4' });

    const strategy = router.getAgentModelRange('strategy');
    assert.deepEqual(strategy, { minTier: 'tier2', maxTier: 'tier4' });
  });

  it('should return null for unknown agent', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    assert.equal(router.getAgentModelRange('nonexistent'), null);
  });

  it('should expose tier definitions', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const defs = router.getTierDefs();
    assert.equal(defs.tier1.id, 'claude-haiku-4-5-20251001');
    assert.equal(defs.tier4.extendedThinking.enabled, true);
  });

  it('should resolve model ID by tier name', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    assert.equal(router.resolveModelId('tier1'), 'claude-haiku-4-5-20251001');
    assert.equal(router.resolveModelId('tier2'), 'claude-sonnet-4-20250514');
    assert.equal(router.resolveModelId('tier4'), 'claude-opus-4-20250514');
    assert.equal(router.resolveModelId('nonexistent'), null);
  });
});

describe('ModelRouter — Complexity Analysis (_analyzeComplexity)', () => {
  beforeEach(() => setTestConfig());

  it('should classify greetings as LIGHT', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    assert.equal(router._analyzeComplexity('안녕'), 'LIGHT');
    assert.equal(router._analyzeComplexity('hi'), 'LIGHT');
    assert.equal(router._analyzeComplexity('hello'), 'LIGHT');
    assert.equal(router._analyzeComplexity('thanks'), 'LIGHT');
    assert.equal(router._analyzeComplexity('ㅎㅇ'), 'LIGHT');
    assert.equal(router._analyzeComplexity('네'), 'LIGHT');
    assert.equal(router._analyzeComplexity('ok'), 'LIGHT');
  });

  it('should classify null/empty as STANDARD', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    assert.equal(router._analyzeComplexity(null), 'STANDARD');
    assert.equal(router._analyzeComplexity(''), 'STANDARD');
  });

  it('should classify architecture keywords as CRITICAL', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    // 2+ critical keywords → CRITICAL (must be >10 words to avoid LIGHT short-circuit)
    assert.equal(router._analyzeComplexity('이 프로젝트의 architecture와 system design에 대해 trade-off를 분석해줘 상세하게'), 'CRITICAL');
    assert.equal(router._analyzeComplexity('현재 서비스의 아키텍처 설계를 전반적으로 리뷰하고 개선점을 찾아줘'), 'CRITICAL');
    assert.equal(router._analyzeComplexity('다음 분기 OKR과 roadmap을 작성해줘 팀 전체 방향성 포함해서'), 'CRITICAL');
  });

  it('should classify deep analysis patterns as CRITICAL', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    assert.equal(router._analyzeComplexity('이 부분 깊이 분석해줘'), 'CRITICAL');
    assert.equal(router._analyzeComplexity('deep analysis of the system'), 'CRITICAL');
    assert.equal(router._analyzeComplexity('comprehensive review needed'), 'CRITICAL');
  });

  it('should classify code blocks as HEAVY', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const codeText = '이 코드 좀 봐줘 `const x = 1`';
    assert.equal(router._analyzeComplexity(codeText), 'HEAVY');
  });

  it('should classify multi-sentence tech content as HEAVY', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const techText = 'api function class error bug deploy merge database schema migration auth token 관련 이슈. 여러 곳에서 발생. 확인 필요.';
    assert.equal(router._analyzeComplexity(techText), 'HEAVY');
  });

  it('should classify normal questions as STANDARD', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    assert.equal(router._analyzeComplexity('이번 주 미팅 언제야?'), 'STANDARD');
    assert.equal(router._analyzeComplexity('프로젝트 진행 상황이 어때?'), 'STANDARD');
  });
});

describe('ModelRouter — 5-Stage Routing (route)', () => {
  beforeEach(() => setTestConfig());

  // Stage 1: Agent config → tier range
  it('should route general agent LIGHT text to tier1 (Haiku)', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'general', functionType: 'general', text: '안녕',
    });
    assert.equal(result.tier, 'tier1');
    assert.equal(result.model, 'claude-haiku-4-5-20251001');
    assert.equal(result.maxTokens, 8192);
    assert.equal(result.extendedThinking, null);
  });

  it('should route code agent LIGHT text to tier2 (Sonnet, min of range)', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'code', functionType: 'code', text: 'ok',
    });
    assert.equal(result.tier, 'tier2');
    assert.equal(result.model, 'claude-sonnet-4-20250514');
    assert.equal(result.maxTokens, 16384);
    assert.equal(result.extendedThinking, null);
  });

  // Stage 3: Complexity upgrade — CRITICAL → max tier
  it('should route code agent CRITICAL text to tier4 (Opus ET)', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'code',
      functionType: 'code',
      text: 'architecture system design trade-off 분석하고 migration plan 짜줘',
    });
    assert.equal(result.tier, 'tier4');
    assert.equal(result.model, 'claude-opus-4-20250514');
    assert.equal(result.maxTokens, 32000);
    assert.ok(result.extendedThinking);
    assert.equal(result.extendedThinking.enabled, true);
    assert.equal(result.extendedThinking.budgetTokens, 10000);
  });

  it('should route strategy agent CRITICAL to tier4 (Opus ET)', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'strategy',
      functionType: 'general',
      text: '다음 분기 OKR과 roadmap을 수립하고 전체 아키텍처 설계 방향을 포함한 전략 문서를 작성해주세요',
    });
    assert.equal(result.tier, 'tier4');
    assert.ok(result.extendedThinking);
  });

  // Stage 3: HEAVY → middle tier
  it('should route ops agent HEAVY text to tier2 (middle of tier1-tier3)', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'ops',
      functionType: 'ops',
      text: '이 코드 좀 봐줘 `const x = 1` 여기에 버그가 있어',
    });
    assert.equal(result.tier, 'tier2');
    assert.equal(result.model, 'claude-sonnet-4-20250514');
  });

  it('should route code agent HEAVY to tier3 (middle of tier2-tier4)', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'code',
      functionType: 'code',
      text: '이 코드 좀 봐줘 `const x = 1` 리팩토링 필요',
    });
    assert.equal(result.tier, 'tier3');
    assert.equal(result.model, 'claude-opus-4-20250514');
    assert.equal(result.maxTokens, 16384);
    assert.equal(result.extendedThinking, null); // tier3 has no ET
  });

  // Stage 2: processDefaults fallback for unknown agent
  it('should fallback to processDefaults for unknown agent', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'channel', agentId: 'unknown-agent',
      functionType: 'general', text: '테스트',
    });
    // processDefaults.channel = tier1, single tier → always tier1
    assert.equal(result.tier, 'tier1');
    assert.equal(result.model, 'claude-haiku-4-5-20251001');
  });

  it('should use worker processDefault for worker process', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();
    const result = router.route({
      processType: 'worker', agentId: 'unknown-agent',
      functionType: 'general', text: '테스트',
    });
    assert.equal(result.tier, 'tier1');
  });

  // Budget hint mapping
  it('should return correct budgetHint for each complexity', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const light = router.route({ processType: 'channel', agentId: 'general', text: 'hi' });
    assert.equal(light.budgetHint, 'LIGHT');

    const standard = router.route({ processType: 'channel', agentId: 'general', text: '이번 주 미팅 언제야?' });
    assert.equal(standard.budgetHint, 'STANDARD');

    const heavy = router.route({
      processType: 'channel', agentId: 'code',
      text: '이 코드 좀 봐줘 `const x = 1` 여기에 대해',
    });
    assert.equal(heavy.budgetHint, 'DEEP');
  });

  // complexityUpgrade disabled
  it('should always use minTier when complexityUpgrade is disabled', () => {
    setTestConfig({ modelRouter: { ...configModule.config.modelRouter, complexityUpgrade: false } });
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const result = router.route({
      processType: 'channel', agentId: 'code',
      text: 'architecture system design trade-off 분석. migration plan 필요.',
    });
    // code agent min = tier2, but complexityUpgrade disabled → always min
    assert.equal(result.tier, 'tier2');
    assert.equal(result.model, 'claude-sonnet-4-20250514');
  });
});

describe('ModelRouter — Deprioritize & Fallback', () => {
  beforeEach(() => setTestConfig());

  it('should fallback to lower tier when model is deprioritized', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    // Deprioritize Opus
    router.recordModelError('claude-opus-4-20250514');

    // Code agent CRITICAL normally → tier4 (Opus)
    // But Opus deprioritized → fallback tier4→tier3→tier2 (Sonnet, since Opus = tier3 too)
    const result = router.route({
      processType: 'channel', agentId: 'code',
      text: 'architecture system design trade-off analysis migration plan',
    });
    // tier4 → opus (deprioritized) → tier3 → opus (deprioritized) → tier2 → sonnet
    assert.equal(result.tier, 'tier2');
    assert.equal(result.model, 'claude-sonnet-4-20250514');
    assert.equal(result.extendedThinking, null); // Sonnet has no ET
  });

  it('should return preferred tier when no deprioritization', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const tier = router._getAvailableTier('tier3');
    assert.equal(tier, 'tier3');
  });

  it('should return preferred tier after cooldown expires', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    // Deprioritize with expired timestamp
    router._deprioritized.set('claude-opus-4-20250514', Date.now() - 1000);

    const tier = router._getAvailableTier('tier3');
    assert.equal(tier, 'tier3'); // Expired → restored
    // Should also clean up the expired entry
    assert.equal(router._deprioritized.has('claude-opus-4-20250514'), false);
  });

  it('should return preferred tier when all fallbacks deprioritized', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    // Deprioritize all models
    router.recordModelError('claude-opus-4-20250514');
    router.recordModelError('claude-sonnet-4-20250514');
    router.recordModelError('claude-haiku-4-5-20251001');

    // All deprioritized → return original tier as last resort
    const tier = router._getAvailableTier('tier4');
    assert.equal(tier, 'tier4');
  });
});

describe('ModelRouter — Per-Agent Range Validation', () => {
  beforeEach(() => setTestConfig());

  it('general agent should stay within tier1-tier2', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    // Even CRITICAL text → capped at tier2 for general agent
    const result = router.route({
      processType: 'channel', agentId: 'general',
      text: 'architecture system design OKR roadmap postmortem',
    });
    assert.equal(result.tier, 'tier2');
    assert.equal(result.model, 'claude-sonnet-4-20250514');
    assert.equal(result.extendedThinking, null); // tier2 has no ET
  });

  it('ops agent should stay within tier1-tier3', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const result = router.route({
      processType: 'channel', agentId: 'ops',
      text: 'architecture system design OKR roadmap postmortem',
    });
    assert.equal(result.tier, 'tier3');
    assert.equal(result.model, 'claude-opus-4-20250514');
    assert.equal(result.maxTokens, 16384);
    assert.equal(result.extendedThinking, null); // tier3 has no ET
  });

  it('code agent can reach tier4 with Extended Thinking', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const result = router.route({
      processType: 'channel', agentId: 'code',
      text: 'architecture system design trade-off. migration plan 필요. 심층 분석 요청.',
    });
    assert.equal(result.tier, 'tier4');
    assert.ok(result.extendedThinking);
    assert.equal(result.extendedThinking.budgetTokens, 10000);
    assert.equal(result.maxTokens, 32000);
  });
});

describe('ModelRouter — maxTokens per tier', () => {
  beforeEach(() => setTestConfig());

  it('should return correct maxTokens for each tier', () => {
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    // tier1 → 8192
    const t1 = router.route({ processType: 'channel', agentId: 'general', text: 'hi' });
    assert.equal(t1.maxTokens, 8192);

    // tier2 → 16384
    const t2 = router.route({ processType: 'channel', agentId: 'code', text: 'ok' });
    assert.equal(t2.maxTokens, 16384);

    // tier4 → 32000
    const t4 = router.route({
      processType: 'channel', agentId: 'code',
      text: 'architecture system design trade-off migration plan',
    });
    assert.equal(t4.maxTokens, 32000);
  });

  it('should fallback to global maxTokens if tier has none', () => {
    // Override tier1 to have no maxTokens
    configModule.config.anthropic.models.tier1 = { id: 'claude-haiku-4-5-20251001' };
    const { ModelRouter } = require('../src/core/model-router');
    const router = new ModelRouter();

    const result = router.route({ processType: 'channel', agentId: 'general', text: 'hi' });
    assert.equal(result.maxTokens, 4096); // global fallback
  });
});
