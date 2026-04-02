/**
 * slack.js — Slack Socket Mode 채널 어댑터.
 *
 * Slack 이벤트를 NormalizedMessage로 변환하여 Gateway에 전달.
 * 응답도 NormalizedMessage 기반으로 전송.
 *
 * 역할:
 * - Slack Bolt 앱 초기화 + Socket Mode 연결
 * - app_mention, message(DM), reaction_added 이벤트 처리
 * - 슬래시 커맨드 (/kpi, /search) 등록
 * - normalize(): Slack 이벤트 → NormalizedMessage 변환
 * - reply(): NormalizedMessage 기반 Slack 응답 전송
 */
const { App } = require('@slack/bolt');
const { detectChannelMentions } = require('../../core/router');
const { sanitizeFtsQuery } = require('../../shared/fts-sanitizer');

// ─── Timeout Wrapper for Slack API calls ───
// R3-BUG-4 fix: clearTimeout in finally to prevent unhandled rejection from orphaned timer.
async function withTimeout(promise, ms = 5000, label = 'Slack API') {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

class SlackAdapter {
  /**
   * @param {object} slackConfig - config.channels.slack
   * @param {object} gateway - Gateway 인스턴스
   */
  constructor(slackConfig, gateway) {
    this.gateway = gateway;
    this.type = 'slack';
    this.app = new App({
      token: slackConfig.botToken,
      appToken: slackConfig.appToken,
      socketMode: true,
    });
  }

  /**
   * Slack Bolt 시작 + 이벤트 리스너 등록.
   */
  async start() {
    // @멘션 — v3.5: coalescer를 통해 연속 메시지 배치 처리
    this.app.event('app_mention', async ({ event }) => {
      const msg = this.normalize(event, { isMention: true });
      const channelId = msg.channel.channelId;

      this.gateway.coalescer.add(channelId, false, msg, async (msgs) => {
        try {
          if (msgs.length === 1) {
            await this.gateway.onMessage(msgs[0], this);
          } else {
            // 연속 메시지 병합 — 가장 최근 메시지를 기반으로 텍스트 합산
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
            await this.gateway.onMessage(combined, this);
          }
        } catch (err) {
          console.error('[slack-adapter] Coalesced message error:', err.message);
        }
      });
    });

    // DM — v3.5: coalescer bypass (isDM=true → 즉시 처리)
    // + v4.0: Public 채널 메시지 → Observer Passive Listener
    // + BUG-3 fix: 스레드 내 후속 메시지 → Gateway 파이프라인 (봇 참여 스레드만)
    this.app.event('message', async ({ event }) => {
      if (event.subtype) return;  // 편집/삭제 무시

      if (event.channel_type === 'im') {
        // DM → Gateway 파이프라인
        const msg = this.normalize(event, { isDM: true });
        const channelId = msg.channel.channelId;
        this.gateway.coalescer.add(channelId, true, msg, async (msgs) => {
          try {
            await this.gateway.onMessage(msgs[0], this);
          } catch (err) {
            console.error('[slack-adapter] DM message error:', err.message);
          }
        });
      } else if (event.thread_ts && event.thread_ts !== event.ts) {
        // BUG-3 fix: 스레드 내 후속 메시지 (봇이 참여한 스레드인지 확인)
        try {
          // ARCH-004 fix: Add timeout to prevent hanging
          const replies = await withTimeout(
            this.app.client.conversations.replies({
              channel: event.channel,
              ts: event.thread_ts,
              limit: 5,
            }),
            5000,
            'conversations.replies'
          );
          const botParticipated = replies.messages?.some(m => m.bot_id || m.app_id);
          if (botParticipated) {
            const msg = this.normalize(event, { isThreadReply: true });
            const channelId = msg.channel.channelId;
            this.gateway.coalescer.add(channelId, false, msg, async (msgs) => {
              try {
                if (msgs.length === 1) {
                  await this.gateway.onMessage(msgs[0], this);
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
                  await this.gateway.onMessage(combined, this);
                }
              } catch (err) {
                console.error('[slack-adapter] Thread reply error:', err.message);
              }
            });
          } else {
            // 봇 미참여 스레드 → Observer
            const { getObserver } = require('../../observer');
            const observer = getObserver();
            observer.onMessage(event);
          }
        } catch (err) {
          console.error('[slack-adapter] Thread check error:', err.message);
        }
      } else {
        // Public 채널 → Observer (파이프라인 진입 안 함, 비용 $0)
        try {
          const { getObserver } = require('../../observer');
          const observer = getObserver();
          observer.onMessage(event);
        } catch { /* observer not initialized — ignore */ }
      }
    });

    // 리액션 (🤖)
    this.app.event('reaction_added', async ({ event }) => {
      if (event.reaction !== 'robot_face') return;
      try {
        // 원본 메시지 fetch
        const result = await this.app.client.conversations.history({
          channel: event.item.channel,
          latest: event.item.ts,
          inclusive: true,
          limit: 1,
        });
        const original = result.messages?.[0];
        if (!original || original.bot_id) return;

        const msg = this.normalize({
          ...original,
          channel: event.item.channel,
          user: event.user,               // 리액션 누른 사람
          channel_type: 'channel',
        }, { isReaction: true });
        await this.gateway.onMessage(msg, this);
      } catch (err) {
        console.error('[slack-adapter] Reaction fetch error:', err.message);
      }
    });

    // 슬래시 커맨드
    this.registerCommands();

    await this.app.start();
    console.log('[slack-adapter] Connected (Socket Mode)');
    return this;
  }

  /**
   * Slack 이벤트 → NormalizedMessage 변환.
   */
  normalize(event, context = {}) {
    const rawText = event.text || '';
    // @봇 멘션 태그 제거
    // BUG-5 fix: 소문자 ID 포함 + display name 포함 멘션도 제거
    const cleanText = context.isMention
      ? rawText.replace(/<@[A-Za-z0-9]+(?:\|[^>]*)?>/g, '').trim()
      : rawText;

    return {
      id: event.ts || `${Date.now()}`,
      channel: {
        type: 'slack',
        accountId: event.team || '',
        channelId: event.channel,
        threadId: event.thread_ts || undefined,
      },
      sender: {
        id: event.user || '',
        name: event.user_profile?.display_name || '',
        isBot: !!event.bot_id,
      },
      content: {
        text: cleanText,
        mentions: detectChannelMentions(rawText),
        attachments: event.files || [],
      },
      metadata: {
        timestamp: parseFloat(event.ts || '0') * 1000,
        isDM: !!context.isDM,
        isMention: !!context.isMention,
        isReaction: !!context.isReaction,
        // N-3: 개발 모드에서만 원본 이벤트 저장 (메모리 절약)
        ...(process.env.NODE_ENV !== 'production' && { raw: event }),
      },
    };
  }

  /**
   * 응답 전송.
   */
  async reply(originalMsg, text) {
    try {
      await this.app.client.chat.postMessage({
        channel: originalMsg.channel.channelId,
        text,
        thread_ts: originalMsg.channel.threadId || originalMsg.id,
      });
    } catch (err) {
      console.error('[slack-adapter] Reply error:', err.message);
    }
  }

  /**
   * 스트리밍 응답 — "입력 중..." → 점진적 업데이트 → 최종 메시지.
   *
   * @param {object} originalMsg - NormalizedMessage
   * @param {AsyncIterable} stream - Anthropic SDK stream
   * @returns {string} 최종 텍스트
   */
  async replyStream(originalMsg, stream) {
    const channel = originalMsg.channel.channelId;
    const threadTs = originalMsg.channel.threadId || originalMsg.id;

    // 1. 플레이스홀더 메시지 게시
    let posted;
    try {
      posted = await this.app.client.chat.postMessage({
        channel, thread_ts: threadTs, text: '⏳ 생각하는 중...',
      });
    } catch (err) {
      console.error('[slack-adapter] Stream init error:', err.message);
      return '';
    }

    // 2. 스트림에서 텍스트 수집 + 주기적 업데이트
    let fullText = '';
    let lastUpdate = 0;
    const UPDATE_INTERVAL = 1500;  // 1.5초마다 Slack 메시지 업데이트

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          fullText += event.delta.text;

          // 스로틀: 1.5초마다 업데이트 (Slack rate limit 방어)
          const now = Date.now();
          if (now - lastUpdate > UPDATE_INTERVAL && fullText.length > 0) {
            lastUpdate = now;
            try {
              await this.app.client.chat.update({
                channel, ts: posted.ts,
                text: fullText + ' ▌',  // 커서 표시
              });
            } catch { /* rate limit 시 무시, 다음에 재시도 */ }
          }
        }
      }
    } catch (err) {
      console.error('[slack-adapter] Stream read error:', err.message);
    }

    // 3. 최종 메시지 (커서 제거)
    if (fullText.length > 0 && posted?.ts) {
      try {
        await this.app.client.chat.update({
          channel, ts: posted.ts, text: fullText,
        });
      } catch (err) {
        // update 실패 시 새 메시지로 전송
        await this.app.client.chat.postMessage({ channel, thread_ts: threadTs, text: fullText });
      }
    }

    return fullText;
  }

  /**
   * 슬래시 커맨드 등록.
   */
  registerCommands() {
    const { getKPI } = require('../../github/webhook');
    const { semantic } = require('../../memory/manager');

    this.app.command('/effy_kpi', async ({ command, ack, respond }) => {
      await ack();
      try {
        const result = getKPI(command.text || '');
        await respond(result);
      } catch (err) {
        await respond(`KPI 조회 오류: ${err.message}`);
      }
    });

    this.app.command('/effy_search', async ({ command, ack, respond }) => {
      await ack();
      const rawQuery = command.text || '';
      if (!rawQuery) { await respond('사용법: /effy_search 검색어'); return; }

      // B-3: FTS5 새니타이저 적용 — 예약어/특수문자 안전 처리
      const { words, query: safeQuery } = sanitizeFtsQuery(rawQuery);
      if (words.length === 0) { await respond('검색어가 너무 짧거나 특수문자만 포함되어 있습니다.'); return; }

      // N-4: pool-aware 검색 (team + engineering + design — 공개 풀만)
      const publicPools = ['team', 'engineering', 'design'];
      const results = semantic.searchWithPools(safeQuery, publicPools, 5);
      if (results.length === 0) { await respond('검색 결과가 없습니다.'); return; }

      const formatted = results.map((r, i) =>
        `${i + 1}. [${r.source_type}/${r.pool_id || 'team'}] ${r.content.slice(0, 150)}... (ch: ${r.channel_id})`
      ).join('\n');
      await respond(formatted);
    });

    // /chat — DM과 동일한 1:1 대화 (채널에서도 사용 가능)
    this.app.command('/effy_chat', async ({ command, ack, respond }) => {
      await ack();
      const text = (command.text || '').trim();
      if (!text) {
        await respond('사용법: /effy_chat [메시지] — Effy와 1:1 대화. 에이전트 지정: /effy_chat @code 코드 리뷰해줘');
        return;
      }

      // WARN-3 fix: 유저+채널 기반 안정적 threadId → 세션 일관성 유지
      const stableThreadTs = `chat:${command.user_id}:${command.channel_id}`;
      const msg = this.normalize({
        text,
        user: command.user_id,
        channel: command.channel_id,
        channel_type: 'im',  // DM처럼 처리
        thread_ts: stableThreadTs,
        ts: `${Date.now() / 1000}`,
      }, { isDM: true, isMention: false });

      try {
        await this.gateway.onMessage(msg, {
          reply: async (_msg, replyText) => {
            await respond(replyText);
          },
        });
      } catch (err) {
        await respond(`처리 오류: ${err.message}`);
      }
    });

    // /committee — 위원회 멤버 관리 (invite/kick/leave/status)
    // invite/kick은 adminUsers만 가능, leave/status는 누구나
    this.app.command('/effy_committee', async ({ command, ack, respond }) => {
      await ack();

      const { config: appConfig } = require('../../config');
      const { getCommittee } = require('../../reflection');
      const committee = getCommittee();
      if (!committee) {
        await respond('위원회 모듈이 초기화되지 않았습니다.');
        return;
      }

      // BUG-5 fix: <...> 블록 내 공백을 보존하는 split 유틸리티
      const rawText = (command.text || '').trim();
      const args = rawText.match(/<[^>]+>|\S+/g) || [];
      const subCmd = args[0] || 'status';
      const userId = command.user_id;
      const adminUsers = appConfig.gateway?.adminUsers || [];
      const isAdmin = adminUsers.length === 0 || adminUsers.includes(userId);

      switch (subCmd) {
        case 'invite': {
          // 관리자 전용: /committee invite @user [가중치]
          if (!isAdmin) {
            await respond('`/effy_committee invite`는 관리자만 사용할 수 있습니다.');
            return;
          }

          // BUG-5 fix: command.text에서 직접 멘션 추출 (공백 포함 display name 대응)
          const mentionMatch = rawText.match(/<@([A-Za-z0-9]+)(?:\|[^>]*)?>/);
          if (!mentionMatch) {
            await respond('사용법: `/effy_committee invite @사용자 [가중치]`\n예: `/effy_committee invite @drake 2`');
            return;
          }

          const targetUserId = mentionMatch[1];
          // 가중치: 멘션 뒤의 숫자 추출
          const weightMatch = rawText.match(/<@[^>]+>\s*(\d+)/);
          const weight = parseInt(weightMatch?.[1], 10) || 2;

          // Slack API로 유저 이름 조회
          let targetName = targetUserId;
          try {
            const userInfo = await this.app.client.users.info({ user: targetUserId });
            targetName = userInfo.user?.profile?.display_name || userInfo.user?.real_name || targetUserId;
          } catch (_) { /* best-effort */ }

          const result = committee.addHumanMember({
            platformUserId: targetUserId,
            name: targetName,
            weight: Math.min(Math.max(weight, 1), 5),
          });
          await respond(result.message);

          // 초대된 유저에게 DM 알림
          if (result.added) {
            try {
              await this.app.client.chat.postMessage({
                channel: targetUserId,
                text: `📋 Effy 위원회에 초대되었습니다! (가중치 ×${Math.min(Math.max(weight, 1), 5)})\n탈퇴: \`/effy_committee leave\` | 현황: \`/effy_committee status\``,
              });
            } catch (_) { /* best-effort DM */ }
          }
          break;
        }
        case 'kick': {
          // 관리자 전용: /committee kick @user
          if (!isAdmin) {
            await respond('`/effy_committee kick`는 관리자만 사용할 수 있습니다.');
            return;
          }

          // BUG-5 fix: rawText에서 직접 멘션 추출
          const kickMatch = rawText.match(/<@([A-Za-z0-9]+)(?:\|[^>]*)?>/);
          if (!kickMatch) {
            await respond('사용법: `/effy_committee kick @사용자`');
            return;
          }

          const result = committee.removeHumanMember(kickMatch[1]);
          await respond(result.message);
          break;
        }
        case 'leave': {
          // 본인 탈퇴 — 누구나 가능
          const result = committee.removeHumanMember(userId);
          await respond(result.message);
          break;
        }
        case 'status':
        default: {
          // 현황 조회 — 누구나 가능
          const status = committee.getMemberStatus();
          const aiList = status.ai.map(m => `  🤖 ${m.id} (×${m.weight})`).join('\n');
          const humanList = status.human.length > 0
            ? status.human.map(m => `  👤 ${m.name} (×${m.weight})`).join('\n')
            : '  (없음)';
          const pending = committee.getPendingProposals();

          const adminCmds = isAdmin
            ? `\`/effy_committee invite @사용자 [가중치]\` | \`/effy_committee kick @사용자\` | `
            : '';

          const text = [
            `*📋 위원회 현황*`,
            `상태: ${status.enabled ? '✅ 활성' : '❌ 비활성'}`,
            `정족수: ${status.quorum}w (총 최대 ${status.totalMaxWeight}w)`,
            ``,
            `*AI 멤버:*`,
            aiList,
            ``,
            `*인간 멤버:*`,
            humanList,
            ``,
            `*대기 안건:* ${pending.length}건`,
            ...(pending.length > 0 ? pending.slice(0, 3).map(p =>
              `  • ${p.title} (${p.type}, by ${p.proposedBy})`
            ) : []),
            ``,
            `사용법: ${adminCmds}\`/effy_committee leave\` | \`/effy_committee status\``,
          ].join('\n');

          await respond(text);
          break;
        }
      }
    });

    // /agent — 에이전트 리로드 (관리자 전용)
    this.app.command('/effy_agent', async ({ command, ack, respond }) => {
      await ack();

      // SF-6: 관리자 권한 체크 — config.gateway.adminUsers에 등록된 유저만 허용
      const { config } = require('../../config');
      const adminUsers = config.gateway?.adminUsers || [];
      if (adminUsers.length > 0 && !adminUsers.includes(command.user_id)) {
        await respond('이 커맨드는 관리자만 사용할 수 있습니다.');
        return;
      }

      const args = (command.text || '').trim().split(/\s+/).filter(a => a.length > 0);
      if (args.length === 0) {
        const agents = this.gateway.agentLoader.listAgents();
        await respond(`등록된 에이전트: ${agents.join(', ')}\n사용법: /effy_agent reload [agent_id]`);
        return;
      }

      const cmd = args[0];
      if (cmd === 'reload') {
        const agentId = args[1] || null;
        if (agentId && !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
          await respond(`유효하지 않은 에이전트 ID: ${agentId}`);
          return;
        }
        this.gateway.agentLoader.invalidate(agentId);
        await respond(`에이전트 캐시 ${agentId ? `'${agentId}'` : '전체'} 리로드 완료.`);
      } else {
        const agents = this.gateway.agentLoader.listAgents();
        await respond(`등록된 에이전트: ${agents.join(', ')}\n사용법: /effy_agent reload [agent_id]`);
      }
    });

    // /dashboard — Mission Control 대시보드 링크 (Admin 전용)
    this.app.command('/effy_dashboard', async ({ command, ack, respond }) => {
      await ack();

      const { isAdmin } = require('../../shared/auth');
      if (!isAdmin(command.user_id)) {
        await respond('`/effy_dashboard`는 관리자만 사용할 수 있습니다.');
        return;
      }

      const { config: appConfig } = require('../../config');
      const port = appConfig.github?.webhookPort || appConfig.gateway?.port || 3100;

      // 외부 URL 우선 (admin이 config에 설정), 없으면 LAN IP 자동 감지
      const externalUrl = appConfig.dashboard?.externalUrl;
      let dashUrl;
      if (externalUrl) {
        dashUrl = `${externalUrl.replace(/\/+$/, '')}/dashboard`;
      } else {
        const { getLanIp } = require('../../shared/utils');
        dashUrl = `http://${getLanIp()}:${port}/dashboard`;
      }

      await respond({
        response_type: 'ephemeral',  // 본인에게만 보임
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Effy Mission Control* :bar_chart:\nAgent 상태, 비용 추이, 메모리, 세션을 실시간으로 확인할 수 있습니다.',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Open Dashboard', emoji: true },
                url: dashUrl,
                style: 'primary',
                action_id: 'open_dashboard',
              },
            ],
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `_${dashUrl}_` },
            ],
          },
        ],
      });
    });

    // /effy — Observer 제어 (Admin 전용)
    this.app.command('/effy', async ({ command, ack, respond }) => {
      await ack();

      const { isAdmin } = require('../../shared/auth');
      if (!isAdmin(command.user_id)) {
        await respond('`/effy`는 관리자만 사용할 수 있습니다.');
        return;
      }

      // NEW-08 fix: Slack 멘션(<#C...>, <@U...>)을 깨뜨리지 않는 파싱
      const effyRawText = (command.text || '').trim();
      const args = effyRawText.match(/<[^>]+>|\S+/g) || [];
      const sub = args[0] || 'status';

      const { getObserver } = require('../../observer');
      const observer = getObserver();
      const { requestChange, approveChange, rejectChange, listPending, getSeverity } = require('../../observer/change-control');

      switch (sub) {
        case 'status': {
          const stats = observer.getStats();
          await respond(`*Effy Observer Status*\n\`\`\`${JSON.stringify(stats, null, 2).slice(0, 2000)}\`\`\``);
          break;
        }

        case 'observe': {
          // /effy observe on|off [#channel]
          const toggle = args[1];
          // NEW-08 fix: <#C1234|channel-name> 형태 안전 파싱
          const observeChRaw = args[2] || '';
          const observeChMatch = observeChRaw.match(/<#([A-Za-z0-9]+)(?:\|[^>]*)?>/);
          const targetCh = observeChMatch ? observeChMatch[1] : (observeChRaw || command.channel_id);

          if (toggle === 'on') {
            const change = requestChange(
              getSeverity('channel_observe_add'), 'channel_observe_add',
              `채널 ${targetCh} 관찰 활성화`, { channelId: targetCh }, command.user_id,
            );
            if (change.status === 'approved') {
              observer.listener?.addChannel(targetCh);
              await respond(`✅ <#${targetCh}> 관찰이 활성화되었습니다.`);
            } else {
              await respond(`⏳ 변경 승인 대기 중: \`${change.id}\` (Admin 승인 필요)\n\`/effy approve ${change.id}\`로 승인`);
            }
          } else if (toggle === 'off') {
            const change = requestChange(
              getSeverity('channel_observe_remove'), 'channel_observe_remove',
              `채널 ${targetCh} 관찰 비활성화`, { channelId: targetCh }, command.user_id,
            );
            if (change.status === 'approved') {
              observer.listener?.removeChannel(targetCh);
              await respond(`🔇 <#${targetCh}> 관찰이 비활성화되었습니다.`);
            } else {
              await respond(`⏳ 변경 승인 대기 중: \`${change.id}\`\n\`/effy approve ${change.id}\`로 승인`);
            }
          } else {
            await respond('사용법: `/effy observe on|off [#channel]`');
          }
          break;
        }

        case 'level': {
          // /effy level 1|2|3 [#channel]
          const newLevel = parseInt(args[1]);
          // NEW-08 fix: <#C1234|channel-name> 형태 안전 파싱
          const levelChRaw = args[2] || '';
          const levelChMatch = levelChRaw.match(/<#([A-Za-z0-9]+)(?:\|[^>]*)?>/);
          const targetCh = levelChMatch ? levelChMatch[1] : (levelChRaw || command.channel_id);
          if (![1, 2, 3].includes(newLevel)) {
            await respond('사용법: `/effy level 1|2|3 [#channel]`\n1=Silent, 2=Nudge, 3=Active');
            break;
          }
          const change = requestChange(
            getSeverity('proactive_level_change'), 'proactive_level_change',
            `채널 ${targetCh} Level → ${newLevel}`, { channelId: targetCh, level: newLevel }, command.user_id,
          );
          if (change.status === 'approved') {
            observer.proactive?.setChannelLevel(targetCh, newLevel);
            await respond(`✅ <#${targetCh}> Proactive Level → ${newLevel} (${['', 'Silent', 'Nudge', 'Active'][newLevel]})`);
          } else {
            await respond(`⏳ 변경 승인 대기 중: \`${change.id}\`\n\`/effy approve ${change.id}\`로 승인`);
          }
          break;
        }

        case 'approve': {
          const changeId = args[1];
          if (!changeId) { await respond('사용법: `/effy approve CHG-XXXX`'); break; }
          const result = approveChange(changeId, command.user_id);
          if (result.success) {
            // 승인된 변경 실행
            const ch = result.change;
            if (ch.type === 'channel_observe_add') observer.listener?.addChannel(ch.payload.channelId);
            if (ch.type === 'channel_observe_remove') observer.listener?.removeChannel(ch.payload.channelId);
            if (ch.type === 'proactive_level_change') observer.proactive?.setChannelLevel(ch.payload.channelId, ch.payload.level);
            await respond(`✅ \`${changeId}\` 승인 완료: ${ch.description}`);
          } else {
            await respond(`❌ ${result.error}`);
          }
          break;
        }

        case 'reject': {
          const changeId = args[1];
          const reason = args.slice(2).join(' ') || '';
          if (!changeId) { await respond('사용법: `/effy reject CHG-XXXX [사유]`'); break; }
          const result = rejectChange(changeId, command.user_id, reason);
          await respond(result.success ? `🚫 \`${changeId}\` 거부됨.` : `❌ ${result.error}`);
          break;
        }

        case 'pending': {
          const pending = listPending();
          if (pending.length === 0) {
            await respond('대기 중인 변경 요청이 없습니다.');
          } else {
            const lines = pending.map(c => `• \`${c.id}\` [${c.severity}] ${c.description} (by ${c.requestedBy})`);
            await respond(`*대기 중인 변경 (${pending.length}건)*\n${lines.join('\n')}`);
          }
          break;
        }

        default:
          await respond([
            '*Effy Observer Commands*',
            '`/effy status` — Observer 상태 조회',
            '`/effy observe on|off [#ch]` — 채널 관찰 토글',
            '`/effy level 1|2|3 [#ch]` — 제안 Level 변경',
            '`/effy approve CHG-XXXX` — 변경 승인',
            '`/effy reject CHG-XXXX [사유]` — 변경 거부',
            '`/effy pending` — 대기 중인 변경 조회',
          ].join('\n'));
      }
    });
  }

  /**
   * Slack WebClient 참조 (도구 실행 시 필요).
   */
  get client() {
    return this.app.client;
  }
}

module.exports = { SlackAdapter };
