/**
 * integration-example.js — Complete example integrating both new modules.
 *
 * Demonstrates:
 * - LLM provider selection (self-hosted or cloud)
 * - Request tracing with OpenTelemetry
 * - Metric recording
 * - Error handling with observability
 * - Graceful startup/shutdown
 */

const selfHosted = require('../src/shared/llm-selfhosted');
const telemetry = require('../src/shared/telemetry');
const llmClient = require('../src/shared/llm-client');
const { createLogger } = require('../src/shared/logger');

const log = createLogger('example:integration');

// ─── Application Startup ──────────────────────────────────────

async function startup() {
  log.info('Starting Effy with observability...');

  // Initialize both modules
  await selfHosted.initialize();
  await telemetry.initialize();

  log.info('All modules initialized', {
    selfHosted: selfHosted.getStatus(),
    telemetry: telemetry.getStatus(),
  });
}

// ─── LLM Selection Logic ──────────────────────────────────────

/**
 * Intelligent LLM provider selection:
 * 1. Try self-hosted if enabled and healthy (tier-based)
 * 2. Fallback to cloud (Anthropic) if needed
 */
async function selectLLMProvider(tier = 'tier1') {
  const selfHostedOption = selfHosted.selectProvider(tier);

  if (selfHostedOption) {
    const { providerId, modelId } = selfHostedOption;
    const state = selfHosted.getStatus().providers.find(p => p.providerId === providerId);

    if (state && state.isHealthy) {
      log.debug('Selected self-hosted provider', {
        providerId,
        modelId,
        avgLatency: state.avgLatencyMs,
      });

      return {
        type: 'selfhosted',
        providerId,
        modelId,
      };
    }
  }

  log.debug('Falling back to cloud provider (Anthropic)');
  return {
    type: 'cloud',
    provider: 'anthropic',
  };
}

// ─── LLM Call with Full Observability ────────────────────────

/**
 * Main LLM interaction wrapper with:
 * - Provider selection
 * - Span + metric recording
 * - Error handling
 * - Token tracking
 */
async function callLLM(userMessage, options = {}) {
  const {
    system = 'You are a helpful assistant.',
    maxTokens = 2048,
    preferSelfHosted = true,
    tier = 'tier1',
  } = options;

  const traceId = options.traceId || `trace-${Date.now()}`;
  const userId = options.userId || 'anonymous';

  // Select provider (cloud or self-hosted)
  const provider = preferSelfHosted
    ? await selectLLMProvider(tier)
    : { type: 'cloud', provider: 'anthropic' };

  const startMs = Date.now();
  let response = null;
  let error = null;

  // Wrap in telemetry span
  try {
    if (provider.type === 'selfhosted') {
      // Self-hosted provider
      response = await telemetry.withLLMSpan(
        provider.modelId,
        provider.providerId,
        async (span) => {
          span.setAttributes({
            'user.id': userId,
            'trace.id': traceId,
            'provider.type': 'selfhosted',
          });

          try {
            const result = await selfHosted.createMessage(
              provider.providerId,
              provider.modelId,
              {
                system,
                messages: [{ role: 'user', content: userMessage }],
                max_tokens: maxTokens,
              }
            );

            span.addEvent('llm_response_received', {
              tokens_in: result.usage?.input_tokens || 0,
              tokens_out: result.usage?.output_tokens || 0,
              stop_reason: result.stop_reason,
            });

            return result;
          } catch (err) {
            span.recordException(err);
            throw err;
          }
        }
      );
    } else {
      // Cloud provider (Anthropic)
      response = await telemetry.withLLMSpan(
        'claude-opus-4',
        'anthropic',
        async (span) => {
          span.setAttributes({
            'user.id': userId,
            'trace.id': traceId,
            'provider.type': 'cloud',
          });

          try {
            const result = await llmClient.createMessage({
              model: 'claude-opus-4-20250514',
              system,
              messages: [{ role: 'user', content: userMessage }],
              max_tokens: maxTokens,
            });

            span.addEvent('llm_response_received', {
              tokens_in: result.usage?.input_tokens || 0,
              tokens_out: result.usage?.output_tokens || 0,
              stop_reason: result.stop_reason,
            });

            return result;
          } catch (err) {
            span.recordException(err);
            throw err;
          }
        }
      );
    }
  } catch (err) {
    error = err;
    telemetry.recordError('llm_call', err, {
      provider: provider.type,
      trace_id: traceId,
    });
    log.error('LLM call failed', {
      error: err.message,
      provider: provider.type,
      traceId,
    });
    throw err;
  }

  // Record metrics
  const latencyMs = Date.now() - startMs;
  telemetry.recordLatency('llm_request_latency_ms', latencyMs, {
    provider_type: provider.type,
    provider_id: provider.providerId || provider.provider,
    user_id: userId,
  });

  telemetry.recordMetric('llm_requests', 'counter', 1, {
    provider_type: provider.type,
    success: error ? 'false' : 'true',
  });

  log.info('LLM call completed', {
    provider: provider.type,
    latencyMs,
    inputTokens: response?.usage?.input_tokens || 0,
    outputTokens: response?.usage?.output_tokens || 0,
    traceId,
  });

  return {
    response,
    metadata: {
      traceId,
      provider: provider.type,
      providerId: provider.providerId || provider.provider,
      latencyMs,
      inputTokens: response?.usage?.input_tokens || 0,
      outputTokens: response?.usage?.output_tokens || 0,
    },
  };
}

// ─── Tool Execution with Telemetry ───────────────────────────

async function executeTool(toolName, toolInput, context = {}) {
  return telemetry.withToolSpan(toolName, async (span) => {
    span.setAttributes({
      'tool.input_size': JSON.stringify(toolInput).length,
      ...context,
    });

    const startMs = Date.now();

    try {
      // Simulated tool execution
      let result;
      switch (toolName) {
        case 'slack_send':
          result = { ok: true, ts: Date.now() };
          break;
        case 'graph_query':
          result = { nodes: 42, edges: 128 };
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      const latencyMs = Date.now() - startMs;
      span.addEvent('tool_execution_success', { latency_ms: latencyMs });

      telemetry.recordLatency(`tool_${toolName}_latency_ms`, latencyMs);

      return result;
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      span.recordException(err);
      telemetry.recordError(`tool_${toolName}`, err);
      throw err;
    }
  });
}

// ─── Agent Loop with Full Observability ────────────────────────

async function runAgent(agentId, userInput, userId) {
  const traceId = `agent-${Date.now()}`;
  const startMs = Date.now();

  log.info('Starting agent', { agentId, userId, traceId });

  return telemetry.withPipelineSpan('agentic_loop', agentId, async (span) => {
    span.setAttributes({
      'trace.id': traceId,
      'user.id': userId,
      'initial_input_length': userInput.length,
    });

    let iteration = 0;
    let toolCalls = [];
    let messages = [{ role: 'user', content: userInput }];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastResponse = null;

    try {
      while (iteration < 5) {
        iteration++;
        log.debug('Agent iteration', { agentId, iteration, traceId });

        // LLM call
        const { response, metadata } = await callLLM(userInput, {
          system: `You are agent ${agentId}. Execute tools as needed.`,
          traceId,
          userId,
          preferSelfHosted: true,
          tier: 'tier1',
        });

        totalInputTokens += metadata.inputTokens;
        totalOutputTokens += metadata.outputTokens;
        lastResponse = response;

        span.addEvent('llm_iteration_complete', {
          iteration,
          latency_ms: metadata.latencyMs,
          input_tokens: metadata.inputTokens,
          output_tokens: metadata.outputTokens,
        });

        // Check for tool calls
        const toolUses = response.content.filter(c => c.type === 'tool_use');
        if (toolUses.length === 0) {
          // No more tools — conversation complete
          break;
        }

        // Execute tools
        for (const toolUse of toolUses) {
          toolCalls.push(toolUse.name);
          log.debug('Executing tool', { tool: toolUse.name, iteration, traceId });

          const toolResult = await executeTool(toolUse.name, toolUse.input, {
            iteration,
            trace_id: traceId,
          });

          // Add tool result to messages for next iteration
          messages.push({ role: 'assistant', content: response.content });
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: JSON.stringify(toolResult),
            }],
          });
        }

        span.addEvent('iteration_complete', {
          iteration,
          tool_calls: toolUses.length,
        });
      }

      // Log complete run
      const durationMs = Date.now() - startMs;
      const costUsd = (totalInputTokens * 0.00003) + (totalOutputTokens * 0.0001);

      telemetry.logRun({
        traceId,
        agentId,
        functionType: 'agentic_loop',
        budgetProfile: 'standard',
        model: 'claude-opus-4',
        userId,
        channelId: 'direct',
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        iterations: iteration,
        toolCalls,
        durationMs,
        costUsd,
      });

      log.info('Agent completed', {
        agentId,
        iterations: iteration,
        toolCalls,
        durationMs,
        costUsd,
        traceId,
      });

      return {
        response: lastResponse,
        iterations: iteration,
        toolCalls,
        metadata: {
          traceId,
          durationMs,
          totalTokens: totalInputTokens + totalOutputTokens,
          costUsd,
        },
      };
    } catch (err) {
      span.recordException(err);
      telemetry.recordError('agent_execution', err, {
        agent_id: agentId,
        trace_id: traceId,
      });
      log.error('Agent failed', { agentId, error: err.message, traceId });
      throw err;
    }
  });
}

// ─── Graceful Shutdown ────────────────────────────────────────

async function shutdown() {
  log.info('Shutting down gracefully...');

  try {
    await telemetry.shutdown();
    log.info('Telemetry shut down');
  } catch (err) {
    log.error('Telemetry shutdown error', { error: err.message });
  }

  log.info('Shutdown complete');
}

// ─── Main Entry Point ────────────────────────────────────────

async function main() {
  try {
    // Startup
    await startup();

    // Example: Run agent
    const result = await runAgent(
      'qa-agent',
      'What is the capital of France?',
      'user-123'
    );

    console.log('\n=== Agent Result ===');
    console.log(result);

    // Alternative: Direct LLM call
    const llmResult = await callLLM(
      'Write a haiku about OpenTelemetry.',
      {
        system: 'You are a poet.',
        preferSelfHosted: false, // Force cloud
      }
    );

    console.log('\n=== LLM Result ===');
    console.log(llmResult);

    // Shutdown
    await shutdown();
  } catch (err) {
    log.error('Application error', { error: err.message, stack: err.stack });
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

// Export for use as library
module.exports = {
  startup,
  shutdown,
  selectLLMProvider,
  callLLM,
  executeTool,
  runAgent,
};
