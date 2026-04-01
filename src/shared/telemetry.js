/**
 * telemetry.js — OpenTelemetry Integration for Observability.
 *
 * OTEL SDK 초기화 및 instrumentation.
 * - Traces: LLM 호출, 도구 실행, 메모리 작업, 파이프라인 단계
 * - Metrics: 레이턴시, 토큰 사용, 에러율, 큐 깊이
 * - Exporters: OTLP/gRPC, OTLP/HTTP, console, RunLogger 통합
 * - Middleware: withSpan, recordMetric, withContext
 *
 * Config:
 *   telemetry.enabled: true
 *   telemetry.exporter: otlp-http | otlp-grpc | console | none
 *   telemetry.endpoint: http://localhost:4318
 *   telemetry.serviceName: effy
 *   telemetry.sampleRate: 1.0
 *   telemetry.metrics.enabled: true
 *   telemetry.metrics.intervalMs: 60000
 */

const { config } = require('../config');
const { createLogger } = require('./logger');
const { RunLogger } = require('./run-logger');

const log = createLogger('telemetry');

// ─── 설정 로드 ──────────────────────────────────────────────────

const TELEMETRY_CONFIG = {
  enabled: config.telemetry?.enabled ?? true,
  exporter: config.telemetry?.exporter ?? 'console',
  endpoint: config.telemetry?.endpoint ?? 'http://localhost:4318',
  serviceName: config.telemetry?.serviceName ?? 'effy',
  sampleRate: config.telemetry?.sampleRate ?? 1.0,
  metrics: {
    enabled: config.telemetry?.metrics?.enabled ?? true,
    intervalMs: config.telemetry?.metrics?.intervalMs ?? 60000,
  },
};

// ─── OTEL 라이브러리 (조건부 로드) ──────────────────────────

let _otelAvailable = false;
let _tracerProvider = null;
let _meterProvider = null;
let _tracer = null;
let _meter = null;

/**
 * OTEL SDK 초기화 (선택적 의존성).
 * SDK가 없으면 graceful하게 no-op 모드로 작동.
 */
function _initializeOtel() {
  if (!TELEMETRY_CONFIG.enabled) {
    log.info('Telemetry disabled');
    return false;
  }

  try {
    // OTEL SDK 로드 (선택적 의존성)
    const { NodeTracerProvider } = require('@opentelemetry/node');
    const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
    const { Resource } = require('@opentelemetry/resources');
    const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

    // Exporter 선택
    let traceExporter, metricReader;

    if (TELEMETRY_CONFIG.exporter === 'otlp-grpc') {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
      traceExporter = new OTLPTraceExporter({
        url: TELEMETRY_CONFIG.endpoint,
      });
    } else if (TELEMETRY_CONFIG.exporter === 'otlp-http') {
      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      traceExporter = new OTLPTraceExporter({
        url: TELEMETRY_CONFIG.endpoint,
      });
    } else if (TELEMETRY_CONFIG.exporter === 'console') {
      const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-node');
      traceExporter = new ConsoleSpanExporter();
    }

    // Metric Reader
    if (TELEMETRY_CONFIG.metrics.enabled) {
      if (TELEMETRY_CONFIG.exporter === 'otlp-grpc') {
        const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
        const exporter = new OTLPMetricExporter({
          url: TELEMETRY_CONFIG.endpoint,
        });
        metricReader = new PeriodicExportingMetricReader({
          exporter,
          intervalMillis: TELEMETRY_CONFIG.metrics.intervalMs,
        });
      } else if (TELEMETRY_CONFIG.exporter === 'otlp-http') {
        const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
        const exporter = new OTLPMetricExporter({
          url: TELEMETRY_CONFIG.endpoint,
        });
        metricReader = new PeriodicExportingMetricReader({
          exporter,
          intervalMillis: TELEMETRY_CONFIG.metrics.intervalMs,
        });
      } else if (TELEMETRY_CONFIG.exporter === 'console') {
        const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
        const { ConsoleMetricExporter } = require('@opentelemetry/sdk-metrics');
        metricReader = new PeriodicExportingMetricReader({
          exporter: new ConsoleMetricExporter(),
          intervalMillis: TELEMETRY_CONFIG.metrics.intervalMs,
        });
      }
    }

    // Resource 정의
    const resource = Resource.default().merge(new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: TELEMETRY_CONFIG.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: process.env.VERSION || '1.0.0',
    }));

    // TracerProvider 생성
    _tracerProvider = new NodeTracerProvider({
      resource,
      sampler: _createSampler(TELEMETRY_CONFIG.sampleRate),
    });

    if (traceExporter) {
      const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-node');
      _tracerProvider.addSpanProcessor(new BatchSpanProcessor(traceExporter));
    }

    // MeterProvider 생성
    if (TELEMETRY_CONFIG.metrics.enabled && metricReader) {
      _meterProvider = new MeterProvider({
        resource,
        readers: [metricReader],
      });
    } else {
      _meterProvider = new MeterProvider({ resource });
    }

    // Tracer & Meter 인스턴스
    _tracer = _tracerProvider.getTracer(TELEMETRY_CONFIG.serviceName);
    _meter = _meterProvider.getMeter(TELEMETRY_CONFIG.serviceName);

    _otelAvailable = true;
    log.info('OTEL initialized', { exporter: TELEMETRY_CONFIG.exporter });
    return true;
  } catch (err) {
    log.warn('OTEL not available, using no-op mode', { error: err.message });
    _otelAvailable = false;
    return false;
  }
}

/**
 * 샘플 레이트 기반 Sampler 생성.
 */
function _createSampler(sampleRate) {
  try {
    const { ProbabilitySampler } = require('@opentelemetry/sdk-trace-node');
    return new ProbabilitySampler(Math.max(0, Math.min(1, sampleRate)));
  } catch (e) {
    log.debug('ProbabilitySampler not available', { error: e.message });
    return { shouldSample: () => true };
  }
}

// ─── No-op 구현 (OTEL 미사용 시) ──────────────────────────────

/**
 * No-op Span (OTEL 미사용 시).
 */
class NoOpSpan {
  setStatus() { return this; }
  setAttributes() { return this; }
  addEvent() { return this; }
  recordException() { return this; }
  end() { return this; }
  isRecording() { return false; }
}

/**
 * No-op Context (OTEL 미사용 시).
 */
class NoOpContext {
  getValue() { return undefined; }
}

// ─── RunLogger 통합 ────────────────────────────────────────────

let _runLogger = null;

/**
 * RunLogger 초기화 (NDJSON 내보내기).
 */
function _initializeRunLogger() {
  try {
    _runLogger = new RunLogger('./data/runs');
    log.info('RunLogger initialized');
  } catch (err) {
    log.warn('RunLogger initialization failed', { error: err.message });
  }
}

// ─── Span 유틸리티 ────────────────────────────────────────────

/**
 * Span 생성 및 실행 (wrapper 함수).
 * OTEL이 활성화되면 실제 span, 아니면 no-op.
 *
 * @param {string} name - Span 이름
 * @param {object} attributes - Span 속성
 * @param {Function} fn - 실행할 함수 (span 인자 전달)
 * @returns {Promise<any>}
 */
async function withSpan(name, attributes = {}, fn) {
  if (!_otelAvailable || !_tracer) {
    // No-op: span 없이 함수 직접 실행
    return fn(new NoOpSpan());
  }

  return _tracer.startActiveSpan(name, async (span) => {
    try {
      span.setAttributes(attributes);
      const result = await fn(span);
      span.setStatus({ code: 0 }); // OK
      return result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: 2, message: err.message }); // ERROR
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * 동기식 Span 실행.
 */
function withSpanSync(name, attributes = {}, fn) {
  if (!_otelAvailable || !_tracer) {
    return fn(new NoOpSpan());
  }

  const span = _tracer.startSpan(name);
  try {
    span.setAttributes(attributes);
    const result = fn(span);
    span.setStatus({ code: 0 });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus({ code: 2, message: err.message });
    throw err;
  } finally {
    span.end();
  }
}

// ─── 메트릭 유틸리티 ────────────────────────────────────────────

/**
 * 메트릭 기록 (Counter, Histogram, Gauge 등).
 *
 * @param {string} name - 메트릭 이름
 * @param {string} type - counter | histogram | gauge
 * @param {number} value - 값
 * @param {object} attributes - 속성 (레이블)
 */
function recordMetric(name, type, value, attributes = {}) {
  if (!_otelAvailable || !_meter) {
    return;
  }

  try {
    let metric = _meter._metrics?.get(name);

    if (!metric) {
      // 메트릭 동적 생성
      if (type === 'counter') {
        metric = _meter.createCounter(name);
      } else if (type === 'histogram') {
        metric = _meter.createHistogram(name);
      } else if (type === 'gauge') {
        metric = _meter.createObservableGauge(name);
      }
    }

    if (metric) {
      if (type === 'counter') {
        metric.add(value, attributes);
      } else if (type === 'histogram') {
        metric.record(value, attributes);
      } else if (type === 'gauge') {
        metric.record(value, attributes);
      }
    }
  } catch (err) {
    log.warn('Failed to record metric', { name, error: err.message });
  }
}

/**
 * 편의 함수 — request latency 기록.
 */
function recordLatency(name, latencyMs, attributes = {}) {
  recordMetric(name, 'histogram', latencyMs, attributes);
}

/**
 * 편의 함수 — request count 증가.
 */
function recordRequestCount(name, attributes = {}) {
  recordMetric(name, 'counter', 1, attributes);
}

/**
 * 편의 함수 — error count 증가.
 */
function recordError(name, error, attributes = {}) {
  recordMetric(`${name}.errors`, 'counter', 1, {
    ...attributes,
    error_type: error?.name || 'Unknown',
  });
}

// ─── Effy 특화 Span 래퍼 ─────────────────────────────────────

/**
 * LLM 호출 span.
 */
async function withLLMSpan(modelId, provider, fn) {
  return withSpan('llm.create_message', {
    'llm.model': modelId,
    'llm.provider': provider,
  }, fn);
}

/**
 * 도구 실행 span.
 */
async function withToolSpan(toolName, fn) {
  return withSpan('tool.execute', {
    'tool.name': toolName,
  }, fn);
}

/**
 * 메모리 작업 span.
 */
async function withMemorySpan(operation, poolId, fn) {
  return withSpan('memory.operation', {
    'memory.operation': operation,
    'memory.pool': poolId,
  }, fn);
}

/**
 * 파이프라인 단계 span.
 */
async function withPipelineSpan(step, agentId, fn) {
  return withSpan('pipeline.step', {
    'pipeline.step': step,
    'agent.id': agentId,
  }, fn);
}

/**
 * 컨텍스트 전파 (분산 추적용).
 * @param {Function} fn
 * @returns {Promise<any>}
 */
async function withContext(fn) {
  if (!_otelAvailable) {
    return fn();
  }

  try {
    const { context } = require('@opentelemetry/api');
    return await context.with(context.active(), fn);
  } catch (e) {
    log.debug('OTEL context propagation failed', { error: e.message });
    return fn();
  }
}

// ─── RunLogger 통합 래퍼 ────────────────────────────────────────

/**
 * 에이전트 실행 기록 로깅 (NDJSON + OTEL).
 */
function logRun(entry) {
  // NDJSON 파일에 기록
  if (_runLogger) {
    _runLogger.log(entry);
  }

  // OTEL 메트릭 기록
  if (_otelAvailable) {
    recordMetric('runs.total', 'counter', 1, {
      agent_id: entry.agentId,
      budget_profile: entry.budgetProfile,
    });

    if (entry.durationMs) {
      recordMetric('runs.duration_ms', 'histogram', entry.durationMs, {
        agent_id: entry.agentId,
      });
    }

    if (entry.costUsd) {
      recordMetric('runs.cost_usd', 'histogram', entry.costUsd, {
        agent_id: entry.agentId,
      });
    }

    if (entry.inputTokens) {
      recordMetric('runs.input_tokens', 'counter', entry.inputTokens, {
        model: entry.model,
      });
    }

    if (entry.outputTokens) {
      recordMetric('runs.output_tokens', 'counter', entry.outputTokens, {
        model: entry.model,
      });
    }
  }
}

// ─── 상태 조회 ────────────────────────────────────────────────

/**
 * 현재 텔레메트리 상태 조회.
 */
function getStatus() {
  return {
    enabled: TELEMETRY_CONFIG.enabled,
    otelAvailable: _otelAvailable,
    exporter: TELEMETRY_CONFIG.exporter,
    serviceName: TELEMETRY_CONFIG.serviceName,
    sampleRate: TELEMETRY_CONFIG.sampleRate,
    metricsEnabled: TELEMETRY_CONFIG.metrics.enabled,
  };
}

// ─── 초기화 및 정리 ────────────────────────────────────────────

/**
 * 텔레메트리 초기화.
 */
async function initialize() {
  _initializeOtel();
  _initializeRunLogger();

  if (TELEMETRY_CONFIG.enabled) {
    log.info('Telemetry initialized', {
      exporter: TELEMETRY_CONFIG.exporter,
      otelAvailable: _otelAvailable,
    });
  }
}

/**
 * Graceful 종료 (flush pending exports).
 */
async function shutdown() {
  try {
    if (_tracerProvider) {
      await _tracerProvider.shutdown();
      log.info('Tracer provider shut down');
    }
    if (_meterProvider) {
      await _meterProvider.shutdown();
      log.info('Meter provider shut down');
    }
    if (_runLogger) {
      _runLogger.close();
      log.info('RunLogger shut down');
    }
  } catch (err) {
    log.error('Telemetry shutdown error', { error: err.message });
  }
}

module.exports = {
  // 초기화
  initialize,
  shutdown,

  // Span 유틸리티
  withSpan,
  withSpanSync,
  withContext,

  // Effy 특화 Span
  withLLMSpan,
  withToolSpan,
  withMemorySpan,
  withPipelineSpan,

  // 메트릭 유틸리티
  recordMetric,
  recordLatency,
  recordRequestCount,
  recordError,

  // RunLogger 통합
  logRun,

  // 상태 조회
  getStatus,
};
