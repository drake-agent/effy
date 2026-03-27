/**
 * index.js — 평가 프레임워크 진입점 (Evaluation Framework Exports).
 *
 * 평가 시스템의 모든 공개 API를 내보낸다.
 *
 * 사용법:
 *   const evaluation = require('./evaluation');
 *   await evaluation.initialize();
 *   const metrics = await evaluation.getGlobalMetrics();
 */

const { getInstance: getFrameworkInstance, EvaluationFramework, MetricAccumulator } = require('./framework');
const {
  MetricCategory,
  Metric,
  AccuracyMetric,
  RelevanceMetric,
  LatencyMetric,
  CostMetric,
  ToolEfficiencyMetric,
  ComplexityMetric,
  MetricFactory,
  MetricBucket,
  MetricsCollector,
} = require('./metrics');
const { getInstance: getCollectorInstance, TelemetryCollector, initialize } = require('./collector');

/**
 * 평가 모듈의 공개 인터페이스.
 */
const evaluation = {
  // ─── 초기화 ───
  async initialize() {
    const collector = await require('./collector').initialize();
    return collector;
  },

  // ─── 프레임워크 접근 ───
  getFramework: () => getFrameworkInstance(),
  getCollector: () => getCollectorInstance(),

  // ─── 메트릭 집계 API ───
  async getGlobalMetrics(options) {
    const framework = getFrameworkInstance();
    return framework.getGlobalMetrics(options);
  },

  async getAgentMetrics(agentId, options) {
    const framework = getFrameworkInstance();
    return framework.getAgentMetrics(agentId, options);
  },

  async getModelMetrics(modelTier, options) {
    const framework = getFrameworkInstance();
    return framework.getModelMetrics(modelTier, options);
  },

  async getRecentRuns(options) {
    const framework = getFrameworkInstance();
    return framework.getRecentRuns(options);
  },

  // ─── 런타임 API ───
  startRun(sessionId, context) {
    const framework = getFrameworkInstance();
    return framework.startRun(sessionId, context);
  },

  recordToolCall(sessionId, toolInfo) {
    const framework = getFrameworkInstance();
    framework.recordToolCall(sessionId, toolInfo);
  },

  recordLLMCall(sessionId, llmInfo) {
    const framework = getFrameworkInstance();
    framework.recordLLMCall(sessionId, llmInfo);
  },

  setComplexity(sessionId, score) {
    const framework = getFrameworkInstance();
    framework.setComplexity(sessionId, score);
  },

  async completeRun(sessionId, context) {
    const framework = getFrameworkInstance();
    await framework.completeRun(sessionId, context);
  },

  // ─── 벤치마크 ───
  async runBenchmark() {
    const framework = getFrameworkInstance();
    return framework.runBenchmark();
  },

  // ─── 정리 ───
  async cleanup(days) {
    const framework = getFrameworkInstance();
    return framework.cleanup(days);
  },

  // ─── 스트림 ───
  async getMetricsStream() {
    const framework = getFrameworkInstance();
    return framework.getMetricsStream();
  },

  // ─── Express 통합 ───
  middleware() {
    const collector = getCollectorInstance();
    return collector.middleware();
  },

  getRouter() {
    const collector = getCollectorInstance();
    return collector.getRouter();
  },

  // ─── 상태 ───
  getStatus() {
    const framework = getFrameworkInstance();
    return framework.getStatus();
  },

  // ─── 메트릭 팩토리 ───
  metrics: {
    accuracy: MetricFactory.accuracy.bind(MetricFactory),
    relevance: MetricFactory.relevance.bind(MetricFactory),
    latency: MetricFactory.latency.bind(MetricFactory),
    cost: MetricFactory.cost.bind(MetricFactory),
    toolEfficiency: MetricFactory.toolEfficiency.bind(MetricFactory),
    complexity: MetricFactory.complexity.bind(MetricFactory),
  },

  // ─── 타입 내보내기 ───
  types: {
    MetricCategory,
    AccuracyMetric,
    RelevanceMetric,
    LatencyMetric,
    CostMetric,
    ToolEfficiencyMetric,
    ComplexityMetric,
    MetricsCollector,
  },
};

module.exports = evaluation;
