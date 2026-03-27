# Effy Modules: Self-Hosted LLM & Observability

Two new production-quality modules for extending Effy's capabilities.

---

## 1. Self-Hosted LLM Support (`src/shared/llm-selfhosted.js`)

Integrates local and remote LLM deployments (Ollama, vLLM) alongside cloud providers.

### Key Features

- **OpenAI-Compatible API**: Unified client for Ollama and vLLM endpoints
- **Provider Management**: Health checks, model listing, latency tracking
- **Format Conversion**: Anthropic ↔ OpenAI message transformation
- **Streaming Support**: SSE-based streaming via EventEmitter
- **Availability Tracking**: Automatic failover detection (3 consecutive errors = unhealthy)
- **Intelligent Selection**: Choose providers by tier and health status

### Architecture

```
┌─────────────────────────────┐
│   Effy Agent (Anthropic)    │
└──────────────┬──────────────┘
               │
      ┌────────▼─────────┐
      │ createMessage()  │  ← Anthropic format
      │ streamMessage()  │
      │ selectProvider() │
      └────────┬─────────┘
               │
    ┌──────────┴──────────┐
    │                     │
┌───▼────┐          ┌──────▼────┐
│ Ollama │          │   vLLM    │
│ (CPU)  │          │   (GPU)   │
└────────┘          └───────────┘
    │                     │
    └──────────┬──────────┘
               │
      /v1/chat/completions  ← OpenAI format
```

### Configuration

```yaml
llm:
  selfHosted:
    enabled: true
    providers:
      - id: ollama-local
        type: ollama
        baseUrl: http://localhost:11434
        models:
          - id: llama3.1:70b
            tier: tier1
            maxTokens: 8192
          - id: qwen2.5:72b
            tier: tier2
            maxTokens: 16384

      - id: vllm-gpu
        type: vllm
        baseUrl: http://gpu-server:8000
        models:
          - id: deepseek-coder-v2
            tier: tier2
            maxTokens: 16384

    routing:
      preferSelfHosted: true    # Use self-hosted when available
      fallbackToCloud: true     # Fall back to Anthropic if all fail
```

### API

#### `initialize()`
Startup health checks for all configured providers.
```javascript
await selfHosted.initialize();
```

#### `createMessage(providerId, modelId, params)`
Synchronous message generation.
```javascript
const response = await selfHosted.createMessage('ollama-local', 'llama3.1:70b', {
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hello!' }],
  max_tokens: 1024,
});
```

**Response** (Anthropic format):
```javascript
{
  content: [
    { type: 'text', text: '...' },
    { type: 'tool_use', id: '...', name: '...', input: {} }
  ],
  model: 'selfhosted/ollama-local/llama3.1:70b',
  stop_reason: 'end_turn',
  usage: { input_tokens: 42, output_tokens: 128 },
  _selfHosted: true,
  _provider: 'ollama-local'
}
```

#### `streamMessage(providerId, modelId, params)`
Returns EventEmitter for SSE streaming.
```javascript
const stream = selfHosted.streamMessage('vllm-gpu', 'deepseek-coder-v2', params);

stream.on('data', (chunk) => {
  // OpenAI SSE chunk
  console.log(chunk.choices[0].delta.content);
});

stream.on('end', () => {
  console.log('Stream complete');
});

stream.on('error', (err) => {
  console.error(err);
});
```

#### `healthCheck(providerId)`
Manual health check (automatic on startup).
```javascript
const healthy = await selfHosted.healthCheck('ollama-local');
```

#### `getModels(providerId)`
Fetch available models (5-minute cache).
```javascript
const models = await selfHosted.getModels('ollama-local');
// [{ id: 'llama3.1:70b', size: 45GB, modified_at: '2026-03-15T...' }, ...]
```

#### `selectProvider(tier?)`
Intelligent provider selection.
```javascript
// Auto-select healthy provider with tier1 models
const selection = selfHosted.selectProvider('tier1');
if (selection) {
  const { providerId, modelId } = selection;
  await selfHosted.createMessage(providerId, modelId, params);
}
```

#### `getStatus()`
Dashboard status.
```javascript
const status = selfHosted.getStatus();
// {
//   enabled: true,
//   providers: [
//     {
//       providerId: 'ollama-local',
//       isHealthy: true,
//       totalRequests: 142,
//       failedRequests: 2,
//       errorRate: '0.014',
//       avgLatencyMs: 850
//     }
//   ]
// }
```

### Error Handling

- **Network errors**: Recorded in provider state (3 consecutive = unhealthy)
- **HTTP 4xx/5xx**: Propagated with status code; provider state updated
- **Empty responses**: Thrown as `SelfHosted: empty response`
- **No providers available**: Throws error (check config + health)

Graceful degradation:
```javascript
try {
  const response = await selfHosted.createMessage(providerId, modelId, params);
} catch (err) {
  if (SELF_HOSTED_CONFIG.routing.fallbackToCloud) {
    // Fallback to Anthropic via llm-client.js
    const fallback = await createMessage(anthropicParams);
  } else {
    throw err;
  }
}
```

### Integration with llm-client.js

Suggested integration pattern:

```javascript
// src/shared/llm-router.js
const llmClient = require('./llm-client');
const selfHosted = require('./llm-selfhosted');

async function createMessage(anthropicParams, preferSelfHosted = false) {
  if (preferSelfHosted) {
    const selection = selfHosted.selectProvider(
      anthropicParams._tier || 'tier1'
    );
    if (selection) {
      try {
        return await selfHosted.createMessage(
          selection.providerId,
          selection.modelId,
          anthropicParams
        );
      } catch (err) {
        if (!config.llm.selfHosted.routing.fallbackToCloud) throw err;
        // Fall through to cloud
      }
    }
  }

  // Fallback: cloud provider
  return await llmClient.createMessage(anthropicParams);
}
```

---

## 2. OpenTelemetry Integration (`src/shared/telemetry.js`)

Comprehensive observability with distributed tracing and metrics.

### Key Features

- **OTEL SDK Integration**: Traces, metrics, baggage
- **Multiple Exporters**: OTLP/gRPC, OTLP/HTTP, console, none
- **Span Management**: Automatic error recording, status propagation
- **Metrics Collection**: Counters, histograms, gauges
- **RunLogger Integration**: NDJSON logs + OTEL metrics
- **Graceful Degradation**: Works without OTEL SDK (no-op mode)
- **Effy-Specific Spans**: LLM, tool, memory, pipeline operations

### Architecture

```
┌──────────────────────────────┐
│    Effy Components           │
│  (agents, tools, memory)     │
└──────────┬───────────────────┘
           │
    ┌──────▼─────────┐
    │  Telemetry     │  ← withSpan, withLLMSpan, etc.
    │                │  ← recordMetric, recordLatency
    └──────┬─────────┘
           │
     ┌─────┴──────────────────────────────┐
     │                                    │
┌────▼────────┐          ┌────────────────▼────┐
│  OTEL SDK   │          │     RunLogger       │
│  (traces)   │          │  (NDJSON append)    │
└────┬────────┘          └────────────────┬────┘
     │                                    │
  ┌──┴──────────────────────────────────┐│
  │ Exporters:                           ││
  │ - OTLP gRPC                          ││
  │ - OTLP HTTP                          ││
  │ - Console                            ││
  │ - None (disabled)                    ││
  └──────────────────────────────────────┘│
                                          │
                              data/runs/runs-*.ndjson
```

### Configuration

```yaml
telemetry:
  enabled: true
  exporter: otlp-http          # otlp-grpc | otlp-http | console | none
  endpoint: http://localhost:4318
  serviceName: effy
  sampleRate: 1.0              # 0.0-1.0 (1.0 = trace all)
  metrics:
    enabled: true
    intervalMs: 60000          # Flush metrics every 60s
```

### API

#### `initialize()`
Startup initialization (call once on app startup).
```javascript
await telemetry.initialize();
```

#### `shutdown()`
Graceful shutdown (flush pending spans/metrics).
```javascript
process.on('SIGTERM', async () => {
  await telemetry.shutdown();
  process.exit(0);
});
```

#### `withSpan(name, attributes, fn)`
Wrap async function with span.
```javascript
const result = await telemetry.withSpan('memory.graph_query',
  { pool: 'graph1', depth: 3 },
  async (span) => {
    // Your code here
    const data = await memoryService.query(...);
    span.addEvent('cache_miss', { lookup_time: 42 });
    return data;
  }
);
```

**Span attributes**:
- Automatically recorded: duration, exceptions, status
- Manual: `span.setAttributes({ key: value })`
- Events: `span.addEvent('name', { ...data })`

#### `withLLMSpan(modelId, provider, fn)`
LLM operation span.
```javascript
await telemetry.withLLMSpan('gpt-4', 'openai', async (span) => {
  const response = await llmClient.createMessage(params);
  return response;
});
```

Recorded attributes:
- `llm.model`: Model ID
- `llm.provider`: Provider name
- `llm.tokens.prompt`: Input tokens (manual)
- `llm.tokens.completion`: Output tokens (manual)

#### `withToolSpan(toolName, fn)`
Tool execution span.
```javascript
await telemetry.withToolSpan('slack_send', async (span) => {
  await tools.slack.send({ channel: '#general', text: '...' });
});
```

#### `withMemorySpan(operation, poolId, fn)`
Memory operation span.
```javascript
await telemetry.withMemorySpan('graph_insert', 'pool1', async (span) => {
  await memory.graph.insert(node);
});
```

#### `withPipelineSpan(step, agentId, fn)`
Pipeline step span.
```javascript
await telemetry.withPipelineSpan('tool_calling', 'agent1', async (span) => {
  // Execute tool calling loop
});
```

#### `recordMetric(name, type, value, attributes)`
Raw metric recording.
```javascript
telemetry.recordMetric('cache_hits', 'counter', 1, { pool: 'graph1' });
telemetry.recordMetric('memory_usage_mb', 'gauge', 256, { service: 'memory' });
telemetry.recordMetric('query_latency_ms', 'histogram', 45, { pool: 'graph1' });
```

#### `recordLatency(name, latencyMs, attributes)`
Convenience for histogram metrics.
```javascript
const start = Date.now();
const result = await someOperation();
telemetry.recordLatency('operation_latency_ms', Date.now() - start, {
  operation: 'graph_query',
  result_size: result.length
});
```

#### `recordRequestCount(name, attributes)`
Increment counter.
```javascript
telemetry.recordRequestCount('http_requests', { method: 'GET', path: '/api' });
```

#### `recordError(name, error, attributes)`
Record error with context.
```javascript
try {
  await risky_operation();
} catch (err) {
  telemetry.recordError('operation', err, { operation: 'database_insert' });
}
```

#### `logRun(entry)`
Log agent execution (RunLogger + OTEL).
```javascript
telemetry.logRun({
  traceId: 'trace-123',
  agentId: 'strategy-agent',
  functionType: 'agentic_loop',
  budgetProfile: 'standard',
  model: 'claude-opus-4',
  userId: 'user-456',
  channelId: 'slack-general',
  inputTokens: 1024,
  outputTokens: 2048,
  iterations: 3,
  toolCalls: ['slack_send', 'graph_insert'],
  durationMs: 5432,
  costUsd: 0.15
});
```

Metrics automatically recorded:
- `runs.total` (counter)
- `runs.duration_ms` (histogram)
- `runs.cost_usd` (histogram)
- `runs.input_tokens` (counter)
- `runs.output_tokens` (counter)

#### `getStatus()`
Current telemetry status.
```javascript
const status = telemetry.getStatus();
// {
//   enabled: true,
//   otelAvailable: true,
//   exporter: 'otlp-http',
//   serviceName: 'effy',
//   sampleRate: 1.0,
//   metricsEnabled: true
// }
```

### Span Lifecycle

Automatically handled by `withSpan*` wrappers:

1. **Create**: Span started with name + attributes
2. **Record**: Status, events, exceptions automatically captured
3. **End**: Span closed (duration computed)
4. **Export**: Batch processor sends to exporter

```javascript
await withSpan('my_operation', { user_id: '123' }, async (span) => {
  try {
    const result = await doWork();
    // Status: OK (0)
    span.addEvent('work_completed', { items: result.length });
    return result;
  } catch (err) {
    // Status: ERROR (2), exception recorded
    span.recordException(err);
    throw err;
  }
  // Span ends here, sent to exporter
});
```

### OTEL Exporters

#### OTLP/HTTP (Recommended)
Jaeger, Tempo, DataDog, NewRelic compatible.
```yaml
telemetry:
  exporter: otlp-http
  endpoint: http://localhost:4318  # Jaeger receiver
```

#### OTLP/gRPC
Lower latency, smaller payload.
```yaml
telemetry:
  exporter: otlp-grpc
  endpoint: grpc://localhost:4317
```

#### Console
Debug mode — prints spans/metrics to stdout.
```yaml
telemetry:
  exporter: console
```

#### None
Disabled (no export, no-op mode).
```yaml
telemetry:
  exporter: none
  enabled: false
```

### Integration with RunLogger

Telemetry module automatically:
1. Writes NDJSON to `data/runs/runs-YYYY-MM-DD.ndjson`
2. Records corresponding OTEL metrics
3. Links spans to run IDs via baggage

Combined observability:
```bash
# View recent runs
tail -f data/runs/runs-2026-03-27.ndjson | jq .

# Query in Jaeger UI
# (trace IDs from NDJSON = trace IDs in Jaeger)
```

### Error Scenarios

| Scenario | Behavior |
|----------|----------|
| OTEL SDK not installed | No-op mode (all functions work, no export) |
| Exporter unavailable | Logs warning, continues without export |
| Invalid config | Uses defaults (console exporter, 1.0 sample rate) |
| Span in progress on shutdown | Flushed gracefully (30s timeout) |

---

## Usage Examples

### Example 1: Orchestrate Self-Hosted LLM with Telemetry

```javascript
const selfHosted = require('./llm-selfhosted');
const telemetry = require('./telemetry');

async function answerQuestion(question, userTier) {
  // Select best provider for user tier
  const selection = selfHosted.selectProvider(userTier);
  if (!selection) {
    throw new Error('No LLM providers available');
  }

  const { providerId, modelId } = selection;

  // Wrap in telemetry span
  const response = await telemetry.withLLMSpan(modelId, providerId, async (span) => {
    span.setAttributes({ user_tier: userTier });

    const startMs = Date.now();
    const result = await selfHosted.createMessage(providerId, modelId, {
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: question }],
      max_tokens: 4096,
    });

    // Record metrics
    const latencyMs = Date.now() - startMs;
    telemetry.recordLatency('llm_response_time_ms', latencyMs, {
      provider: providerId,
      model: modelId,
      user_tier: userTier
    });

    return result;
  });

  return response;
}
```

### Example 2: Memory Operation with Health Check

```javascript
async function queryGraph(poolId, query) {
  // Health check before use
  const healthy = await selfHosted.healthCheck('vllm-gpu');
  if (!healthy) {
    telemetry.recordError('graph_query', new Error('Provider unhealthy'));
    throw new Error('LLM provider unavailable');
  }

  return await telemetry.withMemorySpan('graph_select', poolId, async (span) => {
    const startMs = Date.now();

    // Query logic
    const results = await memory.graph.select(query);

    // Record results
    span.addEvent('query_complete', { result_count: results.length });
    telemetry.recordLatency('memory_query_ms', Date.now() - startMs, {
      pool: poolId,
      result_size: results.length
    });

    return results;
  });
}
```

### Example 3: Agent Run with Full Observability

```javascript
async function runAgent(agentId, input, traceId) {
  const startMs = Date.now();
  let inputTokens = 0, outputTokens = 0;

  const result = await telemetry.withPipelineSpan('agentic_loop', agentId,
    async (span) => {
      span.setAttributes({ trace_id: traceId, initial_input: input });

      // Tool calling loop
      let iterations = 0;
      const toolCalls = [];

      while (iterations < MAX_ITERATIONS) {
        // LLM call
        const llmResponse = await telemetry.withLLMSpan('gpt-4', 'openai',
          async () => {
            return await llmClient.createMessage(params);
          }
        );

        inputTokens += llmResponse.usage.input_tokens;
        outputTokens += llmResponse.usage.output_tokens;

        // Tool execution
        for (const toolCall of llmResponse.content.filter(c => c.type === 'tool_use')) {
          toolCalls.push(toolCall.name);
          await telemetry.withToolSpan(toolCall.name, async () => {
            return await tools[toolCall.name](toolCall.input);
          });
        }

        iterations++;
        if (llmResponse.stop_reason === 'end_turn') break;
      }

      return { result: llmResponse, iterations, toolCalls };
    }
  );

  // Log complete run
  telemetry.logRun({
    traceId,
    agentId,
    functionType: 'agentic_loop',
    budgetProfile: 'standard',
    model: 'gpt-4',
    userId: 'user-123',
    channelId: 'slack-general',
    inputTokens,
    outputTokens,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    durationMs: Date.now() - startMs,
    costUsd: (inputTokens * 0.00003 + outputTokens * 0.0001)
  });

  return result;
}
```

---

## Performance Considerations

### llm-selfhosted.js

- **Model cache**: 5-minute TTL (configurable)
- **Health checks**: On-demand or scheduled
- **Latency tracking**: Per-provider moving average
- **Memory**: ~1KB per provider + cached model list

### telemetry.js

- **Batch processor**: Default 2s flush (OTEL SDK)
- **Sampling**: Configurable 0.0-1.0 (1.0 = no sampling)
- **No-op overhead**: <1μs when OTEL unavailable
- **Memory**: ~10MB typical for active spans + metrics

---

## Testing

### Self-Hosted LLM

```bash
# Start Ollama locally
docker run -d -p 11434:8000 ollama/ollama

# Pull model
ollama pull llama2

# Test module
node -e "
const sh = require('./src/shared/llm-selfhosted');
(async () => {
  await sh.initialize();
  console.log(sh.getStatus());
})();
"
```

### Telemetry

```bash
# Console exporter (no external service needed)
LOG_LEVEL=debug node app.js

# With Jaeger
docker run -d -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one

# Query spans
curl http://localhost:16686/api/traces?service=effy
```

---

## Production Checklist

- [ ] `llm-selfhosted.enabled: false` in production until verified
- [ ] Provider health checks configured (baseline: every 5 minutes)
- [ ] Fallback to cloud providers enabled for high availability
- [ ] OTEL SDK installed (`npm install @opentelemetry/sdk-node`)
- [ ] Exporter configured (OTLP endpoint or console)
- [ ] RunLogger `data/runs/` directory exists and writable
- [ ] Sample rate tuned for your traffic (typical: 0.1-0.5)
- [ ] Monitoring alerts set up on error rates and latencies
- [ ] Graceful shutdown hook added (`telemetry.shutdown()`)
