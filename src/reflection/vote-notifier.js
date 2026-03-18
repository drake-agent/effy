/**
 * vote-notifier.js — 위원회 투표 알림 추상화 레이어.
 *
 * 플랫폼 독립적인 인터페이스로, 인간 멤버에게 투표 요청을 전달하고
 * 투표 결과를 수집하는 역할을 한다.
 *
 * 지원 플랫폼 (어댑터 패턴):
 * - SlackVoteNotifier   — Slack Block Kit 버튼
 * - (확장) DiscordVoteNotifier — Discord Interactive Components
 * - (확장) WebhookVoteNotifier — 범용 Webhook (외부 시스템 연동)
 *
 * 사용법:
 *   const notifier = new SlackVoteNotifier(slackClient);
 *   committee = new Committee({ ..., notifier });
 */
const { sanitizeForPrompt } = require('./sanitize');
const { createLogger } = require('../shared/logger');

const log = createLogger('reflection:vote-notifier');

// ═══════════════════════════════════════════════════════
// 추상 VoteNotifier (인터페이스 정의)
// ═══════════════════════════════════════════════════════

class VoteNotifier {
  /** @returns {string} 플랫폼 식별자 (slack, discord, webhook, ...) */
  get platform() { return 'abstract'; }

  /**
   * 인간 멤버에게 투표 요청을 전송한다.
   *
   * @param {object} member   - { id, platformUserId, weight, name }
   * @param {object} proposal - { id, title, description, type, proposedBy }
   * @param {object} options  - { timeoutMs, voteOptions }
   * @returns {Promise<void>}
   */
  async sendVoteRequest(member, proposal, options = {}) {
    throw new Error('sendVoteRequest() must be implemented by subclass');
  }

  /**
   * 투표 완료 확인 메시지를 전송한다.
   *
   * @param {object} member - { id, platformUserId, name }
   * @param {string} vote   - 'approve' | 'reject' | 'defer'
   * @param {string} message - 확인 메시지
   * @returns {Promise<void>}
   */
  async sendVoteConfirmation(member, vote, message) {
    throw new Error('sendVoteConfirmation() must be implemented by subclass');
  }

  /**
   * 의결 결과를 인간 멤버 전원에게 알린다. (선택적 구현)
   *
   * @param {Array<object>} members  - 인간 멤버 목록
   * @param {object} proposal        - 안건
   * @param {object} decision        - 의결 결과 { status, summary }
   * @returns {Promise<void>}
   */
  async broadcastDecision(members, proposal, decision) {
    // 기본: no-op (서브클래스에서 오버라이드 가능)
  }

  /**
   * 플랫폼별 액션 핸들러를 등록한다.
   * Slack: app.action() 바인딩
   * Discord: interaction handler 바인딩
   *
   * @param {object} platformApp  - 플랫폼 앱 인스턴스 (Slack Bolt App, Discord Client, etc.)
   * @param {Function} onVote     - 투표 콜백: (proposalId, platformUserId, vote) => { accepted, message }
   */
  registerActionHandlers(platformApp, onVote) {
    throw new Error('registerActionHandlers() must be implemented by subclass');
  }

  /**
   * 정리.
   */
  destroy() {
    // 기본: no-op
  }
}

// ═══════════════════════════════════════════════════════
// Slack VoteNotifier (Block Kit 버튼 기반)
// ═══════════════════════════════════════════════════════

class SlackVoteNotifier extends VoteNotifier {
  /**
   * @param {object} slackClient - Slack WebClient (@slack/bolt의 app.client)
   */
  constructor(slackClient) {
    super();
    this._client = slackClient;
  }

  get platform() { return 'slack'; }

  async sendVoteRequest(member, proposal, options = {}) {
    if (!this._client) throw new Error('Slack client not available');

    const timeoutMin = Math.round((options.timeoutMs || 3600000) / 60000);

    await this._client.chat.postMessage({
      channel: member.platformUserId,
      text: `[위원회 투표] ${proposal.title}`,
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📋 위원회 투표 요청' },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*${proposal.title}*`,
              `유형: \`${proposal.type}\` | 제안: ${proposal.proposedBy}`,
              `> ${proposal.description.slice(0, 300)}`,
            ].join('\n'),
          },
        },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `투표 가중치: *×${member.weight}* | 타임아웃: ${timeoutMin}분 | ID: \`${proposal.id}\``,
          }],
        },
        {
          type: 'actions',
          block_id: `committee_vote:${proposal.id}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '✅ 찬성 (approve)' },
              action_id: 'committee_approve',
              value: proposal.id,
              style: 'primary',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '❌ 반대 (reject)' },
              action_id: 'committee_reject',
              value: proposal.id,
              style: 'danger',
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: '⏸ 보류 (defer)' },
              action_id: 'committee_defer',
              value: proposal.id,
            },
          ],
        },
      ],
    });

    log.info(`[slack] Vote DM sent to ${member.name} (${member.platformUserId}) for ${proposal.id}`);
  }

  async sendVoteConfirmation(member, vote, message) {
    if (!this._client) return;

    const emoji = vote === 'approve' ? '✅' : vote === 'reject' ? '❌' : '⏸';
    try {
      await this._client.chat.postMessage({
        channel: member.platformUserId,
        text: `${emoji} 투표 완료: *${vote}* — ${message}`,
      });
    } catch (err) {
      log.warn(`[slack] Vote confirmation DM failed: ${err.message}`);
    }
  }

  async broadcastDecision(members, proposal, decision) {
    if (!this._client) return;

    // SEC-A fix: Slack mrkdwn 인젝션 방지 — title/summary sanitize
    const safeTitle = sanitizeForPrompt(proposal.title, 200);
    const safeSummary = sanitizeForPrompt(decision.summary, 500);
    const emoji = decision.status === 'approved' ? '🟢' : decision.status === 'rejected' ? '🔴' : '🟡';
    const text = `${emoji} *위원회 의결 완료*\n안건: ${safeTitle}\n결과: ${decision.status}\n${safeSummary}`;

    for (const member of members) {
      try {
        await this._client.chat.postMessage({
          channel: member.platformUserId,
          text,
        });
      } catch (err) {
        log.warn(`[slack] Decision broadcast failed for ${member.name}: ${err.message}`);
      }
    }
  }

  registerActionHandlers(slackApp, onVote) {
    if (!slackApp) return;

    for (const actionId of ['committee_approve', 'committee_reject', 'committee_defer']) {
      slackApp.action(actionId, async ({ body, ack }) => {
        await ack();

        const vote = actionId.replace('committee_', '');
        const proposalId = body.actions?.[0]?.value;
        const slackUserId = body.user?.id;

        if (!proposalId || !slackUserId) return;

        // BUG-D fix: onVote가 향후 비동기로 변경될 수 있으므로 await
        const result = await Promise.resolve(onVote(proposalId, slackUserId, vote));

        // DM 확인
        const member = { platformUserId: slackUserId };
        if (result.accepted) {
          await this.sendVoteConfirmation(member, vote, result.message);
        } else {
          try {
            await this._client.chat.postMessage({
              channel: slackUserId,
              text: `⚠️ ${result.message}`,
            });
          } catch (_) { /* best-effort */ }
        }
      });
    }

    log.info('[slack] Committee vote action handlers registered');
  }
}

// ═══════════════════════════════════════════════════════
// Webhook VoteNotifier (범용 HTTP Webhook 기반)
// ═══════════════════════════════════════════════════════

class WebhookVoteNotifier extends VoteNotifier {
  /**
   * @param {object} options
   * @param {string} options.url       - 투표 요청을 보낼 Webhook URL
   * @param {string} options.secret    - HMAC 서명용 시크릿 (선택)
   * @param {object} options.headers   - 추가 헤더 (선택)
   */
  constructor({ url, secret, headers = {} } = {}) {
    super();
    this._url = url;
    this._secret = secret;
    this._headers = headers;
  }

  get platform() { return 'webhook'; }

  async sendVoteRequest(member, proposal, options = {}) {
    if (!this._url) throw new Error('Webhook URL not configured');

    const payload = {
      type: 'vote_request',
      proposalId: proposal.id,
      title: proposal.title,
      description: proposal.description.slice(0, 500),
      proposalType: proposal.type,
      proposedBy: proposal.proposedBy,
      member: { id: member.id, name: member.name, weight: member.weight },
      timeoutMs: options.timeoutMs,
      voteOptions: options.voteOptions || ['approve', 'reject', 'defer'],
    };

    const response = await fetch(this._url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this._headers,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }

    log.info(`[webhook] Vote request sent for ${proposal.id} to ${member.name}`);
  }

  async sendVoteConfirmation(member, vote, message) {
    // Webhook은 확인 메시지를 별도로 보내지 않음 (API 응답으로 대체)
    log.info(`[webhook] Vote confirmation: ${member.name} → ${vote}`);
  }

  registerActionHandlers(expressApp, onVote) {
    if (!expressApp) return;

    // Express 라우트로 투표 수신
    expressApp.post('/api/committee/vote', (req, res) => {
      const { proposalId, userId, vote, reasoning } = req.body || {};

      if (!proposalId || !userId || !vote) {
        return res.status(400).json({ error: 'Missing required fields: proposalId, userId, vote' });
      }

      const result = onVote(proposalId, userId, vote, reasoning);
      res.json(result);
    });

    log.info('[webhook] Committee vote endpoint registered: POST /api/committee/vote');
  }
}

module.exports = { VoteNotifier, SlackVoteNotifier, WebhookVoteNotifier };
