/**
 * sop-detector.js — SOP (Standard Operating Procedure) 자동 감지.
 *
 * Observer의 PatternDetector 확장 — 반복되는 업무 패턴을 감지하고
 * "이걸 자동화할까요?" 제안.
 *
 * 감지 대상:
 * - 매주 같은 요일에 반복되는 질문/작업
 * - 같은 사용자가 같은 순서로 도구를 호출하는 패턴
 * - 인시던트 후 항상 같은 절차가 실행되는 패턴
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('features:sop-detector');

class SOPDetector {
  constructor(opts = {}) {
    this.insightStore = opts.insightStore || null;
    // 질문 빈도 추적: keyword → [{ date, channel, userId }]
    this.questionHistory = new Map();
    // 도구 호출 시퀀스: userId → [{ tools: [...], date }]
    this.toolSequences = new Map();
    // SOP 후보: { pattern, frequency, lastSeen, suggestedWorkflow }
    this.candidates = new Map();

    this.minFrequency = opts.minFrequency || 3;  // 최소 3회 반복
  }

  /**
   * Observer insight에서 반복 패턴 감지.
   * PatternDetector.analyze() 후에 호출.
   *
   * @param {string} channelId
   * @param {Array} messages
   */
  analyzeForSOP(channelId, messages) {
    // 질문 키워드 추출 + 빈도 추적
    for (const msg of messages) {
      if (!msg.text || msg.text.length < 20) continue;

      // 질문인지 확인
      if (/\?|어떻게|방법|how|what/i.test(msg.text)) {
        const key = this._extractQuestionKey(msg.text);
        if (!key) continue;

        if (!this.questionHistory.has(key)) this.questionHistory.set(key, []);
        this.questionHistory.get(key).push({
          date: new Date().toISOString().slice(0, 10),
          channel: channelId,
          userId: msg.userId,
        });

        // 빈도 체크
        const history = this.questionHistory.get(key);
        if (history.length >= this.minFrequency) {
          this._createSOPCandidate('recurring_question', key, history);
        }
      }
    }

    // 오래된 기록 정리 (30일 이상)
    this._cleanup();
  }

  /**
   * 도구 호출 시퀀스 기록 (runtime.js에서 호출).
   *
   * @param {string} userId
   * @param {string} toolName
   */
  recordToolCall(userId, toolName) {
    if (!this.toolSequences.has(userId)) this.toolSequences.set(userId, []);
    const seq = this.toolSequences.get(userId);
    seq.push({ tool: toolName, date: Date.now() });

    // 최근 10개만 유지
    if (seq.length > 10) seq.splice(0, seq.length - 10);

    // 시퀀스 패턴 감지 (3개 이상 도구가 같은 순서로 2회 이상)
    this._detectToolSequencePattern(userId, seq);
  }

  /**
   * SOP 후보 목록.
   */
  getCandidates() {
    return [...this.candidates.values()];
  }

  /**
   * SOP 후보 → Insight 생성 (ProactiveEngine에서 제안).
   */
  generateInsights() {
    if (!this.insightStore) return [];

    const insights = [];
    for (const [key, candidate] of this.candidates) {
      if (candidate.suggested) continue;  // 이미 제안됨

      insights.push(this.insightStore.add({
        type: 'sop',
        channel: candidate.channel || '',
        content: candidate.description,
        confidence: Math.min(0.5 + candidate.frequency * 0.1, 0.95),
        actionable: true,
        suggestedAction: 'create_workflow',
        metadata: { sopKey: key, pattern: candidate.pattern, frequency: candidate.frequency },
      }));

      candidate.suggested = true;
    }

    return insights;
  }

  // ─── Internal ────────────────────────────────

  _extractQuestionKey(text) {
    // 핵심 명사/동사 3개를 키로 추출
    const words = text.match(/[a-zA-Z가-힣]{3,}/g) || [];
    const stopwords = new Set(['the', 'and', 'how', 'what', 'this', '어떻게', '방법', '하는']);
    const filtered = words.filter(w => !stopwords.has(w.toLowerCase())).slice(0, 3);
    return filtered.length >= 2 ? filtered.join(':').toLowerCase() : null;
  }

  _createSOPCandidate(pattern, key, history) {
    if (this.candidates.has(key)) {
      this.candidates.get(key).frequency = history.length;
      this.candidates.get(key).lastSeen = Date.now();
      return;
    }

    this.candidates.set(key, {
      pattern,
      description: `반복 질문 감지: "${key.replace(/:/g, ' ')}" (${history.length}회, ${new Set(history.map(h => h.channel)).size}개 채널)`,
      frequency: history.length,
      channel: history[history.length - 1]?.channel || '',
      lastSeen: Date.now(),
      suggested: false,
    });

    log.info('SOP candidate detected', { key, frequency: history.length });
  }

  _detectToolSequencePattern(userId, seq) {
    if (seq.length < 6) return;  // 최소 6개 (패턴 3 × 2회)

    const tools = seq.map(s => s.tool);
    // 3-tool 시퀀스 패턴 검색
    for (let len = 3; len <= 5; len++) {
      for (let i = 0; i <= tools.length - len * 2; i++) {
        const pattern = tools.slice(i, i + len).join('→');
        const remaining = tools.slice(i + len);
        const second = remaining.slice(0, len).join('→');
        if (pattern === second) {
          const key = `toolseq:${pattern}`;
          if (!this.candidates.has(key)) {
            this.candidates.set(key, {
              pattern: 'tool_sequence',
              description: `반복 도구 시퀀스 감지: ${pattern} (사용자: ${userId})`,
              frequency: 2,
              lastSeen: Date.now(),
              suggested: false,
            });
            log.info('Tool sequence SOP detected', { userId, pattern });
          }
          break;
        }
      }
    }
  }

  _cleanup() {
    const cutoff = Date.now() - 30 * 86400000;  // 30일
    for (const [key, history] of this.questionHistory) {
      const filtered = history.filter(h => new Date(h.date).getTime() > cutoff);
      if (filtered.length === 0) this.questionHistory.delete(key);
      else this.questionHistory.set(key, filtered);
    }
  }
}

module.exports = { SOPDetector };
