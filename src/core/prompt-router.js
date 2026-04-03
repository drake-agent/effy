const { createLogger } = require('../shared/logger');
const log = createLogger('core:prompt-router');

/**
 * 다차원 프롬프트 복잡도 분석기
 * Enhanced Prompt Complexity Routing — 6-8 Dimensions
 *
 * 기존 prompt-scorer.js의 키워드 기반을 확장하여
 * 6-8차원 분석으로 프롬프트 복잡도를 다중 관점에서 평가.
 * 다차원 프롬프트 복잡도 분석 기반.
 */
class PromptRouter {
  /**
   * @param {Object} opts - 설정 옵션
   * @param {boolean} [opts.enabled=true] - 라우터 활성화
   * @param {Object} [opts.tierMap] - 모델 티어 매핑
   * @param {Object} [opts.boundaries] - 복잡도 경계값
   * @param {Object} [opts.weights] - 차원별 가중치
   */
  constructor(opts = {}) {
    this.enabled = opts.enabled ?? true;

    // 모델 티어 매핑
    this.tierMap = opts.tierMap ?? {
      light: 'claude-haiku',
      standard: 'claude-sonnet',
      heavy: 'claude-opus',
    };

    // 복잡도 경계값
    this.boundaries = opts.boundaries ?? {
      lightMax: 3,
      heavyMin: 7,
    };

    // 차원별 가중치 (6-8차원)
    this.weights = opts.weights ?? {
      tokenCount: 1.0, // 1차원: 토큰 수
      codePresence: 2.0, // 2차원: 코드 존재
      reasoningMarkers: 1.5, // 3차원: 추론 마커
      technicalTerms: 1.0, // 4차원: 기술 용어
      simpleIndicators: -1.5, // 음수 = 복잡도 감소
      multiStepPatterns: 2.0, // 5차원: 다단계 패턴
      constraintComplexity: 1.5, // 6차원: 제약 조건
      languageMixing: 0.5, // 7차원: 언어 혼합
    };

    log.info('prompt-router initialized', { tiersEnabled: Object.keys(this.tierMap) });
  }

  /**
   * 메시지 복잡도 분석 (6-8차원)
   * @param {string} message - 분석할 메시지
   * @returns {{ tier: 'light'|'standard'|'heavy', score: number, dimensions: Object, model: string }}
   */
  analyze(message) {
    if (!this.enabled) {
      return {
        tier: 'standard',
        score: 5,
        dimensions: {},
        model: this.tierMap.standard,
      };
    }

    if (!message || typeof message !== 'string') {
      log.warn('invalid message type for analysis');
      return { tier: 'standard', score: 0, dimensions: {}, model: this.tierMap.standard };
    }

    // 각 차원별 점수 계산
    const dimensions = {
      tokenCount: this._scoreTokenCount(message),
      codePresence: this._scoreCodePresence(message),
      reasoningMarkers: this._scoreReasoningMarkers(message),
      technicalTerms: this._scoreTechnicalTerms(message),
      simpleIndicators: this._scoreSimpleIndicators(message),
      multiStepPatterns: this._scoreMultiStepPatterns(message),
      constraintComplexity: this._scoreConstraintComplexity(message),
      languageMixing: this._scoreLanguageMixing(message),
    };

    // 가중치 적용한 최종 점수 계산
    let totalScore = 0;
    for (const [dimension, value] of Object.entries(dimensions)) {
      const weight = this.weights[dimension] ?? 1.0;
      totalScore += value * weight;
    }

    // 정규화 (0-10 범위)
    const normalizedScore = Math.max(0, Math.min(10, totalScore / 10));

    // 티어 결정
    let tier = 'standard';
    if (normalizedScore <= this.boundaries.lightMax) {
      tier = 'light';
    } else if (normalizedScore >= this.boundaries.heavyMin) {
      tier = 'heavy';
    }

    const result = {
      tier,
      score: Math.round(normalizedScore * 100) / 100,
      dimensions,
      model: this.tierMap[tier],
    };

    log.debug('analysis complete', {
      score: result.score,
      tier,
      dimensions: Object.keys(dimensions),
    });

    return result;
  }

  /**
   * 토큰 수 추정 (words * 1.3)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreTokenCount(msg) {
    const wordCount = msg.split(/\s+/).length;
    const estimatedTokens = wordCount * 1.3;

    // 로그스케일 점수 (100 토큰당 1점)
    return Math.log(Math.max(1, estimatedTokens / 100 + 1)) * 2;
  }

  /**
   * 코드 존재 여부 (코드블록, 함수명, 변수 패턴)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreCodePresence(msg) {
    let score = 0;

    // 코드블록 (```, ~~~)
    const codeBlockCount = (msg.match(/```|~~~|\{\{/g) || []).length / 2;
    score += codeBlockCount * 2;

    // 함수명 패턴 (camelCase, snake_case, CONST_NAME)
    const functionPattern = /[a-z][a-zA-Z0-9]*\(|[a-z_][a-z0-9_]*|[A-Z][A-Z0-9_]+/g;
    const funcMatches = (msg.match(functionPattern) || []).length;
    score += funcMatches * 0.1;

    // 언어 키워드 (function, class, const, def, import 등)
    const langKeywords = /\b(function|class|const|let|var|def|import|export|return|async|await|try|catch)\b/gi;
    const keywordMatches = (msg.match(langKeywords) || []).length;
    score += keywordMatches * 0.5;

    return Math.min(10, score);
  }

  /**
   * 추론 마커 (because, therefore, however, compare, analyze 등)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreReasoningMarkers(msg) {
    const reasoningWords = /\b(because|therefore|however|compare|analyze|evaluate|contrast|explain|discuss|reason|logic|argument|conclusion|implication|while|although|versus|alternative|approach)\b/gi;
    const matches = (msg.match(reasoningWords) || []).length;

    // 한글 추론 마커
    const koreanReasoning = /(왜냐하면|따라서|그러나|비교|분석|평가|대비|설명|논의|논리|결론|시사점|한편|비록|그럼에도|대안|접근)/g;
    const korMatches = (msg.match(koreanReasoning) || []).length;

    return Math.min(10, (matches + korMatches) * 0.5);
  }

  /**
   * 기술 용어 밀도
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreTechnicalTerms(msg) {
    const technicalTerms = /\b(algorithm|database|api|framework|library|architecture|protocol|encryption|optimization|concurrency|latency|throughput|scalability|distributed|microservice|containerization|orchestration|middleware|cache|queue|stream|batch|async|sync)\b/gi;
    const matches = (msg.match(technicalTerms) || []).length;
    const wordCount = msg.split(/\s+/).length;
    const density = wordCount > 0 ? matches / wordCount : 0;

    return Math.min(10, density * 50);
  }

  /**
   * 단순 지표 (인사, 감사, yes/no — 복잡도 감소)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreSimpleIndicators(msg) {
    const simpleWords = /\b(hello|hi|thanks|thank|yes|no|ok|okay|sure|great|good|bad|fine|please|sorry)\b/gi;
    const matches = (msg.match(simpleWords) || []).length;

    // 단순 한글 표현
    const koreanSimple = /(안녕|감사|고마워|네|아니|좋아|괜찮아|괜찮습니다)/g;
    const korMatches = (msg.match(koreanSimple) || []).length;

    return Math.max(-10, -(matches + korMatches) * 0.3);
  }

  /**
   * 다단계 패턴 (first...then, step 1...step 2, 1)...2)...)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreMultiStepPatterns(msg) {
    let score = 0;

    // 번호 매김 (1. 2. 3. / 1) 2) 3) / (1) (2) (3))
    const numberedPattern = /(?:^|\n)\s*(?:\d+[\.\)]\s*|\(\d+\)\s*)/gm;
    const numberedMatches = (msg.match(numberedPattern) || []).length;
    score += numberedMatches * 0.5;

    // 시퀀스 단어 (first, then, next, finally 등)
    const sequenceWords = /\b(first|then|next|finally|after|before|meanwhile|subsequently|furthermore|moreover|additionally)\b/gi;
    const seqMatches = (msg.match(sequenceWords) || []).length;
    score += seqMatches * 0.5;

    return Math.min(10, score);
  }

  /**
   * 제약 조건 복잡도 (must, should, requirements, constraints)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreConstraintComplexity(msg) {
    const constraintWords = /\b(must|should|require|requirement|constraint|specification|specification|condition|condition|limitation|restriction|boundary|edge.?case|error|exception|validation|rule)\b/gi;
    const matches = (msg.match(constraintWords) || []).length;

    // 한글 제약 표현
    const koreanConstraint = /(반드시|해야|요구|조건|제약|명세|제한|경계|규칙|예외|검증)/g;
    const korMatches = (msg.match(koreanConstraint) || []).length;

    return Math.min(10, (matches + korMatches) * 0.5);
  }

  /**
   * 언어 혼합 (한/영 혼용 시 복잡도 증가)
   * @private
   * @param {string} msg
   * @returns {number}
   */
  _scoreLanguageMixing(msg) {
    const hasKorean = /[\uAC00-\uD7AF]/.test(msg);
    const hasEnglish = /[a-zA-Z]/.test(msg);

    // 코드도 있으면 추가 점수
    const hasCode = /```|~~~|\{|;/.test(msg);

    let score = 0;
    if (hasKorean && hasEnglish) score += 2;
    if (hasCode) score += 1;

    return Math.min(10, score);
  }

  /**
   * 배치 분석 (복수 메시지)
   * @param {Array<string>} messages
   * @returns {Array}
   */
  analyzeBatch(messages) {
    if (!Array.isArray(messages)) {
      log.warn('invalid batch input');
      return [];
    }

    return messages.map((msg, idx) => {
      try {
        return this.analyze(msg);
      } catch (err) {
        log.error('batch analysis failed at index ' + idx, err);
        return { tier: 'standard', score: 5, dimensions: {}, model: this.tierMap.standard };
      }
    });
  }
}

module.exports = { PromptRouter };
