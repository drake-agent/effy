/**
 * llm-client.js — Multi-Provider LLM Client.
 *
 * Primary: Anthropic (Claude) — 기본 프로바이더
 * Fallback: OpenAI (GPT-4o) — Claude 장애 시 자동 전환
 *
 * 장애 감지:
 * - 연속 N회 API 에러 (429/500/502/503) → fallback 전환
 * - cooldown 후 primary 재시도
 *
 * Config:
 *   llm.primary: anthropic (기본)
 *   llm.fallback.enabled: true
 *   llm.fallback.provider: openai
 *   llm.fallback.apiKey: ${OPENAI_API_KEY}
 *   llm.fallback.model: gpt-4o
 *   llm.fallback.triggerAfterErrors: 3
 *   llm.fallback.cooldownMs: 300000  (5분 후 primary 재시도)
 */
const Anthropic = require('@anthropic-ai/sdk');
const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('llm-client');

// ─── Primary: Anthropic ──────────────────────────────

const anthropicClient = new Anthropic({ apiKey: config.anthropic?.apiKey });

// ─── Fallback State ──────────────────────────────────
// R3-SEC-1 fix: provider별 독립 circuit breaker 상태
const _primaryHealth = { failures: 0, lastFailure: 0, open: false };
const _fallbackHealth = { failures: 0, lastFailure: 0, open: false };

let _fallbackActive = false;
let _fallbackStartedAt = 0;
let _openaiModule = null;  // lazy require

const FALLBACK_CONFIG = {
  enabled: config.llm?.fallback?.enabled ?? false,
  provider: config.llm?.fallback?.provider ?? 'openai',
  apiKey: config.llm?.fallback?.apiKey ?? process.env.OPENAI_API_KEY ?? '',
  model: config.llm?.fallback?.model ?? 'gpt-5.4-mini',
  triggerAfterErrors: config.llm?.fallback?.triggerAfterErrors ?? 3,
  cooldownMs: config.llm?.fallback?.cooldownMs ?? 300000,  // 5분
};

// ─── Anthropic → OpenAI 모델 매핑 ────────────────────

const MODEL_MAP = {
  'claude-haiku-4-5-20251001': 'gpt-5.4-nano',
  'claude-sonnet-4-20250514':  'gpt-5.4-mini',
  'claude-opus-4-20250514':    'gpt-5.4',
};

// ─── OpenAI Client (Lazy Init) ───────────────────────

function getOpenAIClient() {
  if (!FALLBACK_CONFIG.apiKey) return null;
  if (_openaiModule) return _openaiModule;

  try {
    // OpenAI SDK — optional dependency
    const OpenAI = require('openai');
    _openaiModule = new OpenAI({ apiKey: FALLBACK_CONFIG.apiKey });
    log.info('OpenAI fallback client initialized');
    return _openaiModule;
  } catch (err) {
    log.warn('OpenAI SDK not available for fallback', { error: err.message });
    return null;
  }
}

// ─── Unified Message Create ──────────────────────────

/**
 * LLM 호출 — Primary(Anthropic) 우선, 장애 시 Fallback(OpenAI) 자동 전환.
 *
 * @param {object} params - Anthropic API 파라미터 형식
 * @returns {object} Anthropic 응답 형식으로 통일
 */
async function createMessage(params) {
  // Fallback cooldown 체크: 시간 지나면 primary 재시도
  if (_fallbackActive && Date.now() - _fallbackStartedAt > FALLBACK_CONFIG.cooldownMs) {
    log.info('Fallback cooldown expired, retrying primary (Anthropic)');
    _fallbackActive = false;
    _primaryHealth.failures = 0;
    _primaryHealth.open = false;
  }

  // Primary 시도
  if (!_fallbackActive) {
    try {
      const response = await anthropicClient.messages.create(params);
      // R3-SEC-1: primary 성공 → primary health 리셋
      _primaryHealth.failures = 0;
      _primaryHealth.open = false;
      return response;
    } catch (err) {
      const status = err.status || err.statusCode || 0;

      // Fallback 대상 에러인지 확인
      if (FALLBACK_CONFIG.enabled && [429, 500, 502, 503, 529].includes(status)) {
        _primaryHealth.failures++;
        _primaryHealth.lastFailure = Date.now();
        log.warn(`Anthropic error ${status} (${_primaryHealth.failures}/${FALLBACK_CONFIG.triggerAfterErrors})`, { model: params.model });

        if (_primaryHealth.failures >= FALLBACK_CONFIG.triggerAfterErrors) {
          _primaryHealth.open = true;
          _fallbackActive = true;
          _fallbackStartedAt = Date.now();
          log.warn('Switching to fallback provider', { provider: FALLBACK_CONFIG.provider });
          // fallthrough → fallback 실행
        } else {
          throw err;  // 아직 threshold 안 넘음 → 상위에서 재시도
        }
      } else {
        throw err;  // 비대상 에러 → 그대로 전파
      }
    }
  }

  // Fallback: OpenAI
  if (_fallbackActive) {
    return await _callOpenAI(params);
  }

  // 여기 도달하면 안 됨
  throw new Error('LLM client: no provider available');
}

/**
 * Anthropic 형식 → OpenAI 형식 변환 + 호출 + 응답 역변환.
 */
async function _callOpenAI(anthropicParams) {
  const openai = getOpenAIClient();
  if (!openai) {
    throw new Error('OpenAI fallback not available (missing API key or SDK)');
  }

  const openaiModel = MODEL_MAP[anthropicParams.model] || FALLBACK_CONFIG.model;

  // Anthropic messages → OpenAI messages 변환
  const openaiMessages = [];

  // system prompt
  if (anthropicParams.system) {
    openaiMessages.push({ role: 'system', content: anthropicParams.system });
  }

  // conversation messages (Anthropic → OpenAI role mapping)
  for (const msg of (anthropicParams.messages || [])) {
    if (msg.role === 'user') {
      // Anthropic user message: string, content array, 또는 tool_result array
      if (Array.isArray(msg.content) && msg.content[0]?.type === 'tool_result') {
        // R5-BUG-1: tool_result → OpenAI tool message
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

  // Tools 변환 (Anthropic → OpenAI function calling)
  let tools;
  if (anthropicParams.tools?.length) {
    tools = anthropicParams.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  log.info('OpenAI fallback call', { model: openaiModel, messages: openaiMessages.length, tools: tools?.length || 0 });

  try {
    const response = await openai.chat.completions.create({
      model: openaiModel,
      messages: openaiMessages,
      max_tokens: anthropicParams.max_tokens || 4096,
      tools: tools?.length ? tools : undefined,
    });

    // OpenAI 응답 → Anthropic 형식으로 변환
    return _convertOpenAIResponse(response, openaiModel);
  } catch (err) {
    log.error('OpenAI fallback failed', { error: err.message });
    throw err;
  }
}

/**
 * OpenAI 응답 → Anthropic 응답 형식 변환.
 */
function _convertOpenAIResponse(openaiResp, model) {
  const choice = openaiResp.choices?.[0];
  if (!choice) throw new Error('OpenAI: empty response');

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
    content,
    model: `openai/${model}`,
    // v4: 'tool_calls', v6: 'tool_calls' (유지됨) — 방어적으로 둘 다 체크
    stop_reason: (choice.finish_reason === 'tool_calls' || choice.message?.tool_calls?.length) ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: openaiResp.usage?.prompt_tokens || 0,
      output_tokens: openaiResp.usage?.completion_tokens || 0,
    },
    _fallback: true,  // 마커: fallback으로 생성됨
  };
}

/**
 * 스트리밍 — primary만 지원 (fallback은 non-streaming).
 */
function streamMessage(params) {
  return anthropicClient.messages.stream(params);
}

/**
 * 현재 상태 조회 (Dashboard용).
 */
function getStatus() {
  return {
    primary: 'anthropic',
    fallback: FALLBACK_CONFIG.enabled ? FALLBACK_CONFIG.provider : 'disabled',
    fallbackActive: _fallbackActive,
    // R3-SEC-1: provider별 독립 상태 리포트
    circuitBreaker: {
      primary: { failures: _primaryHealth.failures, open: _primaryHealth.open, lastFailure: _primaryHealth.lastFailure },
      fallback: { failures: _fallbackHealth.failures, open: _fallbackHealth.open, lastFailure: _fallbackHealth.lastFailure },
    },
    cooldownRemaining: _fallbackActive
      ? Math.max(0, FALLBACK_CONFIG.cooldownMs - (Date.now() - _fallbackStartedAt))
      : 0,
  };
}

module.exports = {
  client: anthropicClient,        // 하위 호환 (기존 코드가 client.messages.create 직접 호출)
  createMessage,                   // 새 통합 API
  streamMessage,                   // 스트리밍 (primary only)
  getStatus,                       // 대시보드용
  MODEL_MAP,
};
