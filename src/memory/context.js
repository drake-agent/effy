/**
 * context.js — Context Engine: 3경로 크로스채널 검색 + Budget Allocator.
 *
 * Phase A: 기본 로드 (L1 Working + L4 Entity + L2 현재 채널)
 * Phase B: 3경로 검색 (Promise.all 구조)
 *   경로 1: 유저 크로스채널 히스토리
 *   경로 2: 시맨틱/FTS 검색 (유저/채널 무관)
 *   경로 3: 언급된 채널 히스토리 + 결정사항
 *
 * NOTE: Phase 1 (SQLite/better-sqlite3)에서는 동기 API로 실질적 직렬 실행.
 *       Phase 2 (PostgreSQL/async driver) 전환 시 실제 병렬로 동작.
 */
const { episodic, semantic, entity } = require('./manager');
const { config } = require('../config');  // N-2: 최상위 import로 이동
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
// R3-DUP-2 fix: utils.js estimateTokens 사용 — 자모 범위(LO-2) 포함 버전 통합
const { estimateTokens } = require('../shared/utils');
// R3-INFO-1 fix: 구조화 로거 도입
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:context');

// ─── Phase 2: Context Hub API Docs Auto-Injection ───
// Lazy require — Context Hub가 미설치여도 크래시 안 남
let _chubAdapter = null;
function _getChub() {
  if (_chubAdapter !== undefined && _chubAdapter !== null) return _chubAdapter;
  try {
    const { getChubAdapter } = require('../knowledge/chub-adapter');
    _chubAdapter = getChubAdapter(config.contextHub || {});
    return _chubAdapter;
  } catch {
    _chubAdapter = null;
    return null;
  }
}

// API 관련 키워드 감지 패턴
const API_KEYWORDS_RE = /\b(api|sdk|library|패키지|라이브러리|openai|anthropic|stripe|firebase|aws|gcp|azure|langchain|supabase|prisma|graphql|rest\s?api|webhook|oauth|jwt|endpoint)\b/i;
const API_TECH_RE = /\b(import|require|install|pip|npm|yarn|pnpm|curl|fetch|axios)\b/i;

/**
 * Phase 2: 사용자 메시지에서 API 관련 키워드를 감지하여 검색 쿼리 추출.
 * @param {string} text
 * @returns {string|null} 검색 쿼리 또는 null
 */
function detectApiQuery(text) {
  if (!text || text.length < 5) return null;
  const hasApiKeyword = API_KEYWORDS_RE.test(text);
  const hasTechKeyword = API_TECH_RE.test(text);
  if (!hasApiKeyword && !hasTechKeyword) return null;
  // API 키워드가 있으면 원문에서 영문 단어 위주로 쿼리 구성
  const words = text.match(/[a-zA-Z][\w.-]{1,30}/g);
  if (!words || words.length === 0) return null;
  // 불용어 제거 후 상위 5개
  const stopwords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'for', 'and', 'or', 'to', 'in', 'of', 'how', 'what', 'use', 'using', 'with', 'this', 'that']);
  const filtered = words.filter(w => !stopwords.has(w.toLowerCase()) && w.length > 2);
  return filtered.slice(0, 5).join(' ') || null;
}

// ─── Budget: YAML config.budgetProfiles에서 로드 (STANDARD 폴백) ───
const DEFAULT_BUDGET = {
  system_prompt: 2000, entity_context: 2000, route1_cross_channel: 2000,
  route2_semantic: 4000, route3_channel: 2000, current_thread: 10000,
  recent_history: 5000, tool_results: 5000, buffer: 3000, total: 35000,
};

/**
 * 항목 배열을 토큰 버짓 내로 트리밍.
 */
function trimToBudget(items, budgetTokens) {
  const result = [];
  let used = 0;
  for (const item of items) {
    const tokens = estimateTokens(item.content || JSON.stringify(item));
    if (used + tokens > budgetTokens) break;
    result.push(item);
    used += tokens;
  }
  return result;
}

/**
 * 컨텍스트 빌드 — 메인 함수.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.channelId
 * @param {string} params.conversationKey
 * @param {string} params.text - 현재 메시지 텍스트
 * @param {string} params.budgetProfile - 'LIGHT' | 'STANDARD' | 'DEEP'
 * @param {Array}  params.channelMentions - [{id, name}]
 * @param {object} params.workingMemory - WorkingMemory 인스턴스
 */
async function buildContext(params) {
  const { userId, channelId, conversationKey, text, budgetProfile, channelMentions, workingMemory, accessiblePools } = params;
  // v3: YAML 기반 budget profiles (STANDARD 폴백)
  const budget = config.budgetProfiles?.[budgetProfile] || DEFAULT_BUDGET;

  // ─── Phase A: 기본 로드 ───
  const currentThread = workingMemory ? workingMemory.get(conversationKey) : [];
  const entityProfile = entity.get('user', userId);
  const entityRelations = entity.getRelated('user', userId, 10);

  const context = {
    profile: budgetProfile,
    budget,
    entityContext: { profile: entityProfile, relations: entityRelations },
    currentThread: trimToBudget(
      currentThread.map(e => ({ content: `[${e.role}] ${e.content}` })),
      budget.current_thread
    ),
    route1: [],
    route2: [],
    route3: [],
    route3Decisions: [],
    recentHistory: [],
    apiDocs: [],  // Phase 2: Context Hub API 문서 자동 주입
    sessionSummaries: [],  // Harness: 최근 세션 요약 (Startup Sequence)
  };

  // LIGHT는 여기서 끝
  if (budgetProfile === 'LIGHT') {
    return context;
  }

  // ─── Phase B: 3경로 병렬 ───
  const route1Promise = budget.route1_cross_channel > 0
    ? Promise.resolve(episodic.getUserCrossChannelHistory(userId, channelId, 20))
    : Promise.resolve([]);

  // v3: pool 필터 적용된 시맨틱 검색
  const pools = (accessiblePools && Array.isArray(accessiblePools) && accessiblePools.length > 0) ? accessiblePools : ['team'];
  const route2Promise = budget.route2_semantic > 0
    ? Promise.resolve(searchSemantic(text, pools))
    : Promise.resolve([]);

  const route3Promise = budget.route3_channel > 0 && channelMentions.length > 0
    ? Promise.resolve(searchChannels(channelMentions.slice(0, 3)))
    : Promise.resolve({ history: [], decisions: [] });

  const recentPromise = budget.recent_history > 0
    ? Promise.resolve(episodic.getHistory(conversationKey, 30))
    : Promise.resolve([]);

  const [route1Raw, route2Raw, route3Raw, recentRaw] = await Promise.all([
    route1Promise, route2Promise, route3Promise, recentPromise,
  ]);

  // 트리밍
  context.route1 = trimToBudget(
    route1Raw.map(r => ({ ...r, content: `[${r.channel_id}] ${r.content}` })),
    budget.route1_cross_channel
  );
  context.route2 = trimToBudget(route2Raw, budget.route2_semantic);
  context.route3 = trimToBudget(
    (route3Raw.history || []).map(r => ({ ...r, content: `[${r.user_id}] ${r.content}` })),
    budget.route3_channel
  );
  context.route3Decisions = route3Raw.decisions || [];
  context.recentHistory = trimToBudget(
    recentRaw.map(r => ({ content: `[${r.role}] ${r.content}` })),
    budget.recent_history
  );

  // 검색 히트 access_count 업데이트
  const hitIds = context.route2.filter(r => r.id).map(r => r.id);
  if (hitIds.length > 0) semantic.touchAccess(hitIds);

  // ─── Phase 2: Context Hub API Docs 자동 주입 ───
  // 대화 텍스트에서 API 키워드 감지 → chub 자동 검색 (STANDARD/DEEP만)
  const apiQuery = detectApiQuery(text);
  if (apiQuery) {
    const chub = _getChub();
    if (chub) {
      try {
        const docs = await chub.searchDocs(apiQuery, { limit: 3 });
        context.apiDocs = docs;
      } catch (chubErr) {
        log.debug('Context Hub search skipped', { error: chubErr.message });
      }
    }
  }

  // ─── P-5: Context Window Budget Guard ───
  // 전체 컨텍스트 토큰이 budget.total의 80%를 넘으면 우선순위 역순으로 트리밍
  let totalEstimate = estimateContextTokens(context);
  const safeLimit = Math.floor((budget.total || 35000) * 0.8);
  if (totalEstimate > safeLimit) {
    const originalEstimate = totalEstimate;
    // 트리밍 우선순위 (먼저 줄이는 것부터): recentHistory → route1 → route3
    context.recentHistory = trimToBudget(context.recentHistory, Math.floor(budget.recent_history * 0.5));
    totalEstimate = estimateContextTokens(context);
    if (totalEstimate > safeLimit) {
      context.route1 = trimToBudget(context.route1, Math.floor(budget.route1_cross_channel * 0.5));
      totalEstimate = estimateContextTokens(context);
    }
    if (totalEstimate > safeLimit) {
      context.route3 = trimToBudget(context.route3, Math.floor(budget.route3_channel * 0.5));
      totalEstimate = estimateContextTokens(context);
    }
    log.warn('P-5 Budget guard triggered', { original: originalEstimate, trimmed: totalEstimate, limit: safeLimit });
  }

  return context;
}

/**
 * P-5: 빌드된 컨텍스트의 총 토큰 추정.
 */
function estimateContextTokens(ctx) {
  let total = 0;
  total += estimateTokens(JSON.stringify(ctx.entityContext || {}));
  for (const e of ctx.currentThread) total += estimateTokens(e.content);
  for (const e of ctx.route1) total += estimateTokens(e.content);
  for (const e of ctx.route2) total += estimateTokens(e.content || JSON.stringify(e));
  for (const e of ctx.route3) total += estimateTokens(e.content);
  for (const d of ctx.route3Decisions) total += estimateTokens(d.content);
  for (const e of ctx.recentHistory) total += estimateTokens(e.content);
  // Phase 2: API docs
  for (const d of (ctx.apiDocs || [])) total += estimateTokens(d.description || d.name || '');
  return total;
}

/**
 * 시맨틱/FTS 검색 (경로 2).
 * v3: pool 필터 지원.
 */
function searchSemantic(queryText, pools = ['team']) {
  if (!queryText || queryText.trim().length < 2) return [];
  try {
    // 공통 FTS5 새니타이저 사용
    const { words, query: ftsQuery } = sanitizeFtsQuery(queryText);
    if (words.length === 0) return [];
    return semantic.searchWithPools(ftsQuery, pools, 10);
  } catch (e) {
    log.warn('FTS search error', { error: e.message });
    return [];
  }
}

/**
 * 채널 히스토리 + 결정사항 조회 (경로 3).
 */
function searchChannels(channelMentions) {
  const allHistory = [];
  const allDecisions = [];
  for (const ch of channelMentions) {
    const history = episodic.getChannelHistory(ch.id, 15);
    const decisions = semantic.getChannelDecisions(ch.id, 5);
    allHistory.push(...history.map(h => ({ ...h, _from_channel: ch.id })));
    allDecisions.push(...decisions.map(d => ({ ...d, _from_channel: ch.id })));
  }
  return { history: allHistory, decisions: allDecisions };
}

/**
 * SEC-PROMPT: Sanitize text for safe injection into system prompt.
 * Strips XML-like tags and enforces max length limits.
 */
function _sanitizeForPrompt(text, maxLen = 200) {
  if (!text) return '';
  // Strip XML-like tags to prevent prompt injection
  let sanitized = text.replace(/<[^>]+>/g, '');
  // SEC-PROMPT-2: Strip template syntax patterns (Jinja, Django, MediaWiki)
  sanitized = sanitized.replace(/\{\{[\s\S]*?\}\}/g, '');   // {{...}} Jinja/Mustache
  sanitized = sanitized.replace(/\{%[\s\S]*?%\}/g, '');     // {%...%} Django
  sanitized = sanitized.replace(/\[\[[\s\S]*?\]\]/g, '');   // [[...]] MediaWiki
  sanitized = sanitized.replace(/\$\{[\s\S]*?\}/g, '');     // ${...} JS template literal
  return sanitized.slice(0, maxLen);
}

/**
 * SEC-003/UNIFIED-8: Sanitize memory context for prompt injection prevention.
 * Strips prompt injection markers and enforces max length limits.
 * Applied to episodic memory, cross-channel history, and knowledge content.
 */
function _sanitizeForContext(text, maxLen = 500) {
  if (!text || typeof text !== 'string') return '';
  // Strip potential prompt injection markers
  let clean = text
    // eslint-disable-next-line security/detect-unsafe-regex -- bounded input (maxLen 500), no catastrophic backtrack risk
    .replace(/\b(ignore|forget|disregard)\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|context)/gi, '[filtered]')
    .replace(/\b(system|assistant|user)\s*:/gi, '[filtered]:')
    .replace(/<\/?(?:system|instruction|prompt|admin|override)[^>]*>/gi, '[filtered]');
  // Truncate
  if (clean.length > maxLen) clean = clean.slice(0, maxLen) + '…';
  return clean;
}

/**
 * 빌드된 컨텍스트를 LLM 시스템 프롬프트 형태로 포맷.
 */
function formatContextForLLM(ctx) {
  const parts = [];

  if (ctx.entityContext?.profile) {
    const safeProperties = _sanitizeForContext(JSON.stringify(ctx.entityContext.profile.properties || {}), 300);
    parts.push(`<entity_profile>\nUser: ${ctx.entityContext.profile.name || 'unknown'}\nProperties: ${safeProperties}\n</entity_profile>`);
  }

  if (ctx.route1.length > 0) {
    const sanitizedContent = ctx.route1.map(r => _sanitizeForContext(r.content, 500)).join('\n');
    parts.push(`<cross_channel_user_history>\n${sanitizedContent}\n</cross_channel_user_history>`);
  }

  if (ctx.route2.length > 0) {
    const sanitizedContent = ctx.route2.map(r => `[source=${r.source_type}, ch=${r.channel_id}] ${_sanitizeForContext(r.content, 500)}`).join('\n');
    parts.push(`<relevant_knowledge>\n${sanitizedContent}\n</relevant_knowledge>`);
  }

  if (ctx.route3.length > 0 || ctx.route3Decisions.length > 0) {
    const lines = [];
    for (const d of ctx.route3Decisions) lines.push(`[DECISION] ${_sanitizeForContext(d.content, 500)}`);
    for (const h of ctx.route3) lines.push(_sanitizeForContext(h.content, 500));
    parts.push(`<referenced_channel_context>\n${lines.join('\n')}\n</referenced_channel_context>`);
  }

  // Harness: Startup Sequence — 세션 요약 주입 (Progressive Disclosure)
  // 새 대화 시작 시 최근 세션 활동을 컨텍스트로 제공하여 에이전트가 빠르게 오리엔테이션
  if (ctx.sessionSummaries && ctx.sessionSummaries.length > 0) {
    const summaryLines = ctx.sessionSummaries.map(s => `- ${_sanitizeForPrompt(s.content, 300)}`);
    parts.push(`<recent_session_activity>\n${summaryLines.join('\n')}\n</recent_session_activity>`);
  }

  // Phase 2: API 문서 참조 주입 + SEC-PROMPT sanitization
  if (ctx.apiDocs && ctx.apiDocs.length > 0) {
    const docLines = ctx.apiDocs.map(d => {
      const safeName = _sanitizeForPrompt(d.name, 100);
      const safeDesc = _sanitizeForPrompt(d.description, 200);
      return `- **${safeName}** (id="${d.id}"): ${safeDesc} [source: ${d.source || 'default'}]`;
    });
    parts.push(`<available_api_references>\nThe following API docs match the conversation topic. Use \`get_api_doc\` tool with the id to retrieve full documentation.\n${docLines.join('\n')}\n</available_api_references>`);
  }

  return parts.join('\n\n');
}

module.exports = { buildContext, formatContextForLLM, detectApiQuery };
