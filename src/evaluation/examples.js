/* eslint-disable no-undef */
/**
 * examples.js — 평가 프레임워크 사용 예제.
 *
 * 실제 통합 시 참고할 수 있는 다양한 시나리오를 보여줍니다.
 */

// ═══════════════════════════════════════════════════════════════════════════
// 예제 1: 기본 초기화 및 메트릭 수집
// ═══════════════════════════════════════════════════════════════════════════

async function example1_basicUsage() {
  const evaluation = require('./index');

  // 1. 초기화
  await evaluation.initialize();

  // 2. 세션 시작
  const sessionId = 'session-123';
  const runId = evaluation.startRun(sessionId, {
    agentId: 'agent-search',
    modelTier: 'opus',
  });

  console.log(`[EVAL] Started run: ${runId}`);

  // 3. 도구 호출 기록
  evaluation.recordToolCall(sessionId, {
    name: 'web-search',
    latencyMs: 250,
    success: true,
    metadata: { query: 'AI news' },
  });

  evaluation.recordToolCall(sessionId, {
    name: 'summarizer',
    latencyMs: 180,
    success: true,
  });

  // 4. LLM 호출 기록
  evaluation.recordLLMCall(sessionId, {
    inputTokens: 1200,
    outputTokens: 400,
    costUsd: 0.008,
    latencyMs: 1500,
  });

  // 5. 복잡도 설정
  evaluation.setComplexity(sessionId, 2); // 1~5

  // 6. 세션 완료
  await evaluation.completeRun(sessionId, { status: 'completed' });

  // 7. 메트릭 조회
  const metrics = await evaluation.getGlobalMetrics({ hours: 24 });
  console.log('[EVAL] Global metrics:', metrics);
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 2: Express 통합
// ═══════════════════════════════════════════════════════════════════════════

async function example2_expressIntegration() {
  const express = require('express');
  const evaluation = require('./index');

  const app = express();

  // 1. 초기화
  await evaluation.initialize();

  // 2. 미들웨어 추가
  app.use(evaluation.middleware());

  // 3. 평가 대시보드 API 마운트
  app.use('/api/evaluation', evaluation.getRouter());

  // 4. 커스텀 엔드포인트
  app.post('/chat', async (req, res) => {
    const sessionId = req.sessionId; // 미들웨어에서 설정됨
    const { message, agentId } = req.body;

    // 에이전트 실행 (스텁)
    const response = await runAgent(message, agentId);

    // 복잡도 분류
    const complexity = classifyComplexity(message);
    evaluation.setComplexity(sessionId, complexity);

    res.json({ response });
    // 미들웨어가 자동으로 completeRun() 호출
  });

  app.listen(3100, () => {
    console.log('[EVAL] Server with evaluation listening on 3100');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 3: 메트릭 팩토리 사용 (타입화)
// ═══════════════════════════════════════════════════════════════════════════

function example3_metricFactory() {
  const { metrics } = require('./index');
  const { MetricsCollector } = require('./metrics');

  const collector = new MetricsCollector();

  // 정확도 메트릭
  const accuracy = metrics.accuracy(0.95, {
    expected: 'agent-a',
    actual: 'agent-a',
    method: 'exact-match',
  });
  collector.add(accuracy);

  // 지연시간 메트릭
  const latency = metrics.latency(2500, {
    llmMs: 1500,
    toolMs: 800,
    otherMs: 200,
  });
  collector.add(latency);

  // 비용 메트릭
  const cost = metrics.cost(0.008, {
    llmCost: 0.0065,
    toolCost: 0.0015,
    rates: {
      inputTokenPrice: 0.003,
      outputTokenPrice: 0.015,
    },
  });
  collector.add(cost);

  // 도구 효율성
  const toolEff = metrics.toolEfficiency({
    callCount: 3,
    successCount: 3,
    totalLatencyMs: 600,
    avgCallLatencyMs: 200,
    toolsUsed: ['search', 'summarize', 'format'],
  });
  collector.add(toolEff);

  // 복잡도
  const complexity = metrics.complexity(3, {
    factors: ['multi_tool', 'requires_reasoning'],
  });
  collector.add(complexity);

  // 통계 조회
  const stats = collector.getAllStats();
  console.log('[METRICS] Statistics:', stats);

  // 특정 카테고리 통계
  const latencyStats = collector.getStats('latency');
  console.log('[METRICS] Latency stats:', latencyStats);
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 4: 쿼리 및 분석
// ═══════════════════════════════════════════════════════════════════════════

async function example4_queriesAndAnalysis() {
  const evaluation = require('./index');

  // 전역 메트릭
  const globalMetrics = await evaluation.getGlobalMetrics({ hours: 24 });
  console.log('[ANALYSIS] Global metrics:', {
    avgLatency: `${globalMetrics.avgLatencyMs}ms`,
    costPerDay: `$${globalMetrics.totalCostUsd}`,
    successRate: `${globalMetrics.successRate}%`,
    avgComplexity: globalMetrics.avgComplexity,
  });

  // 에이전트별 메트릭
  const agentMetrics = await evaluation.getAgentMetrics('agent-research', {
    hours: 24,
  });
  console.log('[ANALYSIS] Agent metrics:', {
    runCount: agentMetrics.runCount,
    avgTokensPerRun: `${agentMetrics.avgTokensIn + agentMetrics.avgTokensOut} tokens`,
    costPerRun: `$${(agentMetrics.totalCostUsd / agentMetrics.runCount).toFixed(6)}`,
  });

  // 모델별 메트릭
  const opusMetrics = await evaluation.getModelMetrics('opus', { hours: 24 });
  console.log('[ANALYSIS] Opus metrics:', {
    avgLatency: `${opusMetrics.avgLatencyMs}ms`,
    totalCost: `$${opusMetrics.totalCostUsd}`,
  });

  const haikuMetrics = await evaluation.getModelMetrics('haiku', { hours: 24 });
  console.log('[ANALYSIS] Haiku metrics:', {
    avgLatency: `${haikuMetrics.avgLatencyMs}ms`,
    totalCost: `$${haikuMetrics.totalCostUsd}`,
  });

  // 최근 실행 조회
  const recentRuns = await evaluation.getRecentRuns({
    limit: 10,
    agentId: 'agent-research',
    status: 'completed',
  });

  console.log('[ANALYSIS] Recent runs:', recentRuns.map(r => ({
    runId: r.runId,
    latencyMs: r.latencyMs,
    costUsd: r.costUsd,
    completedAt: r.completedAt,
  })));
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 5: 벤치마크 실행
// ═══════════════════════════════════════════════════════════════════════════

async function example5_benchmark() {
  const evaluation = require('./index');

  // benchmarks/test-1.json 파일 생성
  // [
  //   {
  //     "name": "Simple Query",
  //     "input": "What is 2+2?",
  //     "expectedAgent": "haiku",
  //     "expectedTokensLessThan": 200,
  //     "expectedLatencyLessThanMs": 5000,
  //     "minSuccessRate": 0.99
  //   }
  // ]

  const result = await evaluation.runBenchmark();

  console.log('[BENCHMARK] Results:', {
    status: result.status,
    total: result.summary.total,
    passed: result.summary.passed,
    failed: result.summary.failed,
    passRate: result.summary.passRate,
  });

  // 각 테스트의 상세 결과
  result.results.forEach(r => {
    console.log(`[BENCHMARK] ${r.name}: ${r.passed ? 'PASS' : 'FAIL'}`, r.failures);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 6: 실시간 SSE 스트림 (대시보드용)
// ═══════════════════════════════════════════════════════════════════════════

async function example6_sseStream() {
  const evaluation = require('./index');
  const express = require('express');

  const app = express();
  await evaluation.initialize();

  app.get('/metrics-stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await evaluation.getMetricsStream();
    res.write(stream);
    res.end();
  });

  // 클라이언트 측:
  // const evtSource = new EventSource('/metrics-stream');
  // evtSource.onmessage = (event) => {
  //   const data = JSON.parse(event.data);
  //   if (data.type === 'global') {
  //     updateGlobalMetrics(data.data);
  //   } else if (data.type === 'recent') {
  //     updateRecentRuns(data.data);
  //   }
  // };
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 7: 수동 메트릭 수집 (API 통합)
// ═══════════════════════════════════════════════════════════════════════════

async function example7_manualCollection() {
  const evaluation = require('./index');
  const { config } = require('../config');

  const framework = evaluation.getFramework();

  // 런타임 외부에서도 메트릭을 기록할 수 있음
  const sessionId = 'batch-job-123';
  const runId = framework.startRun(sessionId, {
    agentId: 'batch-processor',
    modelTier: 'haiku',
  });

  // 배치 작업 시뮬레이션
  const startTime = Date.now();

  // 도구 체인 실행
  for (const toolName of ['extract', 'validate', 'transform']) {
    const toolStart = Date.now();
    // 도구 실행...
    const toolLatency = Date.now() - toolStart;

    evaluation.recordToolCall(sessionId, {
      name: toolName,
      latencyMs: toolLatency,
      success: true,
    });
  }

  // LLM 호출
  evaluation.recordLLMCall(sessionId, {
    inputTokens: 1000,
    outputTokens: 500,
    costUsd: 0.004,
    latencyMs: 2000,
  });

  const totalLatency = Date.now() - startTime;
  evaluation.setComplexity(sessionId, 2);

  await evaluation.completeRun(sessionId, { status: 'completed' });

  console.log(`[BATCH] Completed in ${totalLatency}ms`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 8: 정리 및 유지보수
// ═══════════════════════════════════════════════════════════════════════════

async function example8_maintenance() {
  const evaluation = require('./index');

  // 30일 이상 된 데이터 삭제 (config의 retentionDays)
  await evaluation.cleanup();

  // 또는 특정 기간으로 지정
  await evaluation.cleanup(7); // 7일 이상 된 데이터 삭제

  // 상태 확인
  const status = evaluation.getStatus();
  console.log('[MAINTENANCE] Evaluation status:', status);
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 9: 복잡도 분류 헬퍼
// ═══════════════════════════════════════════════════════════════════════════

function classifyComplexity(input) {
  /**
   * 1: 단순 — 단순한 팩트 검색, 계산
   * 2: 낮음 — 단일 도구 호출 필요
   * 3: 중간 — 다단계 실행, 2~3개 도구
   * 4: 높음 — 멀티 에이전트, 복잡한 로직
   * 5: 매우 높음 — 대규모 워크플로우
   */

  // 입력 길이
  if (input.length < 50) return 1;

  // 키워드 분석
  const keywords = input.toLowerCase();

  if (keywords.includes('search') || keywords.includes('find')) return 2;
  if (keywords.includes('analyze') || keywords.includes('compare')) return 3;
  if (keywords.includes('workflow') || keywords.includes('multi-step')) return 4;
  if (keywords.includes('autonomous') || keywords.includes('delegate')) return 5;

  // 단어 수
  const words = input.split(/\s+/).length;
  if (words < 15) return 1;
  if (words < 30) return 2;
  if (words < 50) return 3;
  if (words < 100) return 4;
  return 5;
}

// ═══════════════════════════════════════════════════════════════════════════
// 예제 10: 성능 분석 및 최적화 제안
// ═══════════════════════════════════════════════════════════════════════════

async function example10_performanceAnalysis() {
  const evaluation = require('./index');

  const metrics = await evaluation.getGlobalMetrics({ hours: 24 });

  // 성능 분석
  const analysis = {
    latency: {
      current: metrics.avgLatencyMs,
      target: 3000, // ms
      isOptimal: metrics.avgLatencyMs < 3000,
    },
    cost: {
      current: metrics.totalCostUsd,
      efficiency: (metrics.avgTokensIn + metrics.avgTokensOut) / (metrics.totalCostUsd || 1),
    },
    toolUsage: {
      avgCallsPerRun: metrics.avgToolCallCount,
      successRate: metrics.successRate,
    },
  };

  // 최적화 제안
  const suggestions = [];

  if (analysis.latency.current > analysis.latency.target) {
    suggestions.push({
      type: 'performance',
      severity: 'high',
      message: `Average latency (${analysis.latency.current}ms) exceeds target (${analysis.latency.target}ms)`,
      action: 'Consider using faster model tier or reducing tool count',
    });
  }

  if (analysis.toolUsage.successRate < 95) {
    suggestions.push({
      type: 'reliability',
      severity: 'medium',
      message: `Tool success rate (${analysis.toolUsage.successRate}%) is below 95%`,
      action: 'Review tool implementations and error handling',
    });
  }

  if (analysis.cost.efficiency < 1000) {
    suggestions.push({
      type: 'cost',
      severity: 'low',
      message: `Cost efficiency (${analysis.cost.efficiency.toFixed(0)} tokens/USD) could be improved`,
      action: 'Consider using cheaper models for simple queries',
    });
  }

  console.log('[ANALYSIS] Performance Summary:', analysis);
  console.log('[ANALYSIS] Optimization Suggestions:', suggestions);
}

// ═══════════════════════════════════════════════════════════════════════════
// 내보내기
// ═══════════════════════════════════════════════════════════════════════════

if (require.main === module) {
  // 직접 실행 시 예제 1 실행
  example1_basicUsage().catch(console.error);
}

module.exports = {
  example1_basicUsage,
  example2_expressIntegration,
  example3_metricFactory,
  example4_queriesAndAnalysis,
  example5_benchmark,
  example6_sseStream,
  example7_manualCollection,
  example8_maintenance,
  example9_complexityClassification: classifyComplexity,
  example10_performanceAnalysis,
};
