# Quick Start: Self-Hosted LLM & Observability Modules

## 5-Minute Setup

### 1. Enable Self-Hosted LLM Support

Add to `effy.config.yaml`:

```yaml
llm:
  selfHosted:
    enabled: true
    providers:
      - id: ollama-local
        type: ollama
        baseUrl: http://localhost:11434
        models:
          - id: llama2:13b
            tier: tier1
            maxTokens: 4096

    routing:
      preferSelfHosted: true
      fallbackToCloud: true
```

Start Ollama:
```bash
docker run -d -p 11434:8000 ollama/ollama
ollama pull llama2:13b
```

### 2. Enable OpenTelemetry

Add to `effy.config.yaml`:

```yaml
telemetry:
  enabled: true
  exporter: console  # Start with console for testing
  serviceName: effy
  sampleRate: 1.0
  metrics:
    enabled: true
    intervalMs: 60000
```

### 3. Initialize Modules

In your startup code:

```javascript
const selfHosted = require('./src/shared/llm-selfhosted');
const telemetry = require('./src/shared/telemetry');

async function startup() {
  await selfHosted.initialize();
  await telemetry.initialize();
  console.log('Modules ready');
}

startup().catch(console.error);
```

### 4. Make LLM Calls

```javascript
const response = await selfHosted.createMessage('ollama-local', 'llama2:13b', {
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'Hello!' }],
  max_tokens: 256,
});

console.log(response.content[0].text);
```

### 5. Trace with Observability

```javascript
const result = await telemetry.withLLMSpan('llama2:13b', 'ollama-local', async (span) => {
  const response = await selfHosted.createMessage('ollama-local', 'llama2:13b', {
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello!' }],
    max_tokens: 256,
  });
  return response;
});
```

---

## Common Tasks

### Check Provider Health

```javascript
const healthy = await selfHosted.healthCheck('ollama-local');
console.log(healthy ? 'OK' : 'UNHEALTHY');
```

### Select Best Provider

```javascript
const selection = selfHosted.selectProvider('tier1');
if (selection) {
  const { providerId, modelId } = selection;
  // Use this provider
}
```

### Record Custom Metrics

```javascript
telemetry.recordLatency('my_operation_ms', 123, { operation: 'query' });
telemetry.recordRequestCount('my_requests', { type: 'search' });
```

### Stream Responses

```javascript
const stream = selfHosted.streamMessage('ollama-local', 'llama2:13b', params);

stream.on('data', (chunk) => {
  console.log(chunk.choices[0].delta.content);
});

stream.on('end', () => {
  console.log('Done');
});
```

### Log Complete Run

```javascript
telemetry.logRun({
  traceId: 'trace-123',
  agentId: 'my-agent',
  functionType: 'agentic_loop',
  budgetProfile: 'standard',
  model: 'llama2:13b',
  userId: 'user-456',
  channelId: 'slack-general',
  inputTokens: 100,
  outputTokens: 200,
  iterations: 2,
  toolCalls: ['search'],
  durationMs: 5000,
  costUsd: 0.00,
});
```

---

## Production Setup

### 1. Install OTEL SDK

```bash
npm install @opentelemetry/sdk-node \
            @opentelemetry/exporter-trace-otlp-http \
            @opentelemetry/exporter-metrics-otlp-http
```

### 2. Configure Jaeger (or other backend)

```bash
docker run -d \
  -p 16686:16686 \
  -p 4318:4318 \
  -p 4317:4317 \
  jaegertracing/all-in-one
```

Update `effy.config.yaml`:

```yaml
telemetry:
  enabled: true
  exporter: otlp-http
  endpoint: http://localhost:4318
  serviceName: effy
  sampleRate: 0.1  # 10% sampling in production
  metrics:
    enabled: true
    intervalMs: 60000
```

### 3. Add Graceful Shutdown

```javascript
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await telemetry.shutdown();
  process.exit(0);
});
```

### 4. Monitor in Dashboard

Open Jaeger UI: http://localhost:16686

Query for traces:
- Service: `effy`
- Operation: `llm.create_message`, `tool.execute`, etc.

---

## Troubleshooting

### Self-Hosted Provider Not Found

```javascript
const status = selfHosted.getStatus();
console.log(status);  // Check providers list

// If empty or unhealthy:
await selfHosted.healthCheck('ollama-local');
```

### No Traces in Jaeger

1. Check telemetry status:
   ```javascript
   console.log(telemetry.getStatus());
   ```

2. Verify OTEL SDK installed:
   ```bash
   npm ls @opentelemetry/sdk-node
   ```

3. Check endpoint:
   ```bash
   curl http://localhost:4318/v1/traces
   ```

### High Latency

Check provider metrics:
```javascript
selfHosted.getStatus().providers.forEach(p => {
  console.log(`${p.providerId}: ${p.avgLatencyMs}ms`);
});
```

---

## Examples

See `/tmp/effy-push/examples/integration-example.js` for:
- Complete agent loop with tracing
- Provider selection logic
- Error handling
- Metric recording
- Tool execution

---

## Full Documentation

See `/tmp/effy-push/docs/MODULES.md` for:
- Complete API reference
- Configuration options
- Integration patterns
- Performance tuning
- Production checklist

---

## Next Steps

1. ✓ Add modules to `src/shared/`
2. ✓ Update `effy.config.yaml`
3. ✓ Initialize modules in startup
4. ✓ Replace `llm-client` calls with self-hosted where desired
5. ✓ Wrap operations in `telemetry.withSpan*` helpers
6. ✓ Deploy to production with monitoring

---

Happy observing! 🚀
