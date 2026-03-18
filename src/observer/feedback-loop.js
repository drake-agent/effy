/**
 * feedback-loop.js — Layer 4: User Feedback Learning.
 *
 * 사용자 반응(👍/👎/무시)을 수집하여 insight confidence 학습.
 * ReflectionEngine과 통합하여 Proactive 제안 품질을 지속 개선.
 *
 * 규칙:
 * - 👍 (accepted): confidence 상향 + 유사 패턴 적극 감지
 * - 👎 (dismissed): confidence 하향 + 연속 3회 시 패턴 비활성화
 * - 무시 (expired): 중립 (변화 없음)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:feedback');

class FeedbackLoop {
  /**
   * @param {object} opts
   * @param {object} opts.insightStore - InsightStore
   * @param {number} opts.dismissThreshold - 연속 dismiss 시 비활성화 (기본 3)
   */
  constructor(opts = {}) {
    this.insightStore = opts.insightStore || null;
    this.dismissThreshold = opts.dismissThreshold || 3;

    // 패턴별 연속 dismiss 카운터
    this.dismissCounts = new Map();  // `${channel}:${type}` → count

    // 통계
    this.stats = { accepted: 0, dismissed: 0, expired: 0 };

    // 비활성화된 패턴
    this.disabledPatterns = new Set();  // `${channel}:${type}`
  }

  /**
   * 사용자 긍정 반응 (👍).
   *
   * @param {string} insightId
   * @returns {{ success: boolean, effect: string }}
   */
  accept(insightId) {
    if (!this.insightStore) return { success: false, effect: 'no store' };

    const insight = this.insightStore.updateStatus(insightId, 'accepted');
    if (!insight) return { success: false, effect: 'not found' };

    // 연속 dismiss 카운터 리셋
    const key = `${insight.channel}:${insight.type}`;
    this.dismissCounts.set(key, 0);

    this.stats.accepted++;
    log.info('Insight accepted', { id: insightId, type: insight.type, channel: insight.channel });

    return {
      success: true,
      effect: 'confidence_boost',
      message: `Insight accepted. 유사 패턴 감지를 강화합니다.`,
    };
  }

  /**
   * 사용자 부정 반응 (👎).
   *
   * @param {string} insightId
   * @returns {{ success: boolean, effect: string, disabled?: boolean }}
   */
  dismiss(insightId) {
    if (!this.insightStore) return { success: false, effect: 'no store' };

    const insight = this.insightStore.updateStatus(insightId, 'dismissed');
    if (!insight) return { success: false, effect: 'not found' };

    const key = `${insight.channel}:${insight.type}`;
    const count = (this.dismissCounts.get(key) || 0) + 1;
    this.dismissCounts.set(key, count);

    this.stats.dismissed++;

    // 연속 3회 dismiss → 패턴 비활성화 (Change Control HIGH 필요)
    if (count >= this.dismissThreshold) {
      this.disabledPatterns.add(key);
      log.warn('Pattern auto-disabled after repeated dismissals', { key, count });
      return {
        success: true,
        effect: 'pattern_disabled',
        disabled: true,
        message: `${insight.type} 패턴이 ${insight.channel}에서 비활성화되었습니다 (${count}회 연속 dismiss).`,
      };
    }

    log.info('Insight dismissed', { id: insightId, type: insight.type, count });
    return {
      success: true,
      effect: 'confidence_reduced',
      message: `해당 제안을 줄이겠습니다. (${count}/${this.dismissThreshold})`,
    };
  }

  /**
   * 패턴이 비활성화되었는지 확인.
   * PatternDetector에서 분석 전에 호출.
   */
  isPatternDisabled(channelId, type) {
    return this.disabledPatterns.has(`${channelId}:${type}`);
  }

  /**
   * 비활성화된 패턴 재활성화 (Change Control HIGH 승인 후).
   */
  enablePattern(channelId, type) {
    const key = `${channelId}:${type}`;
    this.disabledPatterns.delete(key);
    this.dismissCounts.set(key, 0);
    log.info('Pattern re-enabled', { channel: channelId, type });
  }

  /**
   * 일별 리포트 데이터 (NightlyDistiller 통합용).
   */
  getDailyReport() {
    return {
      ...this.stats,
      acceptRate: this.stats.accepted + this.stats.dismissed > 0
        ? (this.stats.accepted / (this.stats.accepted + this.stats.dismissed) * 100).toFixed(1)
        : 'N/A',
      disabledPatterns: [...this.disabledPatterns],
    };
  }

  /**
   * 통계.
   */
  getStats() {
    return {
      ...this.stats,
      disabledPatterns: [...this.disabledPatterns],
    };
  }
}

module.exports = { FeedbackLoop };
