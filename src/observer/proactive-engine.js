/**
 * proactive-engine.js — Layer 3: Proactive Suggestion Engine.
 *
 * Insight → Action 매핑 + 3단계 Progressive Level 결정.
 *
 * Level 1 (Silent Learn): insight만 저장, 대시보드에만 표시
 * Level 2 (Gentle Nudge): 스레드로 조용히 제안 (confidence > 0.8)
 * Level 3 (Active Propose): 채널에 직접 메시지 (confidence > 0.9, admin 설정)
 *
 * Safety: 채널별 1시간 쿨다운, 일별 제안 상한, 동일 토픽 24시간 중복 방지.
 *
 * v3.9: ActionRouter 통합 — 높은 confidence의 insight는 ActionRouter로 위임하여
 * 팀 리더에게 DM + 에이전트 기반 액션 추천을 전달.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:proactive');

const LEVEL = { SILENT: 1, NUDGE: 2, ACTIVE: 3 };

class ProactiveEngine {
  /**
   * @param {object} opts
   * @param {object} opts.config - observer.proactive config
   * @param {object} opts.insightStore - InsightStore
   * @param {object} opts.slackClient - Slack WebClient (메시지 전송용)
   * @param {object} opts.semantic - L3 Semantic memory (지식 검색용)
   * @param {object} [opts.actionRouter] - ActionRouter (v3.9 — 리더 알림/액션 추천)
   * @param {object} [opts.sharedDailyBudget] - 공유 일일 예산 (v3.9)
   */
  constructor(opts = {}) {
    this.config = opts.config || {};
    this.insightStore = opts.insightStore || null;
    this.slackClient = opts.slackClient || null;
    this.semantic = opts.semantic || null;
    this.actionRouter = opts.actionRouter || null;
    this._sharedBudget = opts.sharedDailyBudget || null;

    // Level 설정
    this.defaultLevel = this.config.defaultLevel || LEVEL.SILENT;
    this.channelLevels = new Map(Object.entries(this.config.channelOverrides || {}));
    this.thresholds = {
      nudge: this.config.confidenceThresholds?.nudge || 0.8,
      active: this.config.confidenceThresholds?.active || 0.9,
    };

    // Safety: 쿨다운 + 일별 상한
    this.cooldownMs = this.config.cooldownMs || 60 * 60 * 1000;  // 1시간
    this.maxDailySuggestions = this.config.maxDailySuggestions || 10;
    this.lastSuggestion = new Map();  // channelId → timestamp
    this.dailySuggestionCount = 0;
    this.dailyResetDate = new Date().toISOString().slice(0, 10);

    // 통계
    this.stats = { processed: 0, silent: 0, nudged: 0, active: 0, suppressed: 0 };
  }

  /**
   * 대기 중인 insights를 처리하여 제안 생성.
   * 주기적으로 호출 (타이머 또는 배치 트리거).
   *
   * @returns {Array} 처리 결과
   */
  async process() {
    if (!this.insightStore) return [];

    // 일별 리셋
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailySuggestionCount = 0;
      this.dailyResetDate = today;
    }

    const actionable = this.insightStore.getActionable(0);
    const results = [];

    for (const insight of actionable) {
      const result = await this._processOne(insight);
      results.push(result);
    }

    return results;
  }

  /**
   * 단일 insight 처리.
   */
  async _processOne(insight) {
    this.stats.processed++;
    const ch = insight.channel;
    const level = this._getLevel(ch);
    const confidence = insight.confidence || 0;

    // R8-BUG-1: channel 검증을 Level 체크보다 먼저 (SILENT이어도 invalid channel은 처리 안 함)
    if (!ch || typeof ch !== 'string' || !ch.startsWith('C')) {
      this.stats.suppressed++;
      return { insightId: insight.id, action: 'suppressed', reason: 'invalid_channel' };
    }

    // ─── Level 1: Silent Learn ───
    if (level === LEVEL.SILENT) {
      this.insightStore.updateStatus(insight.id, 'logged');
      this.stats.silent++;
      return { insightId: insight.id, action: 'silent', channel: ch };
    }

    // ─── v3.9: ActionRouter — 팀 리더에게 DM + 액션 추천 ───
    // ProactiveEngine의 채널 메시지와 병행: ActionRouter는 리더 DM, ProactiveEngine은 채널 메시지.
    if (this.actionRouter && confidence >= this.thresholds.nudge) {
      try {
        const routeResult = await this.actionRouter.route(insight);
        if (routeResult.action === 'notified') {
          log.info('ActionRouter: leaders notified', {
            insightId: insight.id,
            targets: routeResult.targets.length,
            urgency: routeResult.urgency,
          });
        }
      } catch (routeErr) {
        log.debug('ActionRouter routing failed (non-blocking)', { error: routeErr.message });
      }
    }

    // ─── Safety 체크 (공유 예산 우선, 없으면 로컬) ───
    // v3.9: Use atomic tryConsume() instead of separate canSend() + increment()
    const canProceed = this._sharedBudget
      ? this._sharedBudget.tryConsume()
      : (this.dailySuggestionCount < this.maxDailySuggestions);
    if (!canProceed) {
      this.stats.suppressed++;
      return { insightId: insight.id, action: 'suppressed', reason: 'daily_limit' };
    }
    const lastTime = this.lastSuggestion.get(ch) || 0;
    if (Date.now() - lastTime < this.cooldownMs) {
      this.stats.suppressed++;
      return { insightId: insight.id, action: 'suppressed', reason: 'cooldown' };
    }

    // ─── Level 2: Gentle Nudge (confidence > threshold) ───
    if (level >= LEVEL.NUDGE && level < LEVEL.ACTIVE && confidence >= this.thresholds.nudge) {
      const message = this._buildMessage(insight);
      if (message && this.slackClient) {
        try {
          await this.slackClient.chat.postMessage({
            channel: ch,
            thread_ts: insight.evidence?.[0] || undefined,  // 스레드로 답변
            text: message,
            unfurl_links: false,
          });
          this.insightStore.updateStatus(insight.id, 'proposed');
          this.lastSuggestion.set(ch, Date.now());
          this.dailySuggestionCount++;
          // v3.9: Budget already consumed by tryConsume() above
          this.stats.nudged++;
          log.info('Proactive nudge sent', { insightId: insight.id, channel: ch, type: insight.type });
          return { insightId: insight.id, action: 'nudge', channel: ch };
        } catch (err) {
          log.warn('Proactive nudge failed', { error: err.message, channel: ch });
        }
      }
    }

    // ─── Level 3: Active Propose (confidence > high threshold) ───
    if (level >= LEVEL.ACTIVE && confidence >= this.thresholds.active) {
      const message = this._buildActiveMessage(insight);
      if (message && this.slackClient) {
        try {
          await this.slackClient.chat.postMessage({
            channel: ch,
            text: message,
            unfurl_links: false,
          });
          this.insightStore.updateStatus(insight.id, 'proposed');
          this.lastSuggestion.set(ch, Date.now());
          this.dailySuggestionCount++;
          // v3.9: Budget already consumed by tryConsume() above
          this.stats.active++;
          log.info('Proactive active message sent', { insightId: insight.id, channel: ch });
          return { insightId: insight.id, action: 'active', channel: ch };
        } catch (err) {
          log.warn('Proactive active message failed', { error: err.message });
        }
      }
    }

    // 기본: silent 처리
    this.insightStore.updateStatus(insight.id, 'logged');
    this.stats.silent++;
    return { insightId: insight.id, action: 'silent', reason: 'below_threshold' };
  }

  /**
   * 채널별 Level 조회.
   */
  _getLevel(channelId) {
    if (this.channelLevels.has(channelId)) {
      return Number(this.channelLevels.get(channelId));
    }
    return this.defaultLevel;
  }

  /**
   * Level 2 메시지 생성 (스레드 답변, 절제됨).
   */
  _buildMessage(insight) {
    switch (insight.type) {
      case 'question': {
        // L3 Semantic에서 관련 지식 검색
        let knowledgeHint = '';
        if (this.semantic) {
          try {
            const results = this.semantic.searchWithPools?.(insight.content?.slice(0, 100) || '', ['team'], 2) || [];
            if (results.length > 0) {
              knowledgeHint = `\n관련 지식:\n${results.map(r => `• ${r.content?.slice(0, 100)}`).join('\n')}`;
            }
          } catch { /* ignore */ }
        }
        return knowledgeHint
          ? `💡 관련 정보가 있습니다:${knowledgeHint}\n\n더 자세한 내용이 필요하면 저를 태그해주세요.`
          : null;  // 관련 지식 없으면 침묵
      }
      case 'decision':
        return `📋 이 결정사항을 팀 지식베이스에 기록했습니다.`;
      case 'pattern':
        return `🔗 ${insight.relatedChannel ? `<#${insight.relatedChannel}>` : '다른 채널'}에서도 같은 주제가 논의되고 있습니다.`;
      default:
        return null;
    }
  }

  /**
   * Level 3 메시지 생성 (채널 직접 메시지, 더 상세).
   */
  _buildActiveMessage(insight) {
    const base = this._buildMessage(insight);
    if (!base) return null;
    return `${base}\n\n_이 제안이 도움이 되었나요? 👍 또는 👎로 알려주세요._`;
  }

  /**
   * v3.9: ActionRouter 주입 (Observer.init() 후 런타임 주입).
   * @param {Object} router - ActionRouter 인스턴스
   */
  setActionRouter(router) {
    this.actionRouter = router;
    log.info('ActionRouter injected into ProactiveEngine');
  }

  /**
   * 채널 Level 변경 (Change Control 승인 후).
   */
  setChannelLevel(channelId, level) {
    this.channelLevels.set(channelId, level);
    log.info('Channel proactive level changed', { channel: channelId, level });
  }

  /**
   * 통계 조회.
   */
  getStats() {
    return {
      ...this.stats,
      dailyRemaining: Math.max(0, this.maxDailySuggestions - this.dailySuggestionCount),
      channelLevels: Object.fromEntries(this.channelLevels),
    };
  }
}

module.exports = { ProactiveEngine, LEVEL };
