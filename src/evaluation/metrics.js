/**
 * metrics.js — 타입화된 평가 메트릭 (Typed Metrics).
 *
 * 모든 메트릭의 타입 정의, 검증, 통계 계산을 제공한다.
 * - 정확도 (accuracy): 기대 결과와 실제 결과의 일치도
 * - 관련성 (relevance): 응답의 쿼리 관련성 점수 (0~1)
 * - 지연시간 (latency): 요청~응답 총 소요시간 (ms)
 * - 비용 (cost): 예상 API 호출 비용 (USD)
 * - 도구 사용 효율성 (tool-use efficiency): 도구 호출 성공률 및 횟수
 *
 * 메트릭은 다음 세 수준에서 추적된다:
 * 1. 개별 메트릭 (Metric) — 단일 관찰
 * 2. 누적기 (Accumulator) — 세션 동안의 누적
 * 3. 집계 (Aggregate) — 시간대/에이전트별 통계
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('evaluation:metrics');

/**
 * 메트릭 카테고리 열거형.
 */
const MetricCategory = {
  ACCURACY: 'accuracy',
  RELEVANCE: 'relevance',
  LATENCY: 'latency',
  COST: 'cost',
  TOOL_EFFICIENCY: 'toolEfficiency',
  COMPLEXITY: 'complexity',
};

/**
 * 기본 메트릭 클래스.
 *
 * 모든 메트릭은 이를 확장한다.
 */
class Metric {
  constructor(category, name, value, unit = null) {
    this.category = category;
    this.name = name;
    this.value = value;
    this.unit = unit;
    this.timestamp = new Date().toISOString();
    this.tags = {};
  }

  /**
   * 메트릭에 태그 추가 (분류용).
   */
  addTag(key, val) {
    this.tags[key] = val;
    return this;
  }

  /**
   * 메트릭 유효성 검사.
   *
   * @returns {boolean}
   */
  validate() {
    if (!this.category || !this.name) return false;
    return true;
  }

  /**
   * 직렬화.
   */
  toJSON() {
    return {
      category: this.category,
      name: this.name,
      value: this.value,
      unit: this.unit,
      timestamp: this.timestamp,
      tags: this.tags,
    };
  }
}

/**
 * 정확도 메트릭 (Accuracy Metric).
 *
 * 기대 결과와 실제 결과가 일치하는 정도를 측정한다.
 * 0~1 범위의 스칼라 값.
 *
 * 예: expected="agent-a 실행", actual="agent-a 실행" → 1.0
 */
class AccuracyMetric extends Metric {
  /**
   * @param {number} score — 0~1 범위의 정확도 점수
   * @param {object} details — 정확도 분석 상세정보
   */
  constructor(score, details = {}) {
    super(MetricCategory.ACCURACY, 'accuracy', score);
    this.score = Math.max(0, Math.min(1, score)); // 0~1로 정규화
    this.details = details;
    this.unit = 'ratio';
  }

  validate() {
    return super.validate() && typeof this.score === 'number' && this.score >= 0 && this.score <= 1;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      score: this.score,
      details: this.details,
    };
  }
}

/**
 * 관련성 메트릭 (Relevance Metric).
 *
 * 응답이 쿼리와 얼마나 관련 있는지 측정한다.
 * 0~1 범위 스칼라 값 (보통 임베딩 기반 유사도).
 */
class RelevanceMetric extends Metric {
  /**
   * @param {number} score — 0~1 범위의 관련성 점수
   * @param {object} details
   * @param {string} details.method — 계산 방법 (e.g., 'cosine-similarity')
   */
  constructor(score, details = {}) {
    super(MetricCategory.RELEVANCE, 'relevance', score);
    this.score = Math.max(0, Math.min(1, score));
    this.details = details;
    this.unit = 'ratio';
  }

  validate() {
    return super.validate() && typeof this.score === 'number' && this.score >= 0 && this.score <= 1;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      score: this.score,
      details: this.details,
    };
  }
}

/**
 * 지연시간 메트릭 (Latency Metric).
 *
 * 요청 시작부터 응답 완료까지의 소요시간.
 */
class LatencyMetric extends Metric {
  /**
   * @param {number} milliseconds — 지연시간 (ms)
   * @param {object} breakdown — 단계별 분해
   * @param {number} breakdown.llmMs — LLM 호출 시간
   * @param {number} breakdown.toolMs — 도구 호출 시간
   * @param {number} breakdown.otherMs — 기타 오버헤드
   */
  constructor(milliseconds, breakdown = {}) {
    super(MetricCategory.LATENCY, 'latency', milliseconds);
    this.milliseconds = milliseconds;
    this.breakdown = breakdown;
    this.unit = 'ms';
  }

  validate() {
    return super.validate() && typeof this.milliseconds === 'number' && this.milliseconds >= 0;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      milliseconds: this.milliseconds,
      breakdown: this.breakdown,
    };
  }

  /**
   * 생산성 효율: 토큰 당 ms (낮을수록 좋음).
   */
  getProductivity(totalTokens) {
    return totalTokens > 0 ? (this.milliseconds / totalTokens).toFixed(4) : 0;
  }
}

/**
 * 비용 메트릭 (Cost Metric).
 *
 * API 호출의 추정 비용 (USD).
 */
class CostMetric extends Metric {
  /**
   * @param {number} usd — 비용 (USD)
   * @param {object} breakdown — 비용 분해
   * @param {number} breakdown.llmCost — LLM 호출 비용
   * @param {number} breakdown.toolCost — 도구 호출 비용
   * @param {object} breakdown.rates — 사용된 요금율
   */
  constructor(usd, breakdown = {}) {
    super(MetricCategory.COST, 'cost', usd);
    this.usd = usd;
    this.breakdown = breakdown;
    this.unit = 'USD';
  }

  validate() {
    return super.validate() && typeof this.usd === 'number' && this.usd >= 0;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      usd: this.usd,
      breakdown: this.breakdown,
    };
  }

  /**
   * 비용 효율: USD 당 토큰 (낮을수록 좋음).
   */
  getCostPerToken(totalTokens) {
    return totalTokens > 0 ? (this.usd / totalTokens * 1000000).toFixed(6) : 0;
  }
}

/**
 * 도구 사용 효율성 메트릭 (Tool-Use Efficiency Metric).
 *
 * 도구 호출의 성공률, 횟수, 오버헤드 등을 측정한다.
 */
class ToolEfficiencyMetric extends Metric {
  /**
   * @param {object} data
   * @param {number} data.callCount — 총 도구 호출 횟수
   * @param {number} data.successCount — 성공한 호출 횟수
   * @param {number} data.totalLatencyMs — 도구 호출 총 지연시간
   * @param {number} data.avgCallLatencyMs — 평균 호출당 지연시간
   * @param {Array<string>} data.toolsUsed — 사용된 도구 목록
   */
  constructor(data = {}) {
    super(MetricCategory.TOOL_EFFICIENCY, 'toolEfficiency', null);
    this.callCount = data.callCount || 0;
    this.successCount = data.successCount || 0;
    this.totalLatencyMs = data.totalLatencyMs || 0;
    this.avgCallLatencyMs = data.avgCallLatencyMs || 0;
    this.toolsUsed = data.toolsUsed || [];
    this.unit = 'count';
  }

  /**
   * 성공률 (0~1).
   */
  getSuccessRate() {
    return this.callCount > 0 ? this.successCount / this.callCount : 1.0;
  }

  /**
   * 도구 사용 당 평균 지연시간.
   */
  getAverageLatency() {
    return this.callCount > 0 ? this.totalLatencyMs / this.callCount : 0;
  }

  validate() {
    return super.validate() && typeof this.callCount === 'number' && this.callCount >= 0;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      callCount: this.callCount,
      successCount: this.successCount,
      successRate: this.getSuccessRate(),
      totalLatencyMs: this.totalLatencyMs,
      avgCallLatencyMs: this.getAverageLatency(),
      toolsUsed: this.toolsUsed,
    };
  }
}

/**
 * 복잡도 메트릭 (Complexity Metric).
 *
 * 요청/응답의 복잡도를 1~5 범위로 분류한다.
 * 1: 단순 (간단한 지식 검색)
 * 5: 복잡 (멀티 에이전트, 다단계 실행)
 */
class ComplexityMetric extends Metric {
  /**
   * @param {number} score — 1~5 범위의 복잡도 점수
   * @param {object} details — 복잡도 분석 상세정보
   * @param {Array<string>} details.factors — 복잡도에 영향을 미친 요소들
   */
  constructor(score, details = {}) {
    super(MetricCategory.COMPLEXITY, 'complexity', score);
    this.score = Math.max(1, Math.min(5, Math.round(score)));
    this.details = details;
    this.unit = 'scale';
  }

  validate() {
    return super.validate() && typeof this.score === 'number' && this.score >= 1 && this.score <= 5;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      score: this.score,
      label: this._getLabel(),
      details: this.details,
    };
  }

  _getLabel() {
    const labels = { 1: 'simple', 2: 'low', 3: 'medium', 4: 'high', 5: 'very-high' };
    return labels[this.score] || 'unknown';
  }
}

/**
 * 메트릭 팩토리.
 *
 * 타입 안전한 메트릭 생성을 제공한다.
 */
class MetricFactory {
  static accuracy(score, details) {
    const metric = new AccuracyMetric(score, details);
    if (!metric.validate()) {
      log.warn('[metrics] Invalid accuracy metric', { score });
    }
    return metric;
  }

  static relevance(score, details) {
    const metric = new RelevanceMetric(score, details);
    if (!metric.validate()) {
      log.warn('[metrics] Invalid relevance metric', { score });
    }
    return metric;
  }

  static latency(ms, breakdown) {
    const metric = new LatencyMetric(ms, breakdown);
    if (!metric.validate()) {
      log.warn('[metrics] Invalid latency metric', { ms });
    }
    return metric;
  }

  static cost(usd, breakdown) {
    const metric = new CostMetric(usd, breakdown);
    if (!metric.validate()) {
      log.warn('[metrics] Invalid cost metric', { usd });
    }
    return metric;
  }

  static toolEfficiency(data) {
    const metric = new ToolEfficiencyMetric(data);
    if (!metric.validate()) {
      log.warn('[metrics] Invalid tool efficiency metric', { data });
    }
    return metric;
  }

  static complexity(score, details) {
    const metric = new ComplexityMetric(score, details);
    if (!metric.validate()) {
      log.warn('[metrics] Invalid complexity metric', { score });
    }
    return metric;
  }
}

/**
 * 메트릭 버킷 (aggregation).
 *
 * 여러 메트릭을 모아서 통계를 계산한다.
 */
class MetricBucket {
  constructor(category) {
    this.category = category;
    this.metrics = [];
    this.stats = null;
  }

  add(metric) {
    if (metric.category === this.category) {
      this.metrics.push(metric);
      this._invalidateStats();
    }
  }

  /**
   * 통계 계산.
   */
  getStats() {
    if (this.stats !== null) return this.stats;

    if (this.metrics.length === 0) {
      return (this.stats = {
        count: 0,
        mean: null,
        median: null,
        min: null,
        max: null,
        stdDev: null,
        p95: null,
        p99: null,
      });
    }

    const values = this.metrics.map(m => m.value).filter(v => v !== null);
    if (values.length === 0) {
      return (this.stats = { count: 0, mean: null });
    }

    values.sort((a, b) => a - b);

    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const stdDev = Math.sqrt(variance);

    this.stats = {
      count: values.length,
      mean: Math.round(mean * 100) / 100,
      median: values[Math.floor(values.length / 2)],
      min: values[0],
      max: values[values.length - 1],
      stdDev: Math.round(stdDev * 100) / 100,
      p95: values[Math.floor(values.length * 0.95)],
      p99: values[Math.floor(values.length * 0.99)],
    };

    return this.stats;
  }

  _invalidateStats() {
    this.stats = null;
  }
}

/**
 * 메트릭 수집가.
 *
 * 여러 메트릭을 타입별로 분류하여 저장 및 조회한다.
 */
class MetricsCollector {
  constructor() {
    this.buckets = new Map();
    Object.values(MetricCategory).forEach(cat => {
      this.buckets.set(cat, new MetricBucket(cat));
    });
  }

  /**
   * 메트릭 추가.
   */
  add(metric) {
    const bucket = this.buckets.get(metric.category);
    if (bucket) {
      bucket.add(metric);
    }
  }

  /**
   * 카테고리별 통계 조회.
   */
  getStats(category) {
    const bucket = this.buckets.get(category);
    return bucket ? bucket.getStats() : null;
  }

  /**
   * 전체 통계 조회.
   */
  getAllStats() {
    const stats = {};
    Object.keys(this.buckets).forEach(cat => {
      stats[cat] = this.getStats(cat);
    });
    return stats;
  }

  /**
   * 메트릭 목록 조회.
   */
  getMetrics(category = null) {
    if (category) {
      const bucket = this.buckets.get(category);
      return bucket ? bucket.metrics : [];
    }

    let all = [];
    this.buckets.forEach(bucket => {
      all = all.concat(bucket.metrics);
    });
    return all;
  }
}

module.exports = {
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
};
