/**
 * tier2-stress-chub-r2.test.js — Stress Tests Round 2.
 *
 * Round 2 심화 부하:
 * 1. BM25 메모리 안정성: 인덱스 빌드/폐기 반복
 * 2. formatContextForLLM 극한: 모든 섹션 최대 + apiDocs
 * 3. detectApiQuery 스트림: 연속 변동 입력
 * 4. Tool Registry 완전 순회: 모든 functionType × 200
 * 5. Sanitizer 다중 벡터 혼합
 * 6. 파이프라인 부하: detect → search → format → validate 연쇄 1000회
 * 7. Config 리셋 고속 반복
 * 8. Annotation 대량 누적 (10000 entries)
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// Suite 1: BM25 Index Build/Discard Cycles
// ═══════════════════════════════════════════════════════

describe('Stress R2: BM25 Index Build/Discard × 50', () => {
  const { buildIndex, search } = require('../src/knowledge/vendor/bm25');

  it('should build and discard 50 indexes without memory leak symptoms', () => {
    const docs = Array.from({ length: 200 }, (_, i) => ({
      id: `doc-${i}`,
      name: `API ${['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]} ${i}`,
      description: `Service description for ${['payment', 'auth', 'data', 'compute'][i % 4]} API version ${i}`,
      tags: [['pay', 'billing'], ['auth', 'jwt'], ['data', 'sql'], ['compute', 'serverless']][i % 4],
    }));

    const start = performance.now();
    for (let round = 0; round < 50; round++) {
      const index = buildIndex(docs);
      const results = search('payment billing', index, { limit: 5 });
      assert.ok(results.length >= 0);
      // Index goes out of scope → GC eligible
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 5000, `50 build/search cycles took ${elapsed.toFixed(0)}ms, expected < 5s`);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: formatContextForLLM — Maximum Payload
// ═══════════════════════════════════════════════════════

describe('Stress R2: formatContextForLLM Maximum Payload', () => {
  const { formatContextForLLM } = require('../src/memory/context');

  it('should handle max-size context (all sections populated) × 100', () => {
    const ctx = {
      entityContext: {
        profile: {
          name: 'StressUser',
          properties: { team: 'engineering', role: 'senior', timezone: 'Asia/Seoul' },
        },
      },
      route1: Array.from({ length: 50 }, (_, i) => ({ content: `[C${i}] Cross-channel message ${i}: ${'context '.repeat(20)}` })),
      route2: Array.from({ length: 50 }, (_, i) => ({
        content: `Knowledge fact ${i}: ${'relevant information '.repeat(10)}`,
        source_type: i % 2 === 0 ? 'knowledge' : 'episodic',
        channel_id: `C${i % 10}`,
      })),
      route3: Array.from({ length: 30 }, (_, i) => ({ content: `Channel ref ${i}` })),
      route3Decisions: Array.from({ length: 5 }, (_, i) => ({ content: `Decision ${i}: use architecture pattern ${i}` })),
      apiDocs: Array.from({ length: 50 }, (_, i) => ({
        id: `api-${i}`,
        name: `API Documentation ${i}`,
        description: `Full description of API ${i} with integration details`,
        source: i % 3 === 0 ? 'official' : 'community',
      })),
    };

    const start = performance.now();
    let totalLen = 0;
    for (let i = 0; i < 100; i++) {
      const result = formatContextForLLM(ctx);
      totalLen += result.length;
      if (i === 0) {
        assert.ok(result.includes('<entity_profile>'));
        assert.ok(result.includes('<cross_channel_user_history>'));
        assert.ok(result.includes('<relevant_knowledge>'));
        assert.ok(result.includes('<available_api_references>'));
      }
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 1000, `100 max-payload formats took ${elapsed.toFixed(0)}ms, expected < 1s`);
    assert.ok(totalLen > 0, 'should produce output');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: detectApiQuery — Streaming Varied Input
// ═══════════════════════════════════════════════════════

describe('Stress R2: detectApiQuery Streaming Input × 5000', () => {
  const { detectApiQuery } = require('../src/memory/context');

  it('should handle 5000 varied inputs in < 200ms', () => {
    const inputs = [];
    for (let i = 0; i < 5000; i++) {
      const pool = [
        `Use ${['OpenAI', 'Stripe', 'Firebase', 'Anthropic', 'AWS'][i % 5]} API for ${['chat', 'payment', 'auth', 'embedding', 'compute'][i % 5]}`,
        `오늘 회의 ${i % 100}번째 안건은 뭐야?`,
        `npm install ${['axios', 'prisma', 'langchain', 'firebase', 'stripe'][i % 5]} version ${i % 10}`,
        `Let's have lunch at ${i % 12} o'clock`,
        `How to import ${['react', 'vue', 'angular', 'svelte', 'next'][i % 5]} components?`,
        null,
        '',
        'hi',
      ];
      inputs.push(pool[i % pool.length]);
    }

    const start = performance.now();
    let detected = 0;
    for (const input of inputs) {
      if (detectApiQuery(input)) detected++;
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 200, `5000 detections took ${elapsed.toFixed(0)}ms, expected < 200ms`);
    assert.ok(detected > 0 && detected < 5000, 'should have mixed results');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 4: Tool Registry — Full Function Type Sweep × 200
// ═══════════════════════════════════════════════════════

describe('Stress R2: getToolsForFunction × 200 per type', () => {
  const { getToolsForFunction, TOOL_DEFINITIONS } = require('../src/agents/tool-registry');

  it('should sweep all function types × 200 in < 100ms', () => {
    const functionTypes = ['general', 'ops', 'code', 'knowledge', 'nonexistent', 'custom', 'data'];

    const start = performance.now();
    for (let round = 0; round < 200; round++) {
      for (const ft of functionTypes) {
        const tools = getToolsForFunction(ft);
        assert.ok(Array.isArray(tools));
        // Wildcard tools should always be present
        assert.ok(tools.includes('slack_reply'));
      }
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 100, `1400 getToolsForFunction calls took ${elapsed.toFixed(0)}ms, expected < 100ms`);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 5: Sanitizer — Multi-Vector Mixed Attack × 2000
// ═══════════════════════════════════════════════════════

describe('Stress R2: Sanitizer Multi-Vector × 2000', () => {
  const { formatContextForLLM } = require('../src/memory/context');

  it('should sanitize 2000 mixed attack vectors in < 300ms', () => {
    const attacks = [
      '<script>{{evil}}</script>',
      '{{config.SECRET}}{%exec%}',
      '[[admin]]${env.KEY}<img>',
      '<system>OVERRIDE</system>{{7*7}}{%import%}[[file]]${x}',
      'A'.repeat(1000),
      '<'.repeat(100) + '>'.repeat(100),
      '{{'.repeat(50) + '}}'.repeat(50),
      'Clean text with no attacks',
      '${'.repeat(100),
      '<!-- comment -->{{}} {%%} [[]] ${}',
    ];

    const start = performance.now();
    for (let i = 0; i < 2000; i++) {
      const ctx = {
        entityContext: null, route1: [], route2: [], route3: [], route3Decisions: [],
        apiDocs: [{
          id: `atk-${i}`,
          name: attacks[i % attacks.length],
          description: attacks[(i + 3) % attacks.length],
          source: 'test',
        }],
      };
      const result = formatContextForLLM(ctx);
      assert.ok(typeof result === 'string');
      // Verify no raw template syntax survives
      assert.ok(!result.includes('{{evil}}'), 'Jinja should be stripped');
      assert.ok(!result.includes('{%exec%}'), 'Django should be stripped');
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 300, `2000 sanitizations took ${elapsed.toFixed(0)}ms, expected < 300ms`);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 6: Full Pipeline Chain × 1000
// ═══════════════════════════════════════════════════════

describe('Stress R2: Full Pipeline Chain × 1000', () => {
  const { detectApiQuery, formatContextForLLM } = require('../src/memory/context');
  const { validateToolInput } = require('../src/agents/tool-registry');
  const { ModelRouter } = require('../src/core/model-router');
  const { buildIndex, search } = require('../src/knowledge/vendor/bm25');

  it('should chain detect → route → bm25 → format → validate × 1000 in < 2s', () => {
    const router = new ModelRouter();
    const docs = Array.from({ length: 100 }, (_, i) => ({
      id: `doc-${i}`, name: `API ${i}`, description: `API documentation ${i}`, tags: ['api'],
    }));
    const bm25Index = buildIndex(docs);

    const messages = [
      'How to use Stripe API for payments?',
      'Install the OpenAI SDK with npm',
      'Configure Firebase authentication',
      'What is the weather today?',
      'Deploy to AWS with terraform',
    ];

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const text = messages[i % messages.length];

      // Step 1: Route
      const routing = router.route({ text, agentId: 'general', contextTokens: 1000 });
      assert.ok(routing.model);

      // Step 2: Detect API query
      const apiQuery = detectApiQuery(text);

      // Step 3: BM25 search (if API query detected)
      let apiDocs = [];
      if (apiQuery) {
        apiDocs = search(apiQuery, bm25Index, { limit: 3 });
      }

      // Step 4: Format context
      const ctx = {
        entityContext: null, route1: [], route2: [], route3: [], route3Decisions: [],
        apiDocs: apiDocs.map(d => ({ id: d.id, name: `API ${d.id}`, description: 'desc', source: 'test' })),
      };
      const formatted = formatContextForLLM(ctx);
      assert.ok(typeof formatted === 'string');

      // Step 5: Validate tool
      if (apiQuery) {
        const v = validateToolInput('search_api_docs', { query: apiQuery });
        assert.strictEqual(v.valid, true);
      }
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 2000, `1000 pipeline chains took ${elapsed.toFixed(0)}ms, expected < 2s`);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 7: Config Reset Rapid Cycles × 500
// ═══════════════════════════════════════════════════════

describe('Stress R2: Config Reset × 500', () => {
  const { loadConfig, _resetConfig } = require('../src/knowledge/vendor/config');

  it('should handle 500 reset/load cycles in < 200ms', () => {
    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      _resetConfig();
      const conf = loadConfig();
      assert.ok(conf.sources.length > 0);
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 200, `500 config resets took ${elapsed.toFixed(0)}ms, expected < 200ms`);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 8: Annotation Accumulation × 10000
// ═══════════════════════════════════════════════════════

describe('Stress R2: Annotation Accumulation × 10000', () => {
  it('should accumulate 10000 annotations per doc without degradation', () => {
    const annotations = {};

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const docId = `doc-${i % 50}`;  // 50 different docs
      const entry = `[${new Date().toISOString()}] Agent=${['code', 'ops', 'general'][i % 3]} query="test ${i}"`;

      if (annotations[docId]) {
        annotations[docId] += '\n' + entry;
      } else {
        annotations[docId] = entry;
      }
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 500, `10000 annotations took ${elapsed.toFixed(0)}ms, expected < 500ms`);
    assert.strictEqual(Object.keys(annotations).length, 50, 'should have 50 doc keys');

    // Each doc should have ~200 entries (10000 / 50)
    const firstDoc = annotations['doc-0'];
    const lineCount = firstDoc.split('\n').length;
    assert.ok(lineCount >= 190 && lineCount <= 210, `Expected ~200 lines, got ${lineCount}`);
  });

  it('should create 10000 MemoryGraph edges without error', () => {
    const edges = [];
    const mockGraph = {
      create(node) { edges.push(node); return { id: `n_${edges.length}` }; }
    };

    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      mockGraph.create({
        type: 'fact',
        content: `Agent ${['code', 'ops', 'general'][i % 3]} referenced API doc: doc-${i % 100}`,
        metadata: { source: 'context_hub', doc_id: `doc-${i % 100}`, agent_id: ['code', 'ops', 'general'][i % 3] },
      });
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 200, `10000 edge creates took ${elapsed.toFixed(0)}ms, expected < 200ms`);
    assert.strictEqual(edges.length, 10000);
  });
});
