/**
 * prometheus.js — Prometheus 네이티브 메트릭 레지스트리.
 * /metrics 엔드포인트를 통해 표준 Prometheus 형식 노출.
 */

// If prom-client is not installed, gracefully degrade to no-op
let promClient;
try {
  promClient = require('prom-client');
} catch (e) {
  // prom-client module not installed
  promClient = null;
}

const { createLogger } = require('../shared/logger');
const log = createLogger('observability:prometheus');

class PrometheusMetrics {
  constructor(opts = {}) {
    this.enabled = opts.enabled ?? true;
    this.prefix = opts.prefix ?? 'effy_';
    this._registry = promClient ? new promClient.Registry() : null;

    if (this._registry) {
      // Collect default Node.js metrics (GC, event loop, memory)
      promClient.collectDefaultMetrics({
        register: this._registry,
        prefix: this.prefix,
      });
      this._defineMetrics();
      log.info('Prometheus metrics enabled');
    } else {
      log.warn('prom-client not installed; Prometheus metrics disabled');
    }
  }

  _defineMetrics() {
    // Histograms
    this.llmLatency = new promClient.Histogram({
      name: this.prefix + 'llm_latency_ms',
      help: 'LLM API call latency in milliseconds',
      labelNames: ['agent', 'model', 'provider', 'status'],
      buckets: [100, 300, 500, 1000, 2000, 5000, 10000, 30000],
      registers: [this._registry],
    });

    this.tokenConsumption = new promClient.Histogram({
      name: this.prefix + 'token_consumption',
      help: 'Tokens consumed per LLM call',
      labelNames: ['agent', 'model', 'type'], // type: input|output
      buckets: [50, 100, 500, 1000, 2000, 4000, 8000],
      registers: [this._registry],
    });

    this.memoryQueryLatency = new promClient.Histogram({
      name: this.prefix + 'memory_query_latency_ms',
      help: 'Memory search query latency',
      labelNames: ['mode'], // fts, vector, hybrid
      buckets: [5, 10, 25, 50, 100, 250, 500],
      registers: [this._registry],
    });

    this.toolExecutionLatency = new promClient.Histogram({
      name: this.prefix + 'tool_execution_latency_ms',
      help: 'Tool execution latency',
      labelNames: ['tool', 'status'],
      buckets: [10, 50, 100, 500, 1000, 5000],
      registers: [this._registry],
    });

    // Counters
    this.llmCalls = new promClient.Counter({
      name: this.prefix + 'llm_calls_total',
      help: 'Total LLM API calls',
      labelNames: ['agent', 'model', 'provider', 'status'],
      registers: [this._registry],
    });

    this.errors = new promClient.Counter({
      name: this.prefix + 'errors_total',
      help: 'Total errors by type',
      labelNames: ['agent', 'category', 'provider'],
      registers: [this._registry],
    });

    this.toolExecutions = new promClient.Counter({
      name: this.prefix + 'tool_executions_total',
      help: 'Total tool executions',
      labelNames: ['tool', 'status'],
      registers: [this._registry],
    });

    this.compactions = new promClient.Counter({
      name: this.prefix + 'compactions_total',
      help: 'Total memory compactions',
      labelNames: ['tier'],
      registers: [this._registry],
    });

    // Gauges
    this.activeSessions = new promClient.Gauge({
      name: this.prefix + 'active_sessions',
      help: 'Currently active sessions',
      registers: [this._registry],
    });

    this.queueDepth = new promClient.Gauge({
      name: this.prefix + 'queue_depth',
      help: 'Current queue depth',
      registers: [this._registry],
    });

    this.memoryUsage = new promClient.Gauge({
      name: this.prefix + 'memory_usage_bytes',
      help: 'Process memory usage',
      labelNames: ['type'], // rss, heapUsed, heapTotal, external
      registers: [this._registry],
    });

    this.circuitBreakerState = new promClient.Gauge({
      name: this.prefix + 'circuit_breaker_state',
      help: 'Circuit breaker state (0=closed, 0.5=half, 1=open)',
      labelNames: ['name'],
      registers: [this._registry],
    });
  }

  /**
   * Record an LLM API call with latency and token counts.
   * @param {string} agent - Agent name
   * @param {string} model - Model identifier
   * @param {string} provider - Provider name (anthropic, openai, google)
   * @param {string} status - Status (success, error, timeout)
   * @param {number} latencyMs - Latency in milliseconds
   * @param {number} inputTokens - Input tokens consumed
   * @param {number} outputTokens - Output tokens consumed
   */
  recordLLMCall(
    agent,
    model,
    provider,
    status,
    latencyMs,
    inputTokens,
    outputTokens
  ) {
    if (!this._registry) return;

    try {
      this.llmLatency.labels(agent, model, provider, status).observe(latencyMs);
      this.llmCalls.labels(agent, model, provider, status).inc();

      if (typeof inputTokens === 'number') {
        this.tokenConsumption.labels(agent, model, 'input').observe(inputTokens);
      }
      if (typeof outputTokens === 'number') {
        this.tokenConsumption
          .labels(agent, model, 'output')
          .observe(outputTokens);
      }
    } catch (e) {
      log.warn('Failed to record LLM call metrics', { error: e.message });
    }
  }

  /**
   * Record an error event.
   * @param {string} agent - Agent name
   * @param {string} category - Error category (rate_limit, auth, timeout, etc)
   * @param {string} provider - Provider name
   */
  recordError(agent, category, provider) {
    if (!this._registry) return;

    try {
      this.errors.labels(agent, category, provider).inc();
    } catch (e) {
      log.warn('Failed to record error metric', { error: e.message });
    }
  }

  /**
   * Record a tool execution.
   * @param {string} tool - Tool name
   * @param {string} status - Status (success, error)
   * @param {number} latencyMs - Execution time in milliseconds
   */
  recordToolExecution(tool, status, latencyMs) {
    if (!this._registry) return;

    try {
      this.toolExecutionLatency.labels(tool, status).observe(latencyMs);
      this.toolExecutions.labels(tool, status).inc();
    } catch (e) {
      log.warn('Failed to record tool execution metric', { error: e.message });
    }
  }

  /**
   * Record a memory compaction event.
   * @param {string} tier - Tier being compacted (recent, archive, etc)
   */
  recordCompaction(tier) {
    if (!this._registry) return;

    try {
      this.compactions.labels(tier).inc();
    } catch (e) {
      log.warn('Failed to record compaction metric', { error: e.message });
    }
  }

  /**
   * Record a memory search query.
   * @param {string} mode - Search mode (fts, vector, hybrid)
   * @param {number} latencyMs - Query latency in milliseconds
   */
  recordMemoryQuery(mode, latencyMs) {
    if (!this._registry) return;

    try {
      this.memoryQueryLatency.labels(mode).observe(latencyMs);
    } catch (e) {
      log.warn('Failed to record memory query metric', { error: e.message });
    }
  }

  /**
   * Set the number of active sessions.
   * @param {number} count
   */
  setActiveSessions(count) {
    if (!this._registry) return;

    try {
      this.activeSessions.set(Math.max(0, count));
    } catch (e) {
      log.warn('Failed to set active sessions metric', { error: e.message });
    }
  }

  /**
   * Set the current queue depth.
   * @param {number} depth
   */
  setQueueDepth(depth) {
    if (!this._registry) return;

    try {
      this.queueDepth.set(Math.max(0, depth));
    } catch (e) {
      log.warn('Failed to set queue depth metric', { error: e.message });
    }
  }

  /**
   * Update memory usage metrics from process.memoryUsage().
   */
  updateMemoryUsage() {
    if (!this._registry) return;

    try {
      const memUsage = process.memoryUsage();
      this.memoryUsage.labels('rss').set(memUsage.rss);
      this.memoryUsage.labels('heapUsed').set(memUsage.heapUsed);
      this.memoryUsage.labels('heapTotal').set(memUsage.heapTotal);
      this.memoryUsage.labels('external').set(memUsage.external);
    } catch (e) {
      log.warn('Failed to update memory usage metric', { error: e.message });
    }
  }

  /**
   * Set circuit breaker state.
   * @param {string} name - Circuit breaker name
   * @param {number} state - 0 = closed, 0.5 = half-open, 1 = open
   */
  setCircuitBreakerState(name, state) {
    if (!this._registry) return;

    try {
      this.circuitBreakerState.labels(name).set(state);
    } catch (e) {
      log.warn('Failed to set circuit breaker state metric', {
        error: e.message,
      });
    }
  }

  /**
   * Get all metrics in Prometheus text format.
   * @returns {Promise<string>}
   */
  async getMetrics() {
    if (!this._registry) {
      return '# Prometheus metrics not available (prom-client not installed)\n';
    }
    try {
      return await this._registry.metrics();
    } catch (e) {
      log.error('Failed to get metrics', { error: e.message });
      return '# Error collecting metrics\n';
    }
  }

  /**
   * Get the content type for Prometheus metrics.
   * @returns {string}
   */
  getContentType() {
    if (!this._registry) {
      return 'text/plain';
    }
    return this._registry.contentType;
  }

  /**
   * Check if Prometheus metrics are enabled.
   * @returns {boolean}
   */
  get isEnabled() {
    return !!this._registry;
  }
}

// Singleton instance
let _instance = null;

/**
 * Get or create the PrometheusMetrics singleton.
 * @param {Object} opts - Options (enabled, prefix)
 * @returns {PrometheusMetrics}
 */
function getMetrics(opts) {
  if (!_instance) {
    _instance = new PrometheusMetrics(opts);
  }
  return _instance;
}

module.exports = { PrometheusMetrics, getMetrics };
