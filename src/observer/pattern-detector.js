/**
 * pattern-detector.js — Layer 1: Pattern Detection Engine.
 *
 * 관찰된 대화에서 5가지 패턴을 감지하여 Insight 생성:
 * ① Decision Detector — 의사결정 합의 감지
 * ② Question Detector — 미답변 질문 감지
 * ③ Topic Tracker — 채널별 현재 토픽 추출
 * ④ Cross-channel Pattern — 동일 이슈 다중 채널 감지
 * ⑤ Knowledge Gap — 반복 질문 / 답변 부재 감지
 *
 * 모델 사용: 없음 (규칙 기반). 향후 Haiku 기반 분류기로 업그레이드 가능.
 * 비용: $0 (순수 패턴 매칭)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:detector');

// ─── 한/영 패턴 정의 ────────────────────────────────

const DECISION_PATTERNS = [
  /결정|확정|합의|하기로\s*했|채택|승인|결론은|가기로/i,
  /decided|confirmed|agreed|finalized|approved|let'?s\s*go\s*with/i,
];

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /어떻게\s*(해|하[나면]|할까)|방법\s*(아는|있[나을])|누가\s*아/i,
  /how\s*(do|can|to)|anyone\s*know|does\s*anyone/i,
];

const AGREEMENT_PATTERNS = [
  /동의|ㅇㅇ|찬성|좋[아았]|맞[아다]|ㅋㅋ|ㄱㄱ/i,
  /agree|lgtm|\+1|sounds\s*good|yep|yes|right/i,
];

const URGENCY_PATTERNS = [
  /급한|긴급|빨리|장애|에러|오류|죽[었]|터[졌]|실패/i,
  /urgent|critical|broken|down|failed|error|crash|outage/i,
];

class PatternDetector {
  /**
   * @param {object} opts
   * @param {object} opts.insightStore - InsightStore 인스턴스
   * @param {object} opts.config - observer.detection config
   */
  constructor(opts = {}) {
    this.insightStore = opts.insightStore || null;
    this.feedback = opts.feedback || null;  // R4-BUG-6: 비활성화 패턴 체크
    this.config = opts.config || {};
    this.maxDailyAnalyses = this.config.maxDailyAnalyses || 200;

    // 크로스채널 토픽 추적 (R4-BUG-5: 최대 100 채널로 제한)
    this.channelTopics = new Map();
    this.maxTrackedChannels = 100;

    // 일별 분석 카운터
    this.dailyCount = 0;
    this.dailyResetDate = new Date().toISOString().slice(0, 10);

    // 통계
    this.stats = { analyses: 0, decisions: 0, questions: 0, patterns: 0 };
  }

  /**
   * 메시지 배치 분석 (PassiveListener에서 호출).
   *
   * @param {string} channelId
   * @param {Array} messages - [{ userId, text, ts, threadTs }]
   * @returns {Array} 생성된 insight 목록
   */
  analyze(channelId, messages) {
    // 일별 상한 체크
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailyCount = 0;
      this.dailyResetDate = today;
    }
    if (this.dailyCount >= this.maxDailyAnalyses) return [];
    this.dailyCount++;
    this.stats.analyses++;

    const insights = [];
    const texts = messages.map(m => m.text);
    const combined = texts.join(' ');

    // R4-BUG-6: 비활성화된 패턴 스킵
    const fb = this.feedback;

    // ① Decision Detector
    if (!fb?.isPatternDisabled(channelId, 'decision')) {
      const decisionInsight = this._detectDecision(channelId, messages);
      if (decisionInsight) insights.push(decisionInsight);
    }

    // ② Question Detector
    if (!fb?.isPatternDisabled(channelId, 'question')) {
      const questionInsights = this._detectQuestions(channelId, messages);
      insights.push(...questionInsights);
    }

    // ③ Topic Tracker
    this._updateTopics(channelId, combined);

    // ④ Cross-channel Pattern
    const crossInsight = this._detectCrossChannel(channelId);
    if (crossInsight) insights.push(crossInsight);

    // InsightStore에 저장
    if (this.insightStore) {
      for (const insight of insights) {
        this.insightStore.add(insight);
      }
    }

    return insights;
  }

  /**
   * ① 의사결정 감지.
   * 조건: DECISION 패턴 매치 + 2명 이상 AGREEMENT 패턴
   */
  _detectDecision(channelId, messages) {
    let decisionMsg = null;
    let agreedUsers = new Set();

    for (const msg of messages) {
      if (DECISION_PATTERNS.some(p => p.test(msg.text))) {
        decisionMsg = msg;
      }
      if (AGREEMENT_PATTERNS.some(p => p.test(msg.text))) {
        agreedUsers.add(msg.userId);
      }
    }

    if (decisionMsg && agreedUsers.size >= 2) {
      this.stats.decisions++;
      return {
        type: 'decision',
        channel: channelId,
        content: decisionMsg.text.slice(0, 300),
        confidence: Math.min(0.6 + agreedUsers.size * 0.1, 0.95),
        evidence: [decisionMsg.ts],
        participants: [...agreedUsers],
        actionable: true,
        suggestedAction: 'save_to_l3',
      };
    }
    return null;
  }

  /**
   * ② 미답변 질문 감지.
   * 조건: QUESTION 패턴 매치 + 이후 5개 메시지에 응답 없음 (같은 thread)
   */
  _detectQuestions(channelId, messages) {
    const insights = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!QUESTION_PATTERNS.some(p => p.test(msg.text))) continue;

      // 질문 이후 메시지에서 응답 확인
      const followups = messages.slice(i + 1, i + 6);
      const hasReply = followups.some(f =>
        f.userId !== msg.userId &&
        (f.threadTs === msg.ts || !f.threadTs)  // 같은 스레드이거나 메인 채널
      );

      if (!hasReply && i < messages.length - 3) {  // 최소 3개 이후 메시지 존재
        this.stats.questions++;
        insights.push({
          type: 'question',
          channel: channelId,
          content: msg.text.slice(0, 300),
          confidence: 0.7,
          evidence: [msg.ts],
          askedBy: msg.userId,
          actionable: true,
          suggestedAction: 'proactive_reply',
        });
      }
    }

    return insights;
  }

  /**
   * ③ 토픽 추적 — 키워드 추출 + 채널별 저장.
   */
  _updateTopics(channelId, combinedText) {
    // 간단한 키워드 추출 (2자 이상 영문/한글 단어)
    const words = combinedText.match(/[a-zA-Z가-힣]{2,20}/g) || [];
    const stopwords = new Set(['the', 'and', 'for', 'this', 'that', 'with', '이거', '그래', '거기', '여기', '지금', '오늘']);
    const keywords = new Set(
      words.filter(w => !stopwords.has(w.toLowerCase()) && w.length > 2)
        .map(w => w.toLowerCase())
    );

    this.channelTopics.set(channelId, { keywords, lastUpdated: Date.now() });

    // R4-BUG-5: LRU eviction — 오래된 채널부터 제거
    if (this.channelTopics.size > this.maxTrackedChannels) {
      let oldest = null, oldestTime = Infinity;
      for (const [ch, data] of this.channelTopics) {
        if (data.lastUpdated < oldestTime) { oldest = ch; oldestTime = data.lastUpdated; }
      }
      if (oldest) this.channelTopics.delete(oldest);
    }
  }

  /**
   * ④ 크로스채널 패턴 — 2개 이상 채널에서 같은 토픽 감지.
   */
  _detectCrossChannel(channelId) {
    const myTopics = this.channelTopics.get(channelId);
    if (!myTopics || myTopics.keywords.size < 3) return null;

    for (const [otherCh, otherTopics] of this.channelTopics) {
      if (otherCh === channelId) continue;
      if (Date.now() - otherTopics.lastUpdated > 30 * 60 * 1000) continue;  // 30분 이내만

      // 교집합
      const overlap = [...myTopics.keywords].filter(k => otherTopics.keywords.has(k));
      if (overlap.length >= 3) {
        this.stats.patterns++;
        return {
          type: 'pattern',
          channel: channelId,
          relatedChannel: otherCh,
          content: `동일 토픽이 두 채널에서 논의 중: ${overlap.slice(0, 5).join(', ')}`,
          confidence: Math.min(0.5 + overlap.length * 0.1, 0.9),
          evidence: [],
          actionable: true,
          suggestedAction: 'cross_channel_link',
        };
      }
    }
    return null;
  }

  /**
   * 통계 조회.
   */
  getStats() {
    return {
      ...this.stats,
      dailyRemaining: Math.max(0, this.maxDailyAnalyses - this.dailyCount),
      trackedChannels: this.channelTopics.size,
    };
  }
}

module.exports = { PatternDetector };
