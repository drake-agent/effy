/**
 * engine.js — ReflectionEngine: 자기개선 루프의 핵심 엔진.
 *
 * 설계 도면 Layer 1 (OBSERVE) + Layer 3 (PROMOTE) + Layer 4 (APPLY) 차용.
 *
 * 통합 지점: Gateway Step ⑥.9 (교정 감지) + ⑨.7 (Lesson 주입)
 */
const { createLogger } = require('../shared/logger');
const { sanitizeForPrompt, escapeXml } = require('./sanitize');

const log = createLogger('reflection');

// ─── 교정 감지 키워드 (한/영) — 모듈 로드 시 1회 컴파일 ───
const CORRECTION_PATTERNS = [
  // 직접 교정
  { pattern: /아니[요]?\s*(그게|그건|그거)\s*(아니라|아닌데|아니고)/i, weight: 0.9, type: 'direct_correction' },
  { pattern: /이[건렇]게\s*(해야|하는\s*거|해줘야)/i, weight: 0.8, type: 'direct_correction' },
  { pattern: /또\s*(틀렸|잘못|실수)/i, weight: 1.0, type: 'repeated_mistake' },
  { pattern: /전에도\s*(말했|얘기했|알려줬)/i, weight: 1.0, type: 'repeated_mistake' },
  { pattern: /몇\s*번을?\s*(말해|얘기해)/i, weight: 1.0, type: 'repeated_mistake' },
  // 영어 교정
  { pattern: /no[,.]?\s*that'?s?\s*not\s*(right|correct|what)/i, weight: 0.9, type: 'direct_correction' },
  { pattern: /actually\s*(it\s*should|you\s*should|it'?s)/i, weight: 0.8, type: 'direct_correction' },
  { pattern: /i\s*told\s*you\s*(before|already|earlier)/i, weight: 1.0, type: 'repeated_mistake' },
  { pattern: /stop\s*(doing|saying|making)/i, weight: 0.9, type: 'direct_correction' },
  // 약한 신호
  { pattern: /다시\s*(해[줘봐]|한번)/i, weight: 0.5, type: 'retry_signal' },
  { pattern: /그게\s*아니[라고]/i, weight: 0.7, type: 'direct_correction' },
];

// ─── Outcome 신호 ───
const POSITIVE_SIGNALS = [
  { pattern: /고마워|감사|잘\s*했|완벽|좋[아았]|훌륭/i, weight: 0.7 },
  { pattern: /thanks|perfect|great|exactly|well\s*done|nice/i, weight: 0.7 },
  { pattern: /👍|🎉|✅|💯/i, weight: 0.5 },
];

const NEGATIVE_SIGNALS = [
  { pattern: /아닌데|틀렸|다르[게잖]|잘못/i, weight: 0.6 },
  { pattern: /wrong|incorrect|not\s*what\s*i/i, weight: 0.6 },
  { pattern: /👎|❌|😤/i, weight: 0.4 },
];

// ─── 상수 ───
const MAX_SESSIONS = 500;           // BUG-1 fix: 세션 트래커 전역 상한
const MAX_MESSAGE_SLICE = 500;       // 저장 시 메시지 최대 길이
const DEFAULT_CORRECTION_TTL = 60 * 60 * 1000; // 1시간

class ReflectionEngine {
  constructor({ semantic, episodic, entity, runLogger, config: reflectionConfig = {} }) {
    this.semantic = semantic;
    this.correctionThreshold = reflectionConfig.correctionThreshold ?? 0.6;
    this.promotionPool = reflectionConfig.lessonPool ?? 'reflection';
    this.maxLessonsPerSession = reflectionConfig.maxLessonsPerSession ?? 5;
    this.repeatThresholdForGlobal = reflectionConfig.repeatThresholdForGlobal ?? 3;

    // BUG-1 fix: 세션별 교정 카운터 + 전역 상한
    this._sessionCorrections = new Map();
    this._correctionTTL = DEFAULT_CORRECTION_TTL;
  }

  // ═══════════════════════════════════════════════════════
  // OBSERVE: 교정 감지
  // ═══════════════════════════════════════════════════════

  /**
   * 사용자 메시지에서 교정 패턴을 감지.
   * WARN-1 fix: 메시지 1500자 초과 시 앞부분만 검사 (성능).
   */
  detectCorrection(userMessage, sessionKey, context) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { detected: false, corrections: [], score: 0 };
    }

    // WARN-1 fix: 긴 메시지는 앞부분만 검사 (교정은 보통 문두)
    const searchText = userMessage.slice(0, 1500);
    const matches = [];
    let totalScore = 0;

    for (const { pattern, weight, type } of CORRECTION_PATTERNS) {
      const match = searchText.match(pattern);
      if (match) {
        matches.push({ type, matched: match[0], weight });
        totalScore += weight;
      }
    }

    const detected = totalScore >= this.correctionThreshold;

    if (detected) {
      log.info(`Correction detected (score=${totalScore.toFixed(2)}): "${userMessage.slice(0, 80)}"`);
      this._trackSessionCorrection(sessionKey, {
        userMessage: userMessage.slice(0, MAX_MESSAGE_SLICE),
        previousResponse: context.previousAgentResponse?.slice(0, MAX_MESSAGE_SLICE) || '',
        matches,
        totalScore,
        agentId: context.agentId,
        userId: context.userId,
        channelId: context.channelId,
        timestamp: Date.now(),
      });
    }

    return { detected, corrections: matches, score: totalScore };
  }

  /** @private BUG-1 fix: 전역 상한 + LRU eviction */
  _trackSessionCorrection(sessionKey, correction) {
    // 전역 상한 초과 시 가장 오래된 세션 제거 (LRU)
    if (this._sessionCorrections.size >= MAX_SESSIONS && !this._sessionCorrections.has(sessionKey)) {
      const oldestKey = this._sessionCorrections.keys().next().value;
      const oldBucket = this._sessionCorrections.get(oldestKey);
      if (oldBucket?.timer) clearTimeout(oldBucket.timer);
      this._sessionCorrections.delete(oldestKey);
    }

    let bucket = this._sessionCorrections.get(sessionKey);
    if (!bucket) {
      bucket = { corrections: [], timer: null };
      this._sessionCorrections.set(sessionKey, bucket);
    }

    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => this._sessionCorrections.delete(sessionKey), this._correctionTTL);

    bucket.corrections.push(correction);

    // 세션별 상한
    const cap = this.maxLessonsPerSession * 2;
    if (bucket.corrections.length > cap) {
      bucket.corrections.splice(0, bucket.corrections.length - cap);
    }
  }

  // ═══════════════════════════════════════════════════════
  // PROMOTE: 교정 → Lesson 승격
  // ═══════════════════════════════════════════════════════

  /**
   * 감지된 교정을 L3 Lesson으로 승격.
   * SEC-3 fix: sanitizeForPrompt로 사용자 원문 정화.
   */
  promoteCorrection(sessionKey, correctedResponse, context) {
    const bucket = this._sessionCorrections.get(sessionKey);
    if (!bucket || bucket.corrections.length === 0) {
      return { promoted: false };
    }

    const lastCorrection = bucket.corrections[bucket.corrections.length - 1];

    // SEC-3 fix: 사용자 원문을 새니타이즈하여 프롬프트 인젝션 방지
    const safeUserMsg = sanitizeForPrompt(lastCorrection.userMessage, 200);
    const safePrevResp = sanitizeForPrompt(lastCorrection.previousResponse, 200);
    const safeCorrected = sanitizeForPrompt(correctedResponse, 200);

    const lessonContent = [
      `[Lesson] Agent: ${lastCorrection.agentId}`,
      `잘못된 응답: ${safePrevResp}`,
      `사용자 교정: ${safeUserMsg}`,
      `올바른 방향: ${safeCorrected}`,
      `교정 유형: ${lastCorrection.matches.map(m => m.type).join(', ')}`,
    ].join('\n');

    try {
      const hash = this.semantic.save({
        content: lessonContent,
        sourceType: 'correction',
        channelId: context.channelId,
        userId: context.userId,
        tags: ['lesson', lastCorrection.agentId, ...lastCorrection.matches.map(m => m.type)],
        promotionReason: `교정 감지 (score=${lastCorrection.totalScore.toFixed(1)})`,
        poolId: this.promotionPool,
        memoryType: 'Observation',
      });

      log.info(`Lesson promoted: ${hash} (agent=${lastCorrection.agentId})`);
      this._checkRepeatPattern(lastCorrection, context);
      return { promoted: true, lessonId: hash };
    } catch (err) {
      log.error(`Lesson promotion failed: ${err.message}`);
      return { promoted: false };
    }
  }

  /** @private Global Lesson 승격 체크 */
  _checkRepeatPattern(correction, context) {
    try {
      const existingLessons = this.semantic.searchWithPools(
        `[Lesson] Agent: ${correction.agentId}`,
        [this.promotionPool],
        20,
        { memoryType: 'Observation' }
      );

      const correctionTypes = correction.matches.map(m => m.type);
      let repeatCount = 0;
      for (const lesson of existingLessons) {
        if (correctionTypes.some(t => lesson.content.includes(t))) {
          repeatCount++;
        }
      }

      if (repeatCount >= this.repeatThresholdForGlobal) {
        const safeMsg = sanitizeForPrompt(correction.userMessage, 200);
        this.semantic.save({
          content: [
            `[Global Lesson] Agent: ${correction.agentId}`,
            `반복 교정 횟수: ${repeatCount}`,
            `교정 유형: ${correctionTypes.join(', ')}`,
            `최근 사례: ${safeMsg}`,
            `규칙: 이 유형의 실수를 반복하지 말 것`,
          ].join('\n'),
          sourceType: 'global_lesson',
          channelId: context.channelId,
          userId: context.userId,
          tags: ['global_lesson', correction.agentId],
          promotionReason: `반복 교정 ${repeatCount}회 → Global 승격`,
          poolId: 'team',
          memoryType: 'Observation',
        });
        log.warn(`Global Lesson created: agent=${correction.agentId}, repeats=${repeatCount}`);
      }
    } catch (err) {
      log.warn(`Repeat pattern check failed: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // OBSERVE: Outcome 감지
  // ═══════════════════════════════════════════════════════

  /**
   * 사용자 후속 메시지에서 긍정/부정 신호 감지.
   * INFO-3 fix: net score 기반 판정 (양쪽 모두 threshold 이상일 때 차이로 결정).
   */
  detectOutcome(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { sentiment: 'neutral', score: 0 };
    }

    let positiveScore = 0;
    let negativeScore = 0;

    for (const { pattern, weight } of POSITIVE_SIGNALS) {
      if (pattern.test(userMessage)) positiveScore += weight;
    }
    for (const { pattern, weight } of NEGATIVE_SIGNALS) {
      if (pattern.test(userMessage)) negativeScore += weight;
    }

    // INFO-3 fix: net score 기반 — 양쪽 겹칠 때 차이로 판정
    const netScore = positiveScore - negativeScore;
    if (netScore > 0 && positiveScore >= 0.5) {
      return { sentiment: 'positive', score: positiveScore };
    }
    if (netScore < 0 && negativeScore >= 0.4) {
      return { sentiment: 'negative', score: negativeScore };
    }
    return { sentiment: 'neutral', score: 0 };
  }

  // ═══════════════════════════════════════════════════════
  // APPLY: Lesson → system prompt 주입
  // ═══════════════════════════════════════════════════════

  /**
   * SEC-3 fix: 모든 lesson 콘텐츠를 escapeXml 처리.
   * INFO-1 fix: 최신순 정렬 (Global 우선 제거 → recency 기반).
   * INFO-2 fix: content hash로 중복 제거.
   */
  getLessonPrompt(agentId, limit = 5) {
    try {
      // SLIM: Search for both correction lessons and delegation lessons
      const lessons = this.semantic.searchWithPools(
        `[Lesson] Agent: ${agentId}`,
        [this.promotionPool, 'team'],
        limit * 3, // 여유분 (correction + delegation + 중복 제거)
        { memoryType: 'Observation' }
      );

      if (lessons.length === 0) return '';

      // INFO-2 fix: content hash로 중복 제거
      const seen = new Set();
      const unique = [];
      for (const l of lessons) {
        const key = (l.content || '').slice(0, 100);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(l);
      }

      // INFO-1 fix: Global → Delegation → Local 우선순위
      // ARCH-SLIM-4: Slice limits proportional to requested limit (not hardcoded)
      const globals = unique.filter(l => l.content.includes('[Global Lesson]'));
      const delegations = unique.filter(l => l.content.includes('[Delegation Lesson]'));
      const locals = unique.filter(l => !l.content.includes('[Global Lesson]') && !l.content.includes('[Delegation Lesson]'));
      const maxPerCategory = Math.max(1, Math.ceil(limit * 0.4));
      const sorted = [...globals.slice(0, maxPerCategory), ...delegations.slice(0, maxPerCategory), ...locals].slice(0, limit);

      const items = sorted.map(l => {
        const lines = l.content.split('\n');
        // SLIM: Handle both correction lessons and delegation lessons
        const isDelegation = l.content.includes('[Delegation Lesson]');
        if (isDelegation) {
          // Delegation lesson: content is the lesson itself (after the header line)
          const body = lines.filter(ln => !ln.startsWith('[Delegation Lesson]')).join(' ').trim();
          return `  <lesson type="delegation">${escapeXml(body)}</lesson>`;
        }
        const correction = lines.find(ln => ln.startsWith('사용자 교정:')) || '';
        const direction = lines.find(ln => ln.startsWith('올바른 방향:')) || '';
        const rule = lines.find(ln => ln.startsWith('규칙:')) || '';
        // SEC-3 fix: escapeXml으로 XML 마커 무력화
        const text = escapeXml(rule || correction) + (direction ? ' → ' + escapeXml(direction) : '');
        return `  <lesson>${text}</lesson>`;
      });

      return `<learned_lessons agent="${escapeXml(agentId)}">\n${items.join('\n')}\n</learned_lessons>`;
    } catch (err) {
      log.warn(`getLessonPrompt failed: ${err.message}`);
      return '';
    }
  }

  // ═══════════════════════════════════════════════════════
  // 정리
  // ═══════════════════════════════════════════════════════

  destroy() {
    const count = this._sessionCorrections.size;
    for (const [, bucket] of this._sessionCorrections) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    this._sessionCorrections.clear();
    log.info(`ReflectionEngine destroyed (cleared ${count} session buckets)`);
  }
}

module.exports = { ReflectionEngine, CORRECTION_PATTERNS, POSITIVE_SIGNALS, NEGATIVE_SIGNALS };
