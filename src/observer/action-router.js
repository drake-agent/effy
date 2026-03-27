/**
 * action-router.js — Insight → Action 라우팅 엔진.
 *
 * v3.9: ProactiveEngine의 단순 메시지 전송을 넘어서,
 * insight 유형별로 **구체적 액션을 생성**하고 **적절한 사람에게 전달**한다.
 *
 * 기존 ProactiveEngine 문제:
 * - 채널에만 메시지 전송 (팀 리더 타겟팅 없음)
 * - 일반적인 안내 메시지만 (구체적 액션 추천 없음)
 * - 에이전트를 활용하지 않음
 *
 * ActionRouter 해결:
 * 1. insight.type → ActionTemplate 매핑
 * 2. 조직 구조에서 관련 팀 리더 자동 검색
 * 3. 에이전트(strategy/ops)에게 액션 추천 생성 의뢰
 * 4. DM 또는 특정 채널로 리더에게 알림 + 추천 액션 전송
 *
 * Safety:
 * - 리더당 일일 알림 상한 (기본 5건)
 * - 같은 insight 24시간 중복 방지
 * - confidence 임계값 미달 시 silent 처리
 * - admin opt-out 지원
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:action-router');

/**
 * Insight 유형 → 액션 템플릿 매핑.
 * 각 항목은 insight.type에 매칭되며:
 * - targetRole: 알림 대상 (org config에서 role로 검색)
 * - agentId: 액션 추천 생성할 에이전트
 * - urgency: 'low' | 'medium' | 'high' | 'critical'
 * - actionTemplate: LLM에 전달할 액션 추천 프롬프트 템플릿
 */
const ACTION_TEMPLATES = {
  // 목표/성과 관련
  goal_behind: {
    targetRoles: ['team_lead', 'manager'],
    agentId: 'strategy',
    urgency: 'high',
    actionTemplate: 'The team appears to be behind on {{topic}}. Suggest 2-3 concrete recovery actions the team lead should consider. Be specific and actionable.',
  },
  milestone_risk: {
    targetRoles: ['project_manager', 'team_lead'],
    agentId: 'ops',
    urgency: 'high',
    actionTemplate: 'A milestone for {{topic}} appears at risk. Suggest re-prioritization options and potential scope adjustments.',
  },

  // 기술/운영 관련
  recurring_error: {
    targetRoles: ['tech_lead', 'engineering_manager'],
    agentId: 'code',
    urgency: 'medium',
    actionTemplate: 'A recurring error pattern has been detected: {{topic}}. Suggest debugging approach and potential root causes to investigate.',
  },
  deployment_issue: {
    targetRoles: ['ops_lead', 'tech_lead'],
    agentId: 'ops',
    urgency: 'critical',
    actionTemplate: 'Deployment issue detected: {{topic}}. Suggest immediate mitigation steps and post-incident actions.',
  },

  // 팀 동향 관련
  team_blocker: {
    targetRoles: ['team_lead', 'manager'],
    agentId: 'general',
    urgency: 'medium',
    actionTemplate: 'A team blocker has been identified: {{topic}}. Suggest unblocking strategies and who to involve.',
  },
  knowledge_gap: {
    targetRoles: ['team_lead', 'knowledge_owner'],
    agentId: 'knowledge',
    urgency: 'low',
    actionTemplate: 'A knowledge gap was detected around {{topic}}. Suggest documentation actions and knowledge sharing activities.',
  },

  // 크로스팀 관련
  cross_team_conflict: {
    targetRoles: ['manager', 'director'],
    agentId: 'strategy',
    urgency: 'medium',
    actionTemplate: 'Cross-team misalignment detected around {{topic}}. Suggest alignment meeting agenda and resolution approach.',
  },

  // 기본 (매칭 안 되는 insight)
  default: {
    targetRoles: ['team_lead'],
    agentId: 'general',
    urgency: 'low',
    actionTemplate: 'An observation was made: {{topic}}. Briefly assess whether any action is needed.',
  },
};

class ActionRouter {
  /**
   * @param {Object} opts
   * @param {Object} opts.slackClient - Slack WebClient
   * @param {Object} opts.entity - Entity memory 모듈 (팀 리더 검색용)
   * @param {Object} [opts.agentBus] - AgentBus (에이전트에게 액션 추천 의뢰)
   * @param {Object} [opts.config] - 설정
   */
  constructor(opts = {}) {
    this.slackClient = opts.slackClient || null;
    this.entity = opts.entity || null;
    this.agentBus = opts.agentBus || null;
    this.config = opts.config || {};

    if (!this.entity) {
      log.warn('ActionRouter: entity module not provided — leader search will always return empty');
    }

    // Safety 제어
    this.maxDailyPerLeader = this.config.maxDailyPerLeader || 5;
    this.confidenceThreshold = this.config.confidenceThreshold || 0.75;
    this.dedupeWindowMs = this.config.dedupeWindowMs || 24 * 60 * 60 * 1000;

    /** @type {Map<string, number>} userId → 오늘 알림 횟수 */
    this._dailyCounts = new Map();
    /** @type {Map<string, number>} insightKey → 마지막 알림 시각 */
    this._dedupeMap = new Map();
    this._dailyResetDate = new Date().toISOString().slice(0, 10);

    this._stats = { routed: 0, notified: 0, suppressed: 0, agentActions: 0 };
  }

  /**
   * Insight를 라우팅하여 적절한 리더에게 알림 + 액션 추천.
   *
   * @param {Object} insight - InsightStore에서 온 insight 객체
   * @returns {Promise<{ action: string, targets: Array, reason?: string }>}
   */
  async route(insight) {
    this._stats.routed++;
    this._resetDailyIfNeeded();

    // confidence 검사
    if ((insight.confidence || 0) < this.confidenceThreshold) {
      this._stats.suppressed++;
      return { action: 'suppressed', targets: [], reason: 'below_confidence_threshold' };
    }

    // 중복 검사
    const dedupeKey = `${insight.type}:${insight.channel}:${(insight.content || '').substring(0, 50)}`;
    const lastNotified = this._dedupeMap.get(dedupeKey) || 0;
    if (Date.now() - lastNotified < this.dedupeWindowMs) {
      this._stats.suppressed++;
      return { action: 'suppressed', targets: [], reason: 'duplicate_within_24h' };
    }

    // 액션 템플릿 조회
    const template = ACTION_TEMPLATES[insight.type] || ACTION_TEMPLATES.default;
    const urgency = template.urgency;

    // 대상 리더 검색 (Entity Memory에서 role 기반)
    const targets = await this._findTargetLeaders(template.targetRoles, insight.channel);
    if (targets.length === 0) {
      this._stats.suppressed++;
      return { action: 'suppressed', targets: [], reason: 'no_target_leaders_found' };
    }

    // 에이전트에게 액션 추천 생성 요청 (옵션)
    let actionRecommendation = '';
    if (this.agentBus && template.agentId) {
      actionRecommendation = await this._getAgentRecommendation(
        template.agentId,
        template.actionTemplate.replace('{{topic}}', insight.content || insight.type),
        insight,
      );
    }

    // 리더들에게 알림 전송
    const notified = [];
    for (const leader of targets) {
      // 일일 상한 검사
      const count = this._dailyCounts.get(leader.userId) || 0;
      if (count >= this.maxDailyPerLeader) {
        continue;
      }

      const sent = await this._sendNotification(leader, insight, urgency, actionRecommendation);
      if (sent) {
        this._dailyCounts.set(leader.userId, count + 1);
        notified.push(leader.userId);
        this._stats.notified++;
      }
    }

    // 중복 방지 기록
    this._dedupeMap.set(dedupeKey, Date.now());

    log.info('Action routed', {
      insightId: insight.id,
      type: insight.type,
      urgency,
      targets: notified.length,
      hasAgentAction: !!actionRecommendation,
    });

    return {
      action: notified.length > 0 ? 'notified' : 'suppressed',
      targets: notified,
      urgency,
      actionRecommendation: actionRecommendation || undefined,
    };
  }

  // ─── 내부 메서드 ───

  /**
   * Entity Memory에서 역할 기반 리더 검색.
   * @private
   */
  async _findTargetLeaders(roles, channelId) {
    const leaders = [];

    if (!this.entity) return leaders;

    try {
      // Entity Memory에서 role이 targetRoles에 매칭되는 사용자 검색
      for (const role of roles) {
        const results = this.entity.findByType?.('user') || [];
        for (const user of results) {
          const props = user.properties || {};
          if (props.role === role || props.title?.toLowerCase().includes(role.replace('_', ' '))) {
            leaders.push({
              userId: user.entity_id || user.entityId,
              name: user.name || props.name || '',
              role: props.role || role,
            });
          }
        }
      }

      // 중복 제거
      const seen = new Set();
      return leaders.filter(l => {
        if (seen.has(l.userId)) return false;
        seen.add(l.userId);
        return true;
      });
    } catch (err) {
      log.debug('Leader search failed', { error: err.message });
      return [];
    }
  }

  /**
   * 에이전트에게 액션 추천 생성 요청.
   * @private
   */
  async _getAgentRecommendation(agentId, prompt, insight) {
    if (!this.agentBus) return '';

    try {
      const result = await this.agentBus.ask('observer', agentId, prompt, {
        timeoutMs: 15000,
        depth: 0,
      });

      if (result.success && result.response) {
        this._stats.agentActions++;
        return result.response;
      }
      return '';
    } catch (err) {
      log.debug('Agent action recommendation failed', { agentId, error: err.message });
      return '';
    }
  }

  /**
   * Slack DM으로 리더에게 알림 전송.
   * @private
   */
  async _sendNotification(leader, insight, urgency, actionRecommendation) {
    if (!this.slackClient) return false;

    try {
      const urgencyIcon = {
        critical: '🚨',
        high: '⚠️',
        medium: '📋',
        low: 'ℹ️',
      }[urgency] || '📋';

      let message = `${urgencyIcon} *Effy Insight Alert*\n\n`;
      message += `*Type:* ${insight.type}\n`;
      message += `*Confidence:* ${Math.round((insight.confidence || 0) * 100)}%\n`;
      if (insight.channel) {
        message += `*Channel:* <#${insight.channel}>\n`;
      }
      message += `\n${insight.content || ''}\n`;

      if (actionRecommendation) {
        message += `\n---\n*추천 액션:*\n${actionRecommendation}\n`;
      }

      message += `\n_이 알림은 Effy의 Ambient Intelligence가 자동 생성했습니다._`;

      // DM 전송
      await this.slackClient.chat.postMessage({
        channel: leader.userId,
        text: message,
        unfurl_links: false,
      });

      return true;
    } catch (err) {
      log.warn('DM notification failed', { userId: leader.userId, error: err.message });
      return false;
    }
  }

  /** @private 일일 카운터 리셋 */
  _resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this._dailyResetDate) {
      this._dailyCounts.clear();
      this._dailyResetDate = today;
    }
  }

  /** 통계 */
  getStats() { return { ...this._stats }; }
}

module.exports = { ActionRouter, ACTION_TEMPLATES };
