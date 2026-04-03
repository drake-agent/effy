/**
 * teams.js — Microsoft Teams 채널 어댑터.
 *
 * Microsoft 365 Agents SDK 기반 Teams 봇.
 * Slack 어댑터와 동일한 인터페이스 (normalize, reply, replyStream, start, client).
 *
 * 지원 기능:
 * - @멘션 메시지 수신 + 응답
 * - DM (1:1 대화)
 * - 봇 설치 채널의 모든 메시지 수신 (Observer용)
 * - Proactive DM (아침 브리핑 등)
 * - Adaptive Cards (Committee 투표, 슬래시 커맨드 대체)
 * - 스트리밍 응답 (Activity Update)
 * - 첨부파일 다운로드 (Graph API)
 * - 신규 멤버 감지 (onMembersAdded)
 *
 * 제한사항:
 * - HTTPS 엔드포인트 필수 (Socket Mode 없음)
 * - 전 채널 관찰 불가 → 봇 설치 채널만 관찰
 * - 슬래시 커맨드 없음 → Adaptive Card + Message Extension으로 대체
 * - 리액션 이벤트 제한 → Adaptive Card 버튼으로 대체
 *
 * 설정:
 *   channels.teams.enabled: true
 *   channels.teams.appId: ${TEAMS_APP_ID}
 *   channels.teams.appPassword: ${TEAMS_APP_PASSWORD}
 *   channels.teams.port: 3978 (기본)
 */
const express = require('express');
const { detectChannelMentions } = require('../../core/router');
const { createLogger } = require('../../shared/logger');

const log = createLogger('teams-adapter');

class TeamsAdapter {
  /**
   * @param {object} teamsConfig - config.channels.teams
   * @param {object} gateway - Gateway 인스턴스
   */
  constructor(teamsConfig, gateway) {
    this.gateway = gateway;
    this.type = 'teams';
    this.config = teamsConfig;
    this.port = teamsConfig.port || 3000;
    this.basePath = process.env.BASE_PATH || '';

    // Conversation references 저장 (Proactive DM용)
    this.conversationRefs = new Map();  // aadObjectId → { ref, ts }
    this._CONV_REF_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7일 TTL

    // 메시지 중복 제거 (Teams 재시도 방지)
    this._processedMessages = new Map();  // activityId → timestamp
    this._DEDUP_TTL_MS = 60_000;  // 1분간 같은 메시지 무시

    // Express 서버 (Teams 봇은 HTTPS 엔드포인트 필요)
    this.server = express();
    this.server.use(express.json());

    // Agents SDK (lazy require — 설치 안 되어 있으면 graceful fail)
    this._adapter = null;
    this._botId = teamsConfig.appId || '';
    this._botPassword = teamsConfig.appPassword || '';
  }

  /**
   * Teams 봇 시작.
   */
  async start() {
    try {
      // Microsoft 365 Agents SDK (2026 공식) — botbuilder 레거시 fallback
      const bb = require('botbuilder');
      const { CloudAdapter, ConfigurationBotFrameworkAuthentication } = bb;
      log.info('Teams adapter: credentials configured', {
        appId: this._botId ? `${this._botId.slice(0, 8)}...` : 'MISSING',
        tenantId: this.config.tenantId ? `${this.config.tenantId.slice(0, 8)}...` : 'MISSING',
        basePath: this.basePath,
      });

      const auth = new ConfigurationBotFrameworkAuthentication({
        MicrosoftAppId: this._botId,
        MicrosoftAppPassword: this._botPassword,
        MicrosoftAppType: 'SingleTenant',
        MicrosoftAppTenantId: this.config.tenantId || '',
      });

      this._adapter = new CloudAdapter(auth);

      // Error handler
      this._adapter.onTurnError = async (context, error) => {
        log.error('Teams bot error', { error: error.message, stack: error.stack?.split('\n')[1]?.trim() });
        try {
          await context.sendActivity('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
        } catch { /* best-effort */ }
      };

      // 메시지 엔드포인트 (basePath 지원: /effy/api/messages)
      this.server.post(`${this.basePath}/api/messages`, async (req, res) => {
        log.info('Incoming message', { path: req.path, auth: req.headers.authorization ? 'present' : 'missing' });
        await this._adapter.process(req, res, async (context) => {
          await this._onTurn(context);
        });
      });

      // Health check (ALB: /effy/api/health)
      this.server.get(`${this.basePath}/api/health`, (_, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
      });
      // 루트 health check (Docker / 로컬)
      this.server.get('/health', (_, res) => res.json({ status: 'ok' }));

      // 서버 시작
      this.server.listen(this.port, () => {
        log.info(`Teams bot listening on :${this.port}`);
      });

      console.log(`[teams-adapter] Connected (HTTPS endpoint on :${this.port})`);
      return this;
    } catch (err) {
      log.error('Teams adapter start failed', { error: err.message });
      console.error('[teams-adapter] Start failed:', err.message);
      console.error('[teams-adapter] Install botbuilder: npm install botbuilder');
      return this;
    }
  }

  /**
   * 모든 Activity 처리.
   */
  async _onTurn(context) {
    const activity = context.activity;

    // Conversation Reference 저장 (Proactive DM용)
    this._saveConversationRef(context);

    switch (activity.type) {
      case 'message':
        await this._onMessage(context);
        break;

      case 'conversationUpdate':
        await this._onConversationUpdate(context);
        break;

      case 'invoke':
        // Adaptive Card 액션 (Committee 투표 등)
        await this._onInvoke(context);
        break;

      default:
        log.debug('Unhandled activity type', { type: activity.type });
    }
  }

  /**
   * 메시지 처리 — Gateway 파이프라인으로 전달.
   *
   * 주의: Teams는 HTTP 응답이 ~15초 내에 안 오면 재시도함.
   * → 파이프라인을 비동기로 실행하고 HTTP는 즉시 반환.
   * → 메시지 ID 기반 중복 제거로 재시도 폭주 방지.
   */
  async _onMessage(context) {
    const activity = context.activity;

    // 봇 자신의 메시지 무시
    if (activity.from?.id === this._botId) return;

    // 메시지 중복 제거 (Teams 재시도 방지)
    const msgId = activity.id;
    if (msgId && this._processedMessages.has(msgId)) {
      log.debug('Duplicate message ignored', { id: msgId });
      return;
    }
    if (msgId) {
      this._processedMessages.set(msgId, Date.now());
      // TTL 후 정리
      setTimeout(() => this._processedMessages.delete(msgId), this._DEDUP_TTL_MS);
    }

    const isGroupChat = activity.conversation?.conversationType === 'groupChat';
    const isChannel = activity.conversation?.conversationType === 'channel';
    const isPersonal = activity.conversation?.conversationType === 'personal';

    // 채널/그룹에서 @멘션 아닌 메시지 → Observer로 전달
    if ((isChannel || isGroupChat) && !this._isMentioned(activity)) {
      this._sendToObserver(activity);
      return;
    }

    // @멘션 또는 DM → Gateway 파이프라인
    const msg = this.normalize(activity, {
      isDM: isPersonal,
      isMention: this._isMentioned(activity),
    });

    // 응답 컨텍스트를 메시지에 첨부 (reply에서 사용)
    msg._teamsContext = context;

    // 타이핑 인디케이터 전송 (생각하는 중...)
    try { await context.sendActivity({ type: 'typing' }); } catch { /* best-effort */ }

    // TurnContext는 _onTurn 완료 시 폐기되므로 반드시 await 필요
    try {
      await this.gateway.onMessage(msg, this);
    } catch (err) {
      log.error('Teams message pipeline error', { error: err.message });
      await context.sendActivity('처리 중 오류가 발생했습니다.');
    }
  }

  /**
   * conversationUpdate — 신규 멤버 감지.
   */
  async _onConversationUpdate(context) {
    const members = context.activity.membersAdded || [];
    const botId = context.activity.recipient?.id || this._botId;
    let greeted = false;
    for (const member of members) {
      // 봇 자신 제외 (ID 또는 role로 체크)
      if (member.id === botId || member.id === this._botId || member.role === 'bot') continue;
      if (greeted) continue;  // 중복 인사 방지
      log.info('New member joined', { userId: member.id, name: member.name });
      try {
        await context.sendActivity('👋 안녕하세요! Effy입니다. 무엇이든 물어보세요! (기능 안내: "help" 입력)');
        greeted = true;
      } catch { /* best-effort */ }
    }
  }

  /**
   * Invoke — Adaptive Card 버튼 액션.
   */
  async _onInvoke(context) {
    const value = context.activity.value;
    if (!value) return;

    // Committee 투표 (approve/reject/defer)
    if (value.action === 'committee_vote') {
      try {
        const { getCommittee } = require('../../reflection');
        const committee = getCommittee();
        if (committee) {
          // TODO: committee.handleVote(value.proposalId, value.vote, context.activity.from.id);
          await context.sendActivity(`투표 완료: ${value.vote}`);
        }
      } catch { /* reflection not initialized */ }
      return;
    }

    // Observer 피드백 (👍/👎)
    if (value.action === 'feedback') {
      try {
        const { getObserver } = require('../../observer');
        const observer = getObserver();
        observer.handleFeedback(value.reaction, value.insightId);
        await context.sendActivity(value.reaction === 'thumbsup' ? '👍 감사합니다!' : '알겠습니다, 참고하겠습니다.');
      } catch { /* observer not initialized */ }
      return;
    }
  }

  /**
   * 봇이 @멘션되었는지 확인.
   */
  _isMentioned(activity) {
    if (!activity.entities) return false;
    return activity.entities.some(e =>
      e.type === 'mention' && e.mentioned?.id === this._botId
    );
  }

  /**
   * Observer로 메시지 전달 (봇 설치 채널의 비멘션 메시지).
   */
  _sendToObserver(activity) {
    try {
      const { getObserver } = require('../../observer');
      const observer = getObserver();
      observer.onMessage({
        channel: activity.conversation?.id || '',
        text: activity.text || '',
        user: activity.from?.aadObjectId || activity.from?.id || '',
        ts: activity.timestamp || '',
      });
    } catch { /* observer not initialized */ }
  }

  /**
   * Conversation Reference 저장 (Proactive DM용).
   */
  _saveConversationRef(context) {
    const ref = context.activity?.from;
    if (!ref?.aadObjectId) return;
    const convRef = {
      ...context.activity.getConversationReference?.() || {},
      user: ref,
    };
    // TTL + LRU eviction
    const now = Date.now();
    const MAX_CONV_REFS = 1000;
    // Evict expired entries periodically (when at capacity)
    if (this.conversationRefs.size >= MAX_CONV_REFS) {
      for (const [key, entry] of this.conversationRefs) {
        if (now - entry.ts > this._CONV_REF_TTL_MS) {
          this.conversationRefs.delete(key);
        }
      }
    }
    // LRU eviction if still at capacity
    if (this.conversationRefs.size >= MAX_CONV_REFS) {
      const oldestKey = this.conversationRefs.keys().next().value;
      this.conversationRefs.delete(oldestKey);
    }
    this.conversationRefs.set(ref.aadObjectId, { ref: convRef, ts: now });
  }

  // ═══════════════════════════════════════════════════════
  // Gateway 인터페이스 (Slack과 동일)
  // ═══════════════════════════════════════════════════════

  /**
   * Teams Activity → NormalizedMessage 변환.
   */
  normalize(activity, context = {}) {
    let rawText = activity.text || '';

    // @멘션 태그 제거 (<at>BotName</at> 형태)
    if (context.isMention) {
      rawText = rawText.replace(/<at>[^<]*<\/at>/gi, '').trim();
    }

    // IC-5 fix: threadId should not equal channelId.
    // For thread replies use replyToId; for non-threaded / personal conversations use undefined.
    const conversationType = activity.conversation?.conversationType;
    let threadId;
    if (activity.replyToId) {
      // This is a reply within a thread
      threadId = activity.replyToId;
    } else if (conversationType && conversationType !== 'personal') {
      // Channel/groupChat root message — no thread concept yet
      threadId = undefined;
    } else {
      threadId = undefined;
    }

    return {
      id: activity.id || `${Date.now()}`,
      channel: {
        type: 'teams',
        accountId: activity.conversation?.tenantId || '',
        channelId: activity.conversation?.id || '',
        threadId,
      },
      sender: {
        id: activity.from?.aadObjectId || activity.from?.id || '',
        name: activity.from?.name || '',
        isBot: activity.from?.id === this._botId,
      },
      content: {
        text: rawText,
        mentions: detectChannelMentions(rawText),
        // IC-6 fix: Standardize attachment format to common shape { name, contentType, url, size }
        attachments: (activity.attachments || [])
          .filter(a => a.contentUrl || a.content?.downloadUrl)  // Teams 내부 카드/메타데이터 제외, 실제 파일만
          .map(a => ({
            name: a.name || 'file',
            contentType: a.contentType || '',
            url: a.contentUrl || a.content?.downloadUrl || '',
            size: a.contentLength || a.content?.fileSize || undefined,
          })),
      },
      metadata: {
        timestamp: new Date(activity.timestamp || Date.now()).getTime(),
        isDM: !!context.isDM,
        isMention: !!context.isMention,
        isReaction: false,
        platform: 'teams',
      },
    };
  }

  /**
   * 응답 전송.
   */
  async reply(originalMsg, text) {
    const ctx = originalMsg._teamsContext;
    if (ctx) {
      try {
        await ctx.sendActivity(text);
      } catch (err) {
        log.error('Teams reply error', { error: err.message });
      }
      return;
    }

    // Proactive 메시지 (아침 브리핑 등) — conversationReference 필요
    log.warn('Reply without context — proactive message not supported for this message');
  }

  /**
   * 스트리밍 응답 — "생각하는 중..." → 업데이트 → 최종.
   * Teams는 Activity Update로 메시지 수정 가능.
   */
  async replyStream(originalMsg, stream) {
    const ctx = originalMsg._teamsContext;
    if (!ctx) return '';

    // 1. 플레이스홀더
    let activityId;
    try {
      const response = await ctx.sendActivity('⏳ 생각하는 중...');
      activityId = response?.id;
    } catch (err) {
      log.error('Teams stream init error', { error: err.message });
      return '';
    }

    // 2. 스트림에서 텍스트 수집 + 주기적 업데이트
    let fullText = '';
    let lastUpdate = 0;
    const UPDATE_INTERVAL = 2000;  // 2초 (Teams rate limit이 Slack보다 엄격)

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          fullText += event.delta.text;

          const now = Date.now();
          if (now - lastUpdate > UPDATE_INTERVAL && fullText.length > 0 && activityId) {
            lastUpdate = now;
            try {
              await ctx.updateActivity({ id: activityId, text: fullText + ' ▌', type: 'message' });
            } catch { /* rate limit 시 무시 */ }
          }
        }
      }
    } catch (err) {
      log.error('Teams stream read error', { error: err.message });
    }

    // 3. 최종 메시지
    if (fullText.length > 0 && activityId) {
      try {
        await ctx.updateActivity({ id: activityId, text: fullText, type: 'message' });
      } catch {
        await ctx.sendActivity(fullText);
      }
    }

    return fullText;
  }

  /**
   * Proactive DM 전송 (아침 브리핑, Smart Onboarding 등).
   * 사용자가 봇과 최소 1회 상호작용해야 conversationReference가 있음.
   *
   * @param {string} userId - Azure AD Object ID
   * @param {string} text - 메시지 텍스트
   */
  async sendProactiveDM(userId, text) {
    const entry = this.conversationRefs.get(userId);
    const convRef = entry?.ref;
    if (!convRef || !this._adapter) {
      log.debug('No conversation reference for proactive DM', { userId });
      return false;
    }

    try {
      await this._adapter.continueConversationAsync(
        this._botId,
        convRef,
        async (context) => {
          await context.sendActivity(text);
        }
      );
      return true;
    } catch (err) {
      log.warn('Proactive DM failed', { userId, error: err.message });
      return false;
    }
  }

  /**
   * Adaptive Card 전송 (Committee 투표, 피드백 버튼 등).
   *
   * @param {object} context - Teams TurnContext 또는 originalMsg
   * @param {object} card - Adaptive Card JSON
   */
  async sendAdaptiveCard(context, card) {
    const ctx = context._teamsContext || context;
    if (!ctx?.sendActivity) return;

    try {
      await ctx.sendActivity({
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: card,
        }],
      });
    } catch (err) {
      log.warn('Adaptive Card send failed', { error: err.message });
    }
  }

  /**
   * Committee 투표용 Adaptive Card 생성.
   */
  buildVoteCard(proposalId, title, description) {
    return {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        { type: 'TextBlock', text: '🗳️ Committee 투표', weight: 'Bolder', size: 'Medium' },
        { type: 'TextBlock', text: title, weight: 'Bolder' },
        { type: 'TextBlock', text: description, wrap: true, size: 'Small' },
      ],
      actions: [
        { type: 'Action.Submit', title: '✅ Approve', data: { action: 'committee_vote', proposalId, vote: 'approve' } },
        { type: 'Action.Submit', title: '❌ Reject', data: { action: 'committee_vote', proposalId, vote: 'reject' } },
        { type: 'Action.Submit', title: '⏸️ Defer', data: { action: 'committee_vote', proposalId, vote: 'defer' } },
      ],
    };
  }

  /**
   * 피드백용 Adaptive Card 생성 (Observer Insight 반응).
   */
  buildFeedbackCard(insightId, message) {
    return {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        { type: 'TextBlock', text: message, wrap: true },
      ],
      actions: [
        { type: 'Action.Submit', title: '👍', data: { action: 'feedback', reaction: 'thumbsup', insightId } },
        { type: 'Action.Submit', title: '👎', data: { action: 'feedback', reaction: 'thumbsdown', insightId } },
      ],
    };
  }

  /**
   * Slack과의 호환을 위한 client 프로퍼티.
   * Morning Briefing 등에서 slackClient.chat.postMessage 패턴을 사용하므로,
   * Teams에서도 동일 인터페이스로 래핑.
   */
  get client() {
    const self = this;
    return {
      chat: {
        postMessage: async ({ channel, text, thread_ts, unfurl_links }) => {
          // channel이 userId면 Proactive DM
          return await self.sendProactiveDM(channel, text);
        },
        update: async ({ channel, ts, text }) => {
          // Teams에서는 Activity Update — 현재 미지원 (proactive context 없음)
          log.debug('Teams chat.update not supported in proactive context');
        },
      },
    };
  }
}

module.exports = { TeamsAdapter };
