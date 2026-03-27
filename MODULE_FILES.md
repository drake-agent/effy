# Module Files Index

## Core Modules

### 1. Self-Hosted LLM Support
- **File**: `src/shared/llm-selfhosted.js`
- **Lines**: 661
- **Status**: Production-ready

Key exports:
- `initialize()` - Startup health checks
- `createMessage(providerId, modelId, params)` - Sync LLM call
- `streamMessage(providerId, modelId, params)` - SSE streaming
- `healthCheck(providerId)` - Provider health
- `getModels(providerId)` - List models (cached)
- `selectProvider(tier?)` - Intelligent selection
- `getStatus()` - Dashboard data

### 2. OpenTelemetry Integration
- **File**: `src/shared/telemetry.js`
- **Lines**: 513
- **Status**: Production-ready

Key exports:
- `initialize()` / `shutdown()` - Lifecycle
- `withSpan(name, attrs, fn)` - Generic span wrapper
- `withLLMSpan()`, `withToolSpan()`, `withMemorySpan()`, `withPipelineSpan()` - Effy-specific
- `recordMetric(name, type, value, attrs)` - Metrics
- `recordLatency()`, `recordRequestCount()`, `recordError()` - Convenience functions
- `logRun(entry)` - Complete run logging
- `getStatus()` - Dashboard data

---

## Documentation

### Complete Reference
- **File**: `docs/MODULES.md`
- **Lines**: 723
- **Contents**:
  - Architecture diagrams
  - Complete API reference
  - Configuration options
  - Error handling strategies
  - Integration patterns
  - Performance considerations
  - Testing instructions
  - Production checklist

### Delivery Summary
- **File**: `MODULES_SUMMARY.md`
- **Lines**: 473
- **Contents**:
  - Features overview
  - Implementation details
  - Code quality metrics
  - Integration patterns
  - Testing guide

### Quick Start Guide
- **File**: `QUICKSTART.md`
- **Lines**: 178
- **Contents**:
  - 5-minute setup
  - Common tasks
  - Production setup
  - Troubleshooting

---

## Examples

### Integration Example
- **File**: `examples/integration-example.js`
- **Lines**: 461
- **Demonstrates**:
  - Module initialization
  - LLM provider selection
  - Request tracing with spans
  - Metric recording
  - Error handling
  - Graceful shutdown
  - Complete agent loop
  - Tool execution with observability

---

## Summary Statistics

| Category | Count | Lines |
|----------|-------|-------|
| Core Modules | 2 | 1,174 |
| Documentation | 3 | 1,374 |
| Examples | 1 | 461 |
| **TOTAL** | **6** | **3,009** |

---

## Getting Started

1. **Read**: Start with `QUICKSTART.md` (5 minutes)
2. **Reference**: Use `docs/MODULES.md` for details
3. **Learn**: Study `examples/integration-example.js`
4. **Deploy**: Follow checklist in `MODULES_SUMMARY.md`

---

## Integration Checklist

- [ ] Add modules to git
- [ ] Update `effy.config.yaml` with self-hosted config
- [ ] Initialize both modules on startup
- [ ] Replace relevant `llm-client` calls with self-hosted
- [ ] Wrap operations in `telemetry.withSpan*` helpers
- [ ] Configure OTEL exporter (Jaeger/Tempo/etc)
- [ ] Add graceful shutdown hook
- [ ] Test locally with Ollama
- [ ] Deploy to staging
- [ ] Monitor with Jaeger UI
- [ ] Deploy to production

---

All files ready for immediate use.
