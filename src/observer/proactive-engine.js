/**
 * proactive-engine.js — Layer 3: Proactive Suggestion Engine.
 *
 * v3.9 SLIM: 2단계 (Off/On) — 기존 3단계(Silent/Nudge/Active)에서 간소화.
 *
 * Off: confidence < threshold → insight 저장만 (대시보드 표시)
 * On:  confidence ≥ threshold → ActionRouter로 전달 + 채널 메시지
 *
 * Safety: 채널별 1시간 쿨다운, 일별 제안 상한 (ActionRouter의 maxDailyPerLeader과 공유),
 * 동일 토픽 24시간 중복 방지.
 *
 * v3.9: ActionRouter 통합 — 높은 confidence의 insight는 ActionRouter로 위임하여
 * 팀 리더에게 DM + 에이전트 기반 액션 추천을 전달.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:proactive');

// SLIM: 2-level system (Off/On). LEVEL constants kept for config compatibility.
const LEVEL = { OFF: 0, ON: 1, SILENT: 1, NUDGE: 2, ACTIVE: 3 };

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

    // SLIM: 단일 threshold (기존 nudge/active 분리 → 통합)
    this.confidenceThreshold = this.config.confidenceThresholds?.nudge
      || this.config.confidenceThreshold || 0.8;

    // 채널별 활성화 여부 (기존 level 1/2/3 → enabled true/false)
    // 기존 config 호환: level 1(SILENT) → disabled, level 2+(NUDGE/ACTIVE) → enabled
    this._channelEnabled = new Map();
    const overrides = this.config.channelOverrides || {};
    for (const [ch, level] of Object.entries(overrides)) {
      this._channelEnabled.set(ch, Number(level) >= 2);
    }
    this.defaultEnabled = (this.config.defaultLevel || 1) >= 2;

    // Safety: 쿨다운 + 일별 상한
    this.cooldownMs = this.config.cooldownMs || 60 * 60 * 1000;  // 1시간
    this.maxDailySuggestions = this.config.maxDailySuggestions || 10;
    this.lastSuggestion = new Map();  // channelId → timestamp
    this.dailySuggestionCount = 0;
    this.dailyResetDate = new Date().toISOString().slice(0, 10);

    // 통계 (silent/nudged/active 모두 유지 — 모니터링 호환)
    this.stats = { processed: 0, silent: 0, notified: 0, suppressed: 0 };
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
   * 단일 insight 처리 — SLIM 2-level.
   */
  async _processOne(insight) {
    this.stats.processed++;
    const ch = insight.channel;
    const confidence = insight.confidence || 0;

    // channel 검증
    if (!ch || typeof ch !== 'string' || !ch.startsWith('C')) {
      this.stats.suppressed++;
      return { insightId: insight.id, action: 'suppressed', reason: 'invalid_channel' };
    }

    // ─── Off: 채널 비활성 또는 confidence 미달 → silent 처리 ───
    const enabled = this._isEnabled(ch);
    if (!enabled || confidence < this.confidenceThreshold) {
      this.insightStore.updateStatus(insight.id, 'logged');
      this.stats.silent++;
      return { insightId: insight.id, action: 'silent', reason: enabled ? 'below_threshold' : 'channel_disabled' };
    }

    // ─── Safety 체크 (공유 예산 우선, 없으면 로컬) ───
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

    // ─── On: ActionRouter로 전달 + 채널 메시지 ───

    // 1. ActionRouter — 팀 리더 DM + 액션 추천
    if (this.actionRouter) {
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

    // 2. 채널 메시지 (thread reply for lower confidence, channel message for high)
    const message = this._buildMessage(insight);
    if (message && this.slackClient) {
      try {
        await this.slackClient.chat.postMessage({
          channel: ch,
          thread_ts: insight.evidence?.[0] || undefined,
          text: message,
          unfurl_links: false,
        });
        this.insightStore.updateStatus(insight.id, 'proposed');
        this.lastSuggestion.set(ch, Date.now());
        this.dailySuggestionCount++;
        this.stats.notified++;
        log.info('Proactive suggestion sent', { insightId: insight.id, channel: ch, type: insight.type });
        return { insightId: insight.id, action: 'notified', channel: ch };
      } catch (err) {
        log.warn('Proactive message failed', { error: err.message, channel: ch });
      }
    }

    // fallback: silent
    this.insightStore.updateStatus(insight.id, 'logged');
    this.stats.silent++;
    return { insightId: insight.id, action: 'silent', reason: 'message_build_failed' };
  }

  /**
   * 채널 활성화 여부 확인 — SLIM 2-level.
   * @private
   */
  _isEnabled(channelId) {
    if (this._channelEnabled.has(channelId)) {
      return this._channelEnabled.get(channelId);
    }
    return this.defaultEnabled;
  }

  /**
   * 메시지 생성.
   */
  _buildMessage(insight) {
    switch (insight.type) {
      case 'question': {
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
          ? `💡 관련 정보가 있습니다:${knowledgeHint}\n\n더 자세한 내용이 필요하면 저를 태그해주세요.\n\n_이 제안이 도움이 되었나요? 👍 또는 👎로 알려주세요._`
          : null;
      }
      case 'decision':
        return `📋 이 결정사항을 팀 지식베이스에 기록했습니다.\n\n_이 제안이 도움이 되었나요? 👍 또는 👎로 알려주세요._`;
      case 'pattern':
        return `🔗 ${insight.relatedChannel ? `<#${insight.relatedChannel}>` : '다른 채널'}에서도 같은 주제가 논의되고 있습니다.\n\n_이 제안이 도움이 되었나요? 👍 또는 👎로 알려주세요._`;
      default:
        return null;
    }
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
   * 채널 활성화/비활성화 설정.
   * @param {string} channelId
   * @param {boolean|number} enabledOrLevel - true/false 또는 기존 level 숫자 (호환)
   */
  setChannelLevel(channelId, enabledOrLevel) {
    const enabled = typeof enabledOrLevel === 'boolean' ? enabledOrLevel : Number(enabledOrLevel) >= 2;
    this._channelEnabled.set(channelId, enabled);
    log.info('Channel proactive level changed', { channel: channelId, enabled });
  }

  /**
   * 통계 조회.
   */
  getStats() {
    return {
      ...this.stats,
      dailyRemaining: Math.max(0, this.maxDailySuggestions - this.dailySuggestionCount),
      channelEnabled: Object.fromEntries(this._channelEnabled),
    };
  }
}

module.exports = { ProactiveEngine, LEVEL };
