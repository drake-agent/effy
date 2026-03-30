/**
 * llm-selfhosted.js — Self-Hosted LLM Support (Ollama, vLLM).
 *
 * 자체 호스팅 LLM 프로바이더를 통합한 OpenAI 호환 클라이언트.
 * - Ollama (로컬 또는 원격)
 * - vLLM (GPU 서버)
 *
 * 기능:
 * - OpenAI 호환 API 클라이언트 (messages/completions)
 * - 모델 헬스 체크 및 목록 조회
 * - Anthropic ↔ OpenAI 메시지 형식 변환
 * - SSE 스트리밍 지원
 * - 레이턴시 추적 및 가용성 모니터링
 *
 * Config:
 *   llm.selfHosted.enabled: true
 *   llm.selfHosted.providers[].id: ollama-local
 *   llm.selfHosted.providers[].type: ollama | vllm
 *   llm.selfHosted.providers[].baseUrl: http://localhost:11434
 *   llm.selfHosted.providers[].models[].id: llama3.1:70b
 *   llm.selfHosted.providers[].models[].tier: tier1
 *   llm.selfHosted.providers[].models[].maxTokens: 8192
 *   llm.selfHosted.routing.preferSelfHosted: true
 *   llm.selfHosted.routing.fallbackToCloud: true
 */

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('llm:selfhosted');

// ─── 설정 로드 ──────────────────────────────────────────────────

const SELF_HOSTED_CONFIG = {
  enabled: config.llm?.selfHosted?.enabled ?? false,
  providers: config.llm?.selfHosted?.providers ?? [],
  routing: config.llm?.selfHosted?.routing ?? {
    preferSelfHosted: true,
    fallbackToCloud: true,
  },
};

// ─── Provider State Tracking ────────────────────────────────────

/**
 * Provider 가용성 및 메트릭 추적.
 */
class ProviderState {
  constructor(providerId) {
    this.providerId = providerId;
    this.isHealthy = true;
    this.lastHealthCheck = 0;
    this.consecutiveErrors = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.totalLatencyMs = 0;
    this.modelCache = null;
    this.modelCacheExpireAt = 0;
  }

  recordSuccess(latencyMs) {
    // 성공 → 에러 카운터 리셋
    this.consecutiveErrors = 0;
    this.totalRequests++;
    this.totalLatencyMs += latencyMs;
    this.isHealthy = true;
  }

  recordError() {
    this.consecutiveErrors++;
    this.totalRequests++;
    this.failedRequests++;
    // 3회 연속 에러 → unhealthy 마킹
    if (this.consecutiveErrors >= 3) {
      this.isHealthy = false;
      log.warn(`Provider marked unhealthy after ${this.consecutiveErrors} errors`, { providerId: this.providerId });
    }
  }

  getAverageLatencyMs() {
    return this.totalRequests > 0 ? Math.round(this.totalLatencyMs / this.totalRequests) : 0;
  }

  getStatus() {
    return {
      providerId: this.providerId,
      isHealthy: this.isHealthy,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      errorRate: this.totalRequests > 0 ? (this.failedRequests / this.totalRequests).toFixed(3) : 0,
      avgLatencyMs: this.getAverageLatencyMs(),
    };
  }
}

const _providerStates = new Map();

function _getProviderState(providerId) {
  if (!_providerStates.has(providerId)) {
    _providerStates.set(providerId, new ProviderState(providerId));
  }
  return _providerStates.get(providerId);
}

// ─── HTTP 유틸리티 ──────────────────────────────────────────────

/**
 * OpenAI 호환 API로 HTTP 요청 수행.
 * @param {string} baseUrl - 기본 URL (e.g., http://localhost:11434)
 * @param {string} path - API 경로 (e.g., /v1/chat/completions)
 * @param {object} body - 요청 바디
 * @param {string} method - HTTP 메서드 (기본: POST)
 * @returns {Promise<object>} 응답
 */
async function _makeHttpRequest(baseUrl, path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const protocol = url.protocol === 'https:' ? https : http;

    const startMs = Date.now();
    const reqOptions = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = protocol.request(url, reqOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        const latencyMs = Date.now() - startMs;

        if (res.statusCode >= 400) {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          err.latencyMs = latencyMs;
          reject(err);
        } else {
          try {
            const parsed = JSON.parse(data);
            resolve({ data: parsed, statusCode: res.statusCode, latencyMs });
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        }
      });
    });

    req.on('error', (err) => {
      err.latencyMs = Date.now() - startMs;
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// ─── OpenAI ↔ Anthropic 메시지 변환 ────────────────────────────

/**
 * Anthropic 메시지 형식 → OpenAI 형식 변환.
 * @param {array} anthropicMessages
 * @param {string} systemPrompt
 * @returns {array} OpenAI messages
 */
function _convertAnthropicToOpenAI(anthropicMessages, systemPrompt) {
  const openaiMessages = [];

  // System prompt
  if (systemPrompt) {
    openaiMessages.push({ role: 'system', content: systemPrompt });
  }

  // Messages
  for (const msg of (anthropicMessages || [])) {
    if (msg.role === 'user') {
      // Anthropic user message: string, content array, 또는 tool_result array
      if (Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result') {
        // tool_result → OpenAI tool message
        for (const tr of msg.content) {
          openaiMessages.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
      } else {
        const content = typeof msg.content === 'string'
          ? msg.content
          : msg.content?.map(b => b.type === 'text' ? b.text : JSON.stringify(b)).join('\n') || '';
        openaiMessages.push({ role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      const textParts = typeof msg.content === 'string'
        ? msg.content
        : msg.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || '';
      const toolCalls = Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'tool_use').map(b => ({
            id: b.id, type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }))
        : [];
      const assistantMsg = { role: 'assistant', content: textParts || null };
      if (toolCalls.length) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    }
  }

  return openaiMessages;
}

/**
 * OpenAI 응답 → Anthropic 형식 변환.
 * @param {object} openaiResp - OpenAI API 응답
 * @param {string} provider - Provider ID (지표용)
 * @returns {object} Anthropic 형식 응답
 */
function _convertOpenAIToAnthropic(openaiResp, provider) {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    throw new Error('SelfHosted: empty response');
  }

  const content = [];

  // Tool calls
  if (choice.message?.tool_calls?.length) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      });
    }
  }

  // Text content
  if (choice.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  return {
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    model: `selfhosted/${provider}/${openaiResp.model || 'unknown'}`,
    stop_reason: (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length) ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
    _selfHosted: true,
    _provider: provider,
  };
}

// ─── Provider 관리 ────────────────────────────────────────────

/**
 * Provider 설정 조회.
 * @param {string} providerId
 * @returns {object|null}
 */
function _getProviderConfig(providerId) {
  return SELF_HOSTED_CONFIG.providers.find(p => p.id === providerId) || null;
}

/**
 * Provider 내 모델 조회.
 * @param {string} providerId
 * @param {string} modelId
 * @returns {object|null}
 */
function _getModelConfig(providerId, modelId) {
  const provider = _getProviderConfig(providerId);
  if (!provider) return null;
  return provider.models?.find(m => m.id === modelId) || null;
}

/**
 * Health check — provider 가용성 확인.
 * @param {string} providerId
 * @returns {Promise<boolean>}
 */
async function healthCheck(providerId) {
  const state = _getProviderState(providerId);
  const provider = _getProviderConfig(providerId);

  if (!provider) {
    log.warn('Provider not found for health check', { providerId });
    return false;
  }

  try {
    // 모델 목록 조회로 가용성 확인
    const path = provider.type === 'vllm' ? '/v1/models' : '/api/tags';
    await _makeHttpRequest(provider.baseUrl, path, null, 'GET');

    state.lastHealthCheck = Date.now();
    state.isHealthy = true;
    state.consecutiveErrors = 0;

    log.debug('Health check passed', { providerId });
    return true;
  } catch (err) {
    state.recordError();
    state.lastHealthCheck = Date.now();
    log.warn('Health check failed', { providerId, error: err.message });
    return false;
  }
}

/**
 * Provider의 사용 가능한 모델 목록 조회 (캐시됨).
 * @param {string} providerId
 * @returns {Promise<array>} 모델 목록
 */
async function getModels(providerId) {
  const state = _getProviderState(providerId);
  const provider = _getProviderConfig(providerId);

  if (!provider) {
    log.warn('Provider not found for models', { providerId });
    return [];
  }

  // 캐시 체크 (5분)
  if (state.modelCache && Date.now() < state.modelCacheExpireAt) {
    return state.modelCache;
  }

  try {
    let path, parseModels;

    if (provider.type === 'vllm') {
      path = '/v1/models';
      parseModels = (data) => data.data?.map(m => ({ id: m.id, owned_by: m.owned_by })) || [];
    } else {
      // Ollama
      path = '/api/tags';
      parseModels = (data) => data.models?.map(m => ({ id: m.name, size: m.size, modified_at: m.modified_at })) || [];
    }

    const { data } = await _makeHttpRequest(provider.baseUrl, path, null, 'GET');
    const models = parseModels(data);

    // 캐시 저장
    state.modelCache = models;
    state.modelCacheExpireAt = Date.now() + 5 * 60 * 1000;

    log.debug('Models fetched', { providerId, count: models.length });
    return models;
  } catch (err) {
    state.recordError();
    log.warn('Failed to fetch models', { providerId, error: err.message });
    return [];
  }
}

// ─── LLM 호출 ────────────────────────────────────────────────

/**
 * Self-hosted LLM으로 메시지 생성.
 *
 * @param {string} providerId - Provider ID
 * @param {string} modelId - 모델 ID
 * @param {object} params - Anthropic 형식 파라미터
 *   - system: string
 *   - messages: array
 *   - max_tokens: number
 *   - tools: array (선택사항)
 * @returns {Promise<object>} Anthropic 형식 응답
 */
async function createMessage(providerId, modelId, params) {
  const provider = _getProviderConfig(providerId);
  const state = _getProviderState(providerId);

  if (!provider) {
    throw new Error(`Provider not found: ${providerId}`);
  }

  // 모델 설정 조회
  const modelConfig = _getModelConfig(providerId, modelId);
  if (!modelConfig) {
    log.warn('Model not found in provider config', { providerId, modelId });
  }

  // 메시지 변환
  const openaiMessages = _convertAnthropicToOpenAI(params.messages, params.system);

  // Tools 변환 (Anthropic → OpenAI)
  let tools;
  if (params.tools?.length) {
    tools = params.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  const openaiParams = {
    model: modelId,
    messages: openaiMessages,
    max_tokens: Math.min(params.max_tokens || 2048, modelConfig?.maxTokens || 8192),
    temperature: params.temperature ?? 1.0,
    tools: tools?.length ? tools : undefined,
  };

  log.debug('Self-hosted call', {
    providerId,
    modelId,
    messages: openaiMessages.length,
    tools: tools?.length || 0,
  });

  try {
    const startMs = Date.now();

    const { data, latencyMs } = await _makeHttpRequest(
      provider.baseUrl,
      '/v1/chat/completions',
      openaiParams
    );

    const response = _convertOpenAIToAnthropic(data, providerId);
    state.recordSuccess(latencyMs);

    log.debug('Self-hosted success', {
      providerId,
      modelId,
      latencyMs,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    });

    return response;
  } catch (err) {
    state.recordError();
    log.error('Self-hosted call failed', {
      providerId,
      modelId,
      error: err.message,
      statusCode: err.statusCode,
    });
    throw err;
  }
}

/**
 * Self-hosted LLM 스트리밍 (SSE).
 * EventEmitter 반환 — 'data', 'error', 'end' 이벤트.
 *
 * @param {string} providerId
 * @param {string} modelId
 * @param {object} params - Anthropic 형식
 * @returns {EventEmitter}
 */
function streamMessage(providerId, modelId, params) {
  const emitter = new EventEmitter();
  const provider = _getProviderConfig(providerId);
  const state = _getProviderState(providerId);

  if (!provider) {
    emitter.emit('error', new Error(`Provider not found: ${providerId}`));
    return emitter;
  }

  // 메시지 변환
  const openaiMessages = _convertAnthropicToOpenAI(params.messages, params.system);

  // Tools 변환
  let tools;
  if (params.tools?.length) {
    tools = params.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  const openaiParams = {
    model: modelId,
    messages: openaiMessages,
    max_tokens: params.max_tokens || 2048,
    temperature: params.temperature ?? 1.0,
    stream: true,
    tools: tools?.length ? tools : undefined,
  };

  // 비동기로 스트림 시작
  (async () => {
    try {
      const modelConfig = _getModelConfig(providerId, modelId);
      const url = new URL('/v1/chat/completions', provider.baseUrl);
      const protocol = url.protocol === 'https:' ? https : http;

      const reqOptions = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const startMs = Date.now();

      const req = protocol.request(url, reqOptions, (res) => {
        let buffer = '';

        if (res.statusCode >= 400) {
          emitter.emit('error', new Error(`HTTP ${res.statusCode}`));
          return;
        }

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6);
              if (data === '[DONE]') {
                // 스트림 종료
                const latencyMs = Date.now() - startMs;
                state.recordSuccess(latencyMs);
                emitter.emit('end');
              } else {
                try {
                  const chunk = JSON.parse(data);
                  // OpenAI SSE 청크 → 그대로 emit (상위에서 처리)
                  emitter.emit('data', chunk);
                } catch (e) {
                  log.warn('Failed to parse SSE chunk', { error: e.message });
                }
              }
            }
          }
        });

        res.on('end', () => {
          if (buffer.trim()) {
            log.warn('Incomplete SSE data at end', { providerId, modelId });
          }
          emitter.emit('end');
        });
      });

      req.on('error', (err) => {
        state.recordError();
        emitter.emit('error', err);
      });

      req.write(JSON.stringify(openaiParams));
      req.end();
    } catch (err) {
      state.recordError();
      emitter.emit('error', err);
    }
  })();

  return emitter;
}

// ─── 선택 로직 ────────────────────────────────────────────────

/**
 * Tier와 가용성 기반 최적 Provider 선택.
 *
 * @param {string} tier - tier1 | tier2 (또는 undefined = 모든 provider)
 * @returns {object} { providerId, modelId } 또는 null
 */
function selectProvider(tier) {
  if (!SELF_HOSTED_CONFIG.enabled || SELF_HOSTED_CONFIG.providers.length === 0) {
    return null;
  }

  for (const provider of SELF_HOSTED_CONFIG.providers) {
    const state = _getProviderState(provider.id);

    // 건강한 provider만 선택
    if (!state.isHealthy) {
      continue;
    }

    // Tier 필터링 (tier 미지정 시 모든 모델 허용)
    const availableModels = provider.models?.filter(m => !tier || m.tier === tier) || [];

    if (availableModels.length > 0) {
      // 첫 번째 모델 선택 (또는 더 정교한 로직 가능)
      return {
        providerId: provider.id,
        modelId: availableModels[0].id,
      };
    }
  }

  return null;
}

/**
 * 현재 상태 조회.
 * @returns {object} { enabled, providers: [ { providerId, isHealthy, ... } ] }
 */
function getStatus() {
  return {
    enabled: SELF_HOSTED_CONFIG.enabled,
    providers: SELF_HOSTED_CONFIG.providers.map(p => _getProviderState(p.id).getStatus()),
  };
}

/**
 * Graceful 초기화 및 정리.
 */
async function initialize() {
  if (!SELF_HOSTED_CONFIG.enabled) {
    log.info('Self-hosted LLM support disabled');
    return;
  }

  log.info('Initializing self-hosted LLM support', {
    providers: SELF_HOSTED_CONFIG.providers.map(p => p.id),
  });

  // 모든 provider에 대해 health check 병렬 실행
  const checks = SELF_HOSTED_CONFIG.providers.map(p =>
    healthCheck(p.id).catch(err => {
      log.warn('Initial health check failed', { providerId: p.id, error: err.message });
      return false;
    })
  );

  await Promise.all(checks);
  log.info('Self-hosted initialization complete');
}

module.exports = {
  initialize,
  createMessage,
  streamMessage,
  healthCheck,
  getModels,
  selectProvider,
  getStatus,
};
