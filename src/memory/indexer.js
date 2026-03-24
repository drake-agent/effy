/**
 * indexer.js — SessionIndexer: 세션 종료 시 메모리 정리/승격 엔진.
 *
 * 트리거: 세션 5분 idle → pool.SessionRegistry.onIdle() 콜백
 *
 * 실행 단계:
 * 1. summarize()         — Haiku 대화 요약
 * 2. detectDecisions()   — 결정사항 키워드 감지
 * 3. extractTopics()     — 토픽 추출
 * 4. evaluatePromotion() — 3기준 판단 트리
 * 5. promoteToSemantic() — L3 승격
 * 6. enforceAntiBloat()  — 상한 체크
 * 7. logPromotion()      — 추적 로그
 */
const { config } = require('../config');
const { episodic, semantic, entity, promotion, cost } = require('./manager');
const { client } = require('../shared/anthropic');

// ─── MemoryBulletin (지연 로딩 — 순환 참조 방지) ───
let _bulletin = null;
function setBulletin(instance) { _bulletin = instance; }

// ─── 8가지 메모리 타입 자동 분류 ───
const GOAL_KEYWORDS = ['목표', '달성', 'goal', 'objective', 'target', 'milestone', 'KPI', 'OKR', '완료해야', '해야 할'];
const TODO_KEYWORDS = ['할 일', 'todo', 'task', '작업', '해야', '해줘', '부탁', 'assign', '담당'];
const PREFERENCE_KEYWORDS = ['선호', '좋아', '싫어', 'prefer', 'like', 'dislike', '스타일', '방식으로'];
const IDENTITY_KEYWORDS = ['저는', '제가', '나는', 'my role', 'i am', '담당자', '역할'];
const EVENT_KEYWORDS = ['회의', '미팅', '일정', 'meeting', 'event', 'schedule', '발표', '데모', 'demo'];
const OBSERVATION_KEYWORDS = ['보니까', '느낌', '생각에', 'seems', 'noticed', 'observed', '패턴'];

function classifyMemoryType(content, sourceType) {
  if (sourceType === 'decision') return 'Decision';
  const lower = (content || '').toLowerCase();
  if (GOAL_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'Goal';
  if (TODO_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'Todo';
  if (PREFERENCE_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'Preference';
  if (IDENTITY_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'Identity';
  if (EVENT_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'Event';
  if (OBSERVATION_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'Observation';
  return 'Fact';
}

// ─── 결정사항 감지 키워드 (YAML 우선, 하드코딩 폴백) ───
const DECISION_KEYWORDS = config.memory?.promotion?.decisionKeywords || [
  '결정', '확정', '합의', '정했', '결론은',
  '하기로 했', '채택', '승인',
  'decided', 'confirmed', 'agreed', 'finalized',
];

// ─── 장기 가치 키워드 (YAML 우선, 하드코딩 폴백) ───
const LONG_TERM_HINTS = config.memory?.promotion?.longTermHints || [
  '아키텍처', '정책', '프로세스', '온보딩',
  '컨벤션', '설계 원칙', 'architecture', 'policy', 'convention',
  'standard',
];

/**
 * 세션 인덱싱 메인 함수.
 * @param {string} sessionKey
 * @param {object} sessionData - { userId, channelId, agentType, functionType }
 * @param {Array} messages - 세션 대화 히스토리
 */
async function indexSession(sessionKey, sessionData, messages) {
  if (!messages || messages.length < 2) return; // 최소 2건 이상

  const { userId, channelId, agentType } = sessionData;
  const conversationText = messages.map(m => `[${m.role}] ${m.content}`).join('\n');

  // S-3: 에이전트 설정에서 쓰기 가능 풀 결정
  const agents = config.agents?.list || [];
  const agentCfg = agents.find(a => a.id === agentType);
  const writablePools = agentCfg?.memory?.shared_write || ['team'];
  const targetPool = writablePools[0] || 'team';

  try {
    // 1. Haiku 요약
    const summary = await summarize(conversationText);
    if (!summary) return;

    // 2. 결정사항 감지
    const decisions = detectDecisions(conversationText, summary);

    // 3. 토픽 추출
    const topics = summary.topics || [];

    // 4. L4 Entity 업데이트
    for (const topic of topics) {
      entity.upsert('topic', topic, topic);
      entity.addRelationship('user', userId, 'topic', topic, 'discussed');
      if (channelId) {
        entity.addRelationship('channel', channelId, 'topic', topic, 'discussed_in');
      }
    }

    // 5. Memory Promotion 판단 트리
    const promotions = await evaluatePromotion(summary, decisions, topics, channelId, userId);

    // 6. L3 승격 실행 (각 promotion별 에러 격리) + 메모리 타입 자동 분류
    let hasDecision = false;
    for (const p of promotions) {
      const memoryType = classifyMemoryType(p.content, p.sourceType);
      if (memoryType === 'Decision') hasDecision = true;
      try {
        const hash = await semantic.save({
          content: p.content,
          sourceType: p.sourceType,
          channelId,
          userId,
          tags: topics,
          promotionReason: p.reason,
          poolId: targetPool,
          memoryType,
        });
        await promotion.log('L2', 'L3', hash, p.reason);
        console.log(`[indexer] Promoted to L3 [${memoryType}]: ${p.reason}`);
      } catch (saveErr) {
        console.warn(`[indexer] Promotion save failed for "${p.reason}": ${saveErr.message}`);
      }
    }

    // 7. Anti-Bloat 체크
    semantic.enforceAntiBloat(channelId, userId);

    // 8. MemoryBulletin 무효화 (결정사항이 있으면)
    if (hasDecision && channelId && _bulletin) {
      _bulletin.invalidate(channelId);
    }

    console.log(`[indexer] Session indexed: ${sessionKey} (${promotions.length} promotions, ${topics.length} topics)`);
  } catch (err) {
    console.error(`[indexer] Error indexing ${sessionKey}:`, err.message);
  }
}

/**
 * Haiku 요약.
 */
async function summarize(conversationText) {
  // 대화가 너무 짧으면 스킵
  if (conversationText.length < 100) return null;

  try {
    const response = await client.messages.create({
      model: config.anthropic.defaultModel,
      max_tokens: 500,
      system: `아래 대화를 분석하세요.

출력 형식 (JSON):
{
  "summary": "3문장 이내 요약",
  "decisions": ["결정사항 목록 (없으면 빈 배열)"],
  "topics": ["키워드1", "키워드2", "키워드3"],
  "user_pattern": "유저 선호/스타일 (없으면 null)"
}

JSON만 출력하세요.`,
      messages: [{ role: 'user', content: conversationText.slice(0, 4000) }],
    });

    const text = response.content[0]?.text || '';
    // JSON 파싱 시도 (LLM 출력이므로 try-catch 필수)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        // SEC: LLM 출력 스키마 기본 검증
        if (typeof parsed !== 'object' || parsed === null) return null;
        if (parsed.topics && !Array.isArray(parsed.topics)) parsed.topics = [];
        if (parsed.decisions && !Array.isArray(parsed.decisions)) parsed.decisions = [];
        return parsed;
      } catch (parseErr) {
        console.warn('[indexer] JSON parse failed:', parseErr.message);
        return null;
      }
    }
    return null;
  } catch (err) {
    console.error('[indexer] Summarize error:', err.message);
    return null;
  }
}

/**
 * 결정사항 키워드 감지.
 */
function detectDecisions(fullText, summary) {
  const decisions = [];

  // 키워드 기반 감지 — 모든 매칭 키워드의 문장 수집
  const sentences = fullText.split(/[.\n]/);
  for (const keyword of DECISION_KEYWORDS) {
    if (!fullText.includes(keyword)) continue;
    const matched = sentences.filter(s => s.includes(keyword));
    for (const s of matched.slice(0, 3)) {
      decisions.push(s.trim().slice(0, 200));
    }
  }

  // Haiku 요약에서 감지된 결정사항 추가
  if (summary?.decisions?.length > 0) {
    for (const d of summary.decisions) {
      if (!decisions.includes(d)) decisions.push(d);
    }
  }

  return [...new Set(decisions)]; // 중복 제거
}

/**
 * 3기준 승격 판단 트리.
 */
async function evaluatePromotion(summary, decisions, topics, channelId, userId) {
  const promotions = [];
  const summaryText = summary?.summary || '';

  // ① 결정사항 → 즉시 L3 + decision 타입
  for (const d of decisions) {
    promotions.push({
      content: d,
      sourceType: 'decision',
      reason: `결정사항: ${d.slice(0, 50)}`,
    });
  }

  // ② 토픽 weight >= threshold → L3
  const topicThreshold = config.memory?.promotion?.topicWeightThreshold || 3.0;
  for (const topic of topics) {
    const weight = await entity.getTopicWeight(topic);
    if (weight >= topicThreshold && summaryText) {
      promotions.push({
        content: `[${topic}] ${summaryText}`,
        sourceType: 'repeated_topic',
        reason: `반복 토픽 (weight=${weight.toFixed(1)}): ${topic}`,
      });
    }
  }

  // ③ 장기 가치 판단 (Haiku)
  if (promotions.length === 0 && summaryText.length > 50) {
    const hasLongTermHint = LONG_TERM_HINTS.some(h => summaryText.toLowerCase().includes(h.toLowerCase()));
    if (hasLongTermHint) {
      try {
        const response = await client.messages.create({
          model: config.anthropic.defaultModel,
          max_tokens: 10,
          system: '이 내용이 한 달 뒤에도 팀에 참고가치가 있는가? YES 또는 NO로만 답하라.',
          messages: [{ role: 'user', content: summaryText }],
        });
        const answer = (response.content[0]?.text || '').trim().toUpperCase();
        if (answer.startsWith('YES')) {
          promotions.push({
            content: summaryText,
            sourceType: 'long_term',
            reason: '장기 가치: Haiku 판단 YES',
          });
        }
      } catch (err) {
        console.warn('[indexer] Long-term check error:', err.message);
      }
    }
  }

  return promotions;
}

module.exports = { indexSession, classifyMemoryType, setBulletin };
