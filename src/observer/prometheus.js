/**
 * observer/prometheus.js — Prometheus 호환 메트릭스
 *
 * Counter/Gauge/Histogram 노출:
 * - LLM 호출 수, 토큰 사용량, 비용
 * - 활성 채널, 메모리 노드 수
 * - 도구 실행 시간, LLM 응답 시간
 *
 * /metrics 엔드포인트:
 *   GET /metrics → Prometheus 텍스트 포맷
 *
 * 사용:
 *   metrics.recordLLMCall('claude-opus', 500, 1200, 0.015);
 *   metrics.recordToolExec('search', 342, true);
 *   metrics.inc('custom_counter', { model: 'opus' });
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('observer:prometheus');

class PrometheusMetrics {
  constructor(opts = {}) {
    /** @type {string} 메트릭 이름 prefix */
    this.prefix = opts.prefix ?? 'effy_';

    /** @type {Map<string, Map<string, number>>} counter: name → (labels_key → value) */
    this._counters = new Map();

    /** @type {Map<string, Map<string, number>>} gauge: name → (labels_key → value) */
    this._gauges = new Map();

    /** @type {Map<string, { sum: number, count: number, buckets: number[] }>} histogram values */
    this._histograms = new Map();

    // 기본 메트릭 초기화
    this._initializeDefaults();
  }

  /**
   * 기본 메트릭 (카운터) 초기화
   * @private
   */
  _initializeDefaults() {
    // 기본 카운터
    this._counters.set('llm_calls_total', new Map());
    this._counters.set('tokens_used_total', new Map());
    this._counters.set('tool_executions_total', new Map());

    // 기본 게이지
    this._gauges.set('active_channels', new Map());
    this._gauges.set('memory_nodes_count', new Map());
  }

  /**
   * 레이블 dict → 정규화된 문자열 키
   * @private
   */
  _labelsKey(labels) {
    if (!labels || Object.keys(labels).length === 0) {
      return '__no_labels__';
    }
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
  }

  /**
   * 카운터 증가
   *
   * @param {string} name - e.g., 'llm_calls_total', 'tokens_used_total'
   * @param {Object} [labels={}] - { model: 'opus', agent: 'analyst' }
   * @param {number} [value=1]
   */
  inc(name, labels = {}, value = 1) {
    if (!this._counters.has(name)) {
      this._counters.set(name, new Map());
    }
    const labelMap = this._counters.get(name);
    const key = this._labelsKey(labels);
    const current = labelMap.get(key) || 0;
    labelMap.set(key, current + value);
    log.debug('Counter incremented', { name, labels, value });
  }

  /**
   * 게이지 설정
   *
   * @param {string} name - e.g., 'active_channels', 'memory_nodes_count'
   * @param {Object} [labels={}]
   * @param {number} value
   */
  set(name, labels = {}, value) {
    if (!this._gauges.has(name)) {
      this._gauges.set(name, new Map());
    }
    const labelMap = this._gauges.get(name);
    const key = this._labelsKey(labels);
    labelMap.set(key, value);
    log.debug('Gauge set', { name, labels, value });
  }

  /**
   * 히스토그램 값 기록 (지연시간, 지속시간 등)
   *
   * @param {string} name - e.g., 'llm_response_seconds', 'tool_execution_seconds'
   * @param {Object} [labels={}]
   * @param {number} value - 값 (초 또는 밀리초)
   */
  observe(name, labels = {}, value) {
    const key = `${name}:${this._labelsKey(labels)}`;
    if (!this._histograms.has(key)) {
      this._histograms.set(key, { sum: 0, count: 0, buckets: [] });
    }
    const hist = this._histograms.get(key);
    hist.sum += value;
    hist.count += 1;
    hist.buckets.push(value);
    // Keep only last 10000 observations to prevent unbounded growth
    if (hist.buckets.length > 10000) {
      hist.buckets = hist.buckets.slice(-10000);
    }
    log.debug('Histogram observed', { name, labels, value });
  }

  /**
   * Prometheus 텍스트 포맷 생성
   *
   * @returns {string} - OpenMetrics/Prometheus exposition format
   */
  serialize() {
    const lines = [];

    // HELP + TYPE 주석, 그 다음 메트릭
    const allNames = new Set();
    for (const name of this._counters.keys()) {
      allNames.add(name);
    }
    for (const name of this._gauges.keys()) {
      allNames.add(name);
    }

    for (const name of allNames) {
      const fullName = this.prefix + name;

      // HELP
      lines.push(`# HELP ${fullName} Effy metric: ${name}`);

      // TYPE
      if (this._counters.has(name)) {
        lines.push(`# TYPE ${fullName} counter`);
      } else if (this._gauges.has(name)) {
        lines.push(`# TYPE ${fullName} gauge`);
      }

      // 카운터 값
      if (this._counters.has(name)) {
        const labelMap = this._counters.get(name);
        for (const [labelKey, value] of labelMap) {
          if (labelKey !== '__no_labels__') {
            lines.push(`${fullName}{${labelKey}} ${value}`);
          } else {
            lines.push(`${fullName} ${value}`);
          }
        }
      }

      // 게이지 값
      if (this._gauges.has(name)) {
        const labelMap = this._gauges.get(name);
        for (const [labelKey, value] of labelMap) {
          if (labelKey !== '__no_labels__') {
            lines.push(`${fullName}{${labelKey}} ${value}`);
          } else {
            lines.push(`${fullName} ${value}`);
          }
        }
      }

      lines.push(''); // blank line between metrics
    }

    // 히스토그램
    for (const [key, hist] of this._histograms) {
      const fullName = this.prefix + key.split(':')[0] + '_seconds';
      lines.push(`# HELP ${fullName} Histogram`);
      lines.push(`# TYPE ${fullName} histogram`);
      if (hist.count > 0) {
        const avg = (hist.sum / hist.count).toFixed(4);
        lines.push(`${fullName}_sum ${hist.sum.toFixed(4)}`);
        lines.push(`${fullName}_count ${hist.count}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Express/Fastify /metrics 엔드포인트 미들웨어
   *
   * @returns {Function} (req, res, next)
   */
  middleware() {
    return (req, res, next) => {
      try {
        if (req.path === '/metrics' || req.url === '/metrics') {
          const output = this.serialize();
          res.set('Content-Type', 'text/plain; version=0.0.4');
          res.send(output);
        } else {
          next();
        }
      } catch (err) {
        log.error('Metrics middleware error', err);
        res.status(500).json({ error: 'metrics generation failed' });
      }
    };
  }

  /**
   * LLM 호출 기록 (convenience method)
   *
   * @param {string} model - e.g., 'claude-opus'
   * @param {number} tokens - 사용 토큰 수
   * @param {number} durationMs - 응답 시간 (ms)
   * @param {number} costUsd - 비용 (USD)
   */
  recordLLMCall(model, tokens, durationMs, costUsd) {
    const labels = { model };
    this.inc('llm_calls_total', labels);
    this.inc('tokens_used_total', labels, tokens);
    this.observe('llm_response_seconds', labels, durationMs / 1000);
    this.inc('llm_cost_usd_total', labels, costUsd);
  }

  /**
   * 도구 실행 기록 (convenience method)
   *
   * @param {string} toolName - e.g., 'search', 'fetch'
   * @param {number} durationMs - 실행 시간 (ms)
   * @param {boolean} [success=true]
   */
  recordToolExec(toolName, durationMs, success = true) {
    const labels = { tool: toolName, success: success ? 'true' : 'false' };
    this.inc('tool_executions_total', labels);
    this.observe('tool_execution_seconds', labels, durationMs / 1000);
  }

  /**
   * 모든 메트릭 조회 (디버깅용)
   *
   * @returns {{ counters, gauges, histograms }}
   */
  getAllMetrics() {
    const counters = {};
    for (const [name, labelMap] of this._counters) {
      counters[name] = Object.fromEntries(labelMap);
    }
    const gauges = {};
    for (const [name, labelMap] of this._gauges) {
      gauges[name] = Object.fromEntries(labelMap);
    }
    const histograms = {};
    for (const [key, hist] of this._histograms) {
      histograms[key] = { sum: hist.sum, count: hist.count, avg: hist.sum / hist.count };
    }
    return { counters, gauges, histograms };
  }
}

module.exports = { PrometheusMetrics };
