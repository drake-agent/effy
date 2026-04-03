/**
 * thread-summarizer.js — 스레드/논의 자동 요약.
 *
 * Observer가 긴 스레드(N개 이상 메시지)를 감지하면,
 * 스레드 끝에 자동으로 요약 + 결정사항 + 액션 아이템을 답글로 게시.
 *
 * 트리거 조건:
 * - 스레드 메시지 수 >= threshold (기본 10)
 * - 마지막 메시지 후 idle 시간 >= cooldown (기본 30분)
 * - 아직 요약 안 된 스레드
 *
 * 모델 사용: Haiku (tier1) — 요약은 저비용으로.
 */
const { createLogger } = require('../shared/logger');
const { config } = require('../config');

const log = createLogger('features:thread-summarizer');

// 이미 요약한 스레드 추적
const summarizedThreads = new Set();
const SUMMARIZED_THREADS_MAX = 5000;

/**
 * 스레드가 요약 대상인지 판단.
 *
 * @param {Array} messages - 스레드 메시지 배열
 * @param {string} threadTs - 스레드 타임스탬프
 * @param {object} opts - { threshold, cooldownMs }
 * @returns {boolean}
 */
function shouldSummarize(messages, threadTs, opts = {}) {
  const threshold = opts.threshold ?? 10;
  const cooldownMs = opts.cooldownMs ?? 30 * 60 * 1000;  // 30분

  if (!messages || messages.length < threshold) return false;
  if (summarizedThreads.has(threadTs)) return false;

  // 마지막 메시지 이후 충분한 시간이 지났는지
  const lastMsg = messages[messages.length - 1];
  const lastTs = parseFloat(lastMsg.ts || '0') * 1000;
  if (Date.now() - lastTs < cooldownMs) return false;

  return true;
}

/**
 * 스레드 요약 텍스트 생성 (LLM 사용).
 *
 * @param {Array} messages - [{ user, text, ts }]
 * @param {object} llmClient - createMessage 함수
 * @returns {string} 요약 텍스트
 */
async function generateSummary(messages, llmClient) {
  if (!llmClient || !messages?.length) return null;

  const conversation = messages
    .filter(m => m.text && !m.bot_id)
    .map(m => `${m.user || 'unknown'}: ${m.text.slice(0, 200)}`)
    .join('\n');

  if (conversation.length < 50) return null;

  try {
    const response = await llmClient({
      model: config.anthropic?.models?.tier1?.id || 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: [
        '당신은 Slack 스레드 요약 전문가입니다.',
        '아래 대화를 읽고 다음 형식으로 요약하세요:',
        '',
        '**📝 논의 요약**: (2-3문장)',
        '**✅ 결정사항**: (있으면 bullet point)',
        '**📋 액션 아이템**: (있으면 bullet point, 담당자 포함)',
        '',
        '한국어로 작성. 간결하게.',
      ].join('\n'),
      messages: [{ role: 'user', content: conversation.slice(0, 3000) }],
    });

    const text = response.content?.find(b => b.type === 'text')?.text;
    return text || null;
  } catch (err) {
    log.warn('Thread summary generation failed', { error: err.message });
    return null;
  }
}

/**
 * 스레드 요약을 Slack에 게시.
 *
 * @param {string} channelId
 * @param {string} threadTs
 * @param {string} summaryText
 * @param {object} slackClient
 */
async function postSummary(channelId, threadTs, summaryText, slackClient) {
  if (!slackClient || !summaryText) return;

  try {
    await slackClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `🤖 *스레드 요약*\n\n${summaryText}`,
      unfurl_links: false,
    });
    if (summarizedThreads.size >= SUMMARIZED_THREADS_MAX) {
      summarizedThreads.clear();
    }
    summarizedThreads.add(threadTs);
    log.info('Thread summary posted', { channel: channelId, thread: threadTs });
  } catch (err) {
    log.warn('Thread summary post failed', { error: err.message });
  }
}

const HELP_ENTRY = {
  icon: '📝',
  title: '자동 요약',
  lines: [
    '긴 스레드, 다 읽기 힘들죠?',
    '10개 이상 쌓인 대화는 자동으로 핵심만 요약해드립니다.',
  ],
  order: 30,
};

module.exports = {
  shouldSummarize,
  generateSummary,
  postSummary,
  summarizedThreads,
  HELP_ENTRY,
};
