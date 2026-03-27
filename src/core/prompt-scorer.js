/**
 * Prompt Complexity Scorer — Tier 1 모듈
 * 사용자 메시지를 3단계 복잡도로 분류하여 모델 라우팅 최적화
 * SpaceBot-inspired: 경량 키워드 기반 점수 시스템
 */

const { createLogger } = require('../shared/logger');

class PromptComplexityScorer {
  /**
   * 초기화 — 티어별 키워드 세트 및 임계값 구성
   * @param {Object} opts - 옵션
   * @param {string[]} opts.heavyKeywords - 복잡한 작업 키워드
   * @param {string[]} opts.lightKeywords - 간단한 작업 키워드
   * @param {Object} opts.thresholds - { heavy: 3, light: 1 } 키워드 개수 임계값
   */
  constructor(opts = {}) {
    this.log = createLogger('PromptComplexityScorer');

    // 복잡한 작업 키워드 (heavy tier)
    this.heavyKeywords = opts.heavyKeywords ?? [
      'analyze', 'implement', 'refactor', 'debug', 'architect', 'design',
      'compare', 'optimize', 'review', 'explain in detail', 'write code',
      'create a', 'build', '코드', '구현', '분석', '설계', '리팩토링',
      'complex', 'solution', 'algorithm', 'performance', 'scalability'
    ];

    // 간단한 작업 키워드 (light tier)
    this.lightKeywords = opts.lightKeywords ?? [
      'hi', 'hello', 'thanks', 'yes', 'no', 'ok', 'true', 'false',
      '안녕', '고마워', '응', '아니', '맞아', 'great', 'good'
    ];

    // 키워드 개수 기반 임계값
    this.thresholds = opts.thresholds ?? { heavy: 3, light: 1 };

    this.log.info('PromptComplexityScorer initialized', { 
      heavyKeywords: this.heavyKeywords.length,
      lightKeywords: this.lightKeywords.length,
      thresholds: this.thresholds
    });
  }

  /**
   * 메시지 복잡도 점수 계산
   * @param {string} message - 사용자 메시지
   * @returns {{ tier: 'light'|'standard'|'heavy', score: number, matchedKeywords: string[] }}
   */
  score(message) {
    try {
      if (!message || typeof message !== 'string') {
        this.log.warn('Invalid message type', { type: typeof message });
        return { tier: 'standard', score: 0, matchedKeywords: [] };
      }

      const normalizedMsg = message.toLowerCase();
      const matchedKeywords = [];
      let heavyCount = 0;
      let lightCount = 0;

      // Heavy 키워드 매칭
      for (const kw of this.heavyKeywords) {
        if (normalizedMsg.includes(kw.toLowerCase())) {
          heavyCount++;
          matchedKeywords.push(kw);
        }
      }

      // Light 키워드 매칭
      for (const kw of this.lightKeywords) {
        if (normalizedMsg.includes(kw.toLowerCase())) {
          lightCount++;
          matchedKeywords.push(kw);
        }
      }

      // 티어 결정
      let tier = 'standard';
      let score = heavyCount - lightCount;

      if (heavyCount >= this.thresholds.heavy) {
        tier = 'heavy';
      } else if (lightCount >= this.thresholds.light && heavyCount === 0) {
        tier = 'light';
      }

      // 메시지 길이도 복잡도에 영향
      const wordCount = message.split(/\s+/).length;
      if (wordCount > 50) score += 1;
      if (wordCount < 3) score -= 1;

      this.log.debug('Score calculated', { tier, score, keywordCount: matchedKeywords.length });

      return { tier, score, matchedKeywords: [...new Set(matchedKeywords)] };
    } catch (err) {
      this.log.error('Error scoring message', err);
      return { tier: 'standard', score: 0, matchedKeywords: [] };
    }
  }

  /**
   * 티어에 맞는 모델 추천
   * @param {'light'|'standard'|'heavy'} tier - 복잡도 티어
   * @param {Object} modelMap - { light: 'haiku', standard: 'sonnet', heavy: 'opus' }
   * @returns {string} 모델 이름
   */
  getModel(tier, modelMap = {}) {
    const defaults = {
      light: 'claude-haiku',
      standard: 'claude-sonnet',
      heavy: 'claude-opus'
    };

    const map = { ...defaults, ...modelMap };
    const model = map[tier] || map.standard;

    this.log.debug('Model selected', { tier, model });
    return model;
  }

  /**
   * 배치 점수 매기기
   * @param {string[]} messages - 메시지 배열
   * @returns {Array} 점수 배열
   */
  scoreBatch(messages) {
    return messages.map(msg => this.score(msg));
  }
}

module.exports = { PromptComplexityScorer };
