/**
 * router.js — Request Classifier + Budget Allocator.
 *
 * 1단계: 이벤트 타입 분류 (dm / mention / channel / command)
 * 2단계: 기능 라우팅 (knowledge / code / ops / general)
 * 3단계: 버짓 프로파일 선택 (LIGHT / STANDARD / DEEP)
 *
 * v3 리팩토링: routeEvent → classifyRequest, buildSessionKey 제거 (Gateway가 자체 생성).
 */

// ─── 기능 분류 키워드 ───
// NOTE: 대소문자 구분 없이 lower.includes() 비교 — 중복 방지 (PR/pr 등)
const CODE_KEYWORDS = ['코드', 'code', 'pr', 'merge', '리뷰', 'review', 'deploy', '배포',
  'git', 'branch', '커밋', 'commit', 'bug', '버그', 'refactor', '리팩토링'];
const OPS_KEYWORDS = ['인시던트', 'incident', '장애', '배포', 'deploy', '롤백', 'rollback',
  '모니터링', 'alert', '알림', 'task', '작업', '할당'];
const KNOWLEDGE_KEYWORDS = ['문서', 'doc', '위키', 'wiki', '온보딩', 'onboard', '검색', 'search',
  '어디', '뭐였', '기억', '정리', '결정', '컨벤션', '정책'];

/**
 * 채널 멘션 감지 — #채널명 또는 <#C...> 형태.
 */
function detectChannelMentions(text) {
  const mentions = [];
  const slackPattern = /<#(C[A-Z0-9]+)\|?([^>]*)>/g;
  let match;
  while ((match = slackPattern.exec(text)) !== null) {
    mentions.push({ id: match[1], name: match[2] });
  }
  return mentions;
}

/**
 * 기능 분류 (키워드 기반).
 * @returns {'knowledge' | 'code' | 'ops' | 'general'}
 */
function classifyFunction(text) {
  const lower = (text || '').toLowerCase();
  const codeScore = CODE_KEYWORDS.filter(k => lower.includes(k.toLowerCase())).length;
  const opsScore = OPS_KEYWORDS.filter(k => lower.includes(k.toLowerCase())).length;
  const knowledgeScore = KNOWLEDGE_KEYWORDS.filter(k => lower.includes(k.toLowerCase())).length;

  const maxScore = Math.max(codeScore, opsScore, knowledgeScore);
  if (maxScore === 0) return 'general';
  if (codeScore === maxScore) return 'code';
  if (opsScore === maxScore) return 'ops';
  return 'knowledge';
}

/**
 * 버짓 프로파일 결정.
 * @returns {'LIGHT' | 'STANDARD' | 'DEEP'}
 */
function selectBudgetProfile(eventType, functionType, channelMentions, isThreadFollowUp) {
  if (isThreadFollowUp) return 'LIGHT';
  if (eventType === 'command') return 'LIGHT';

  if (channelMentions.length > 0) return 'DEEP';
  if (functionType === 'code') return 'DEEP';

  if (eventType === 'dm' && functionType === 'general') return 'LIGHT';
  return 'STANDARD';
}

/**
 * 요청 분류 — 메인 함수.
 *
 * @returns {{ functionType, budgetProfile, channelMentions }}
 */
function classifyRequest(event, context = {}) {
  const text = event.text || '';
  const channelMentions = detectChannelMentions(text);
  const functionType = classifyFunction(text);
  const isThreadFollowUp = !!context.isThreadFollowUp;

  // 이벤트 타입 분류 (버짓 결정용)
  let eventType;
  if (context.isCommand) {
    eventType = 'command';
  } else if (context.isDM) {
    eventType = 'dm';
  } else if (context.isMention) {
    eventType = 'mention';
  } else {
    eventType = 'channel';
  }

  const budgetProfile = selectBudgetProfile(eventType, functionType, channelMentions, isThreadFollowUp);

  return {
    functionType,
    budgetProfile,
    channelMentions,
  };
}

module.exports = { classifyRequest, classifyFunction, selectBudgetProfile, detectChannelMentions };
