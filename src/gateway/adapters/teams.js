/**
 * teams.js — Microsoft Teams Bot Framework 채널 어댑터.
 *
 * Teams 이벤트를 NormalizedMessage로 변환하여 Gateway에 전달.
 *
 * 역할:
 * - Bot Framework SDK 초기화 + HTTP endpoint
 * - message, conversationUpdate 이벤트 처리
 * - normalize(): Teams Activity → NormalizedMessage 변환
 * - reply(): NormalizedMessage 기반 Teams 응답 전송
 *
 * 의존성: botbuilder (Microsoft Bot Framework SDK v4)
 */
const { createLogger } = require('../../shared/logger');

const log = createLogger('adapter:teams');

class TeamsAdapter {
  /**
   * @param {object} teamsConfig - config.channels.teams
   * @param {object} gateway - Gateway 인스턴스
   */
  constructor(teamsConfig, gateway) {
    this.gateway = gateway;
    this.type = 'teams';
    this.appId = teamsConfig.appId;
    this.appPassword = teamsConfig.appPassword;
    this.port = teamsConfig.port || 3979;

    // Bot Framework SDK는 lazy require (선택적 의존성)
    this._adapter = null;
    this._server = null;
  }

  /**
   * Teams Bot Framework 시작.
   */
  async start() {
    let BotFrameworkAdapter, TurnContext;
    try {
      const bf = require('botbuilder');
      BotFrameworkAdapter = bf.BotFrameworkAdapter;
      TurnContext = bf.TurnContext;
    } catch (err) {
      log.error('botbuilder 패키지 미설치. npm install botbuilder 실행 필요', { error: err.message });
      throw new Error('Teams adapter requires "botbuilder" package. Install with: npm install botbuilder');
    }

    this._adapter = new BotFrameworkAdapter({
      appId: this.appId,
      appPassword: this.appPassword,
    });

    // 에러 핸들러
    this._adapter.onTurnError = async (context, error) => {
      log.error('Teams turn error', { error: error.message, conversationId: context.activity?.conversation?.id });
      try {
        await context.sendActivity('처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
      } catch (sendErr) {
        log.error('Failed to send error message', { error: sendErr.message });
      }
    };

    // HTTP 서버 시작
    const http = require('http');
    const express = require('express');
    const app = express();
    app.use(express.json());

    app.post('/api/messages', async (req, res) => {
      try {
        await this._adapter.process(req, res, async (context) => {
          await this._onMessage(context);
        });
      } catch (err) {
        log.error('Message processing failed', { error: err.message });
        res.status(500).send('Internal Server Error');
      }
    });

    // Health check endpoint
    app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', adapter: 'teams', uptime: process.uptime() });
    });

    this._server = app.listen(this.port, () => {
      log.info(`Teams adapter started on port ${this.port}`);
    });
  }

  /**
   * Teams 메시지 수신 처리.
   * @private
   */
  async _onMessage(context) {
    const activity = context.activity;

    if (activity.type === 'message' && activity.text) {
      const msg = this.normalize(activity);

      // Coalescer를 통해 Gateway로 전달
      const channelId = msg.channel.channelId;
      this.gateway.coalescer.add(channelId, false, msg, async (msgs) => {
        try {
          if (msgs.length === 1) {
            await this.gateway.onMessage(msgs[0], this, { _teamsContext: context });
          } else {
            const combined = {
              ...msgs[msgs.length - 1],
              content: {
                ...msgs[msgs.length - 1].content,
                text: msgs.map(m => m.content.text).filter(t => t).join('\n'),
                attachments: msgs.flatMap(m => m.content.attachments || []),
              },
              metadata: {
                ...msgs[msgs.length - 1].metadata,
                coalescedCount: msgs.length,
              },
            };
            await this.gateway.onMessage(combined, this, { _teamsContext: context });
          }
        } catch (err) {
          log.error('Coalesced message error', { error: err.message });
        }
      });
    }

    // conversationUpdate: 봇이 추가되었을 때 인사
    if (activity.type === 'conversationUpdate' && activity.membersAdded) {
      for (const member of activity.membersAdded) {
        if (member.id !== activity.recipient.id) {
          try {
            await context.sendActivity('안녕하세요! Effy AI 어시스턴트입니다. 무엇을 도와드릴까요?');
          } catch (err) {
            log.error('Welcome message failed', { error: err.message });
          }
        }
      }
    }
  }

  /**
   * Teams Activity → NormalizedMessage 변환.
   * @param {object} activity - Teams Bot Framework Activity
   * @returns {object} NormalizedMessage
   */
  normalize(activity) {
    // 멘션 텍스트 제거 (봇 이름)
    let text = activity.text || '';
    if (activity.entities) {
      for (const entity of activity.entities) {
        if (entity.type === 'mention' && entity.mentioned?.id === this.appId) {
          text = text.replace(entity.text, '').trim();
        }
      }
    }

    // 첨부파일 변환
    const attachments = (activity.attachments || []).map(att => ({
      type: att.contentType || 'unknown',
      name: att.name || '',
      url: att.contentUrl || att.content?.downloadUrl || '',
    }));

    const conversationId = activity.conversation?.id || '';
    const threadId = activity.conversation?.isGroup
      ? activity.replyToId || null
      : null;

    return {
      id: activity.id,
      channel: {
        type: 'teams',
        channelId: conversationId,
        channelName: activity.channelData?.channel?.name || activity.conversation?.name || 'teams-dm',
        threadId,
      },
      user: {
        userId: activity.from?.id || 'unknown',
        username: activity.from?.name || 'unknown',
        displayName: activity.from?.name || '',
      },
      content: {
        text,
        attachments,
      },
      metadata: {
        timestamp: new Date(activity.timestamp || Date.now()).getTime(),
        isMention: true,
        isDM: !activity.conversation?.isGroup,
        teamsConversationType: activity.conversation?.conversationType || 'personal',
        tenantId: activity.channelData?.tenant?.id || '',
      },
    };
  }

  /**
   * NormalizedMessage 기반 Teams 응답.
   * @param {object} message - NormalizedMessage
   * @param {string} text - 응답 텍스트
   * @param {object} [opts]
   */
  async reply(message, text, opts = {}) {
    const teamsContext = opts._teamsContext;

    if (!teamsContext) {
      log.warn('Teams context not available for reply', { messageId: message.id });
      return;
    }

    try {
      // 긴 텍스트 분할 (Teams 4096자 제한)
      const MAX_LENGTH = 4000;
      if (text.length <= MAX_LENGTH) {
        await teamsContext.sendActivity(text);
      } else {
        const chunks = [];
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
        for (const chunk of chunks) {
          await teamsContext.sendActivity(chunk);
        }
      }
    } catch (err) {
      log.error('Teams reply failed', { error: err.message, messageId: message.id });
    }
  }

  /**
   * 어댑터 종료.
   */
  async stop() {
    if (this._server) {
      return new Promise((resolve) => {
        this._server.close(() => {
          log.info('Teams adapter stopped');
          resolve();
        });
      });
    }
  }
}

module.exports = { TeamsAdapter };
