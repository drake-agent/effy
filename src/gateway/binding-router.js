/**
 * binding-router.js — 바인딩 기반 에이전트 라우팅.
 *
 * effy.config.yaml의 bindings 섹션을 기반으로
 * 메시지 → 에이전트 매핑을 결정한다.
 *
 * 매칭 우선순위:
 * ① peer (특정 유저 DM)
 * ② channelId (특정 채널)
 * ③ accountId (Slack workspace)
 * ④ channel type (slack/discord/webhook)
 * ⑤ default agent
 */

class BindingRouter {
  /**
   * @param {Array} bindings - config.bindings
   * @param {string} defaultAgentId - default: true인 에이전트 ID
   */
  constructor(bindings = [], defaultAgentId = 'general') {
    // 우선순위별 분류
    this.peerBindings = [];
    this.channelBindings = [];
    this.accountBindings = [];
    this.typeBindings = [];
    this.defaultAgentId = defaultAgentId;

    for (const b of bindings) {
      const m = b.match || {};
      if (m.peer) {
        this.peerBindings.push(b);
      } else if (m.channelId) {
        this.channelBindings.push(b);
      } else if (m.accountId) {
        this.accountBindings.push(b);
      } else if (m.channel) {
        this.typeBindings.push(b);
      }
    }
  }

  /**
   * NormalizedMessage → 바인딩 매칭.
   * @param {object} msg - NormalizedMessage
   * @returns {{ agentId: string, binding: object|null }}
   */
  match(msg) {
    const senderId = msg.sender?.id;
    const channelId = msg.channel?.channelId;
    const accountId = msg.channel?.accountId;
    const channelType = msg.channel?.type;

    // ① peer match
    for (const b of this.peerBindings) {
      if (b.match.peer === senderId) {
        return { agentId: b.agentId, binding: b };
      }
    }

    // ② channelId match
    for (const b of this.channelBindings) {
      if (b.match.channelId === channelId) {
        // channel type도 지정되었으면 둘 다 매칭
        if (b.match.channel && b.match.channel !== channelType) continue;
        return { agentId: b.agentId, binding: b };
      }
    }

    // ③ accountId match
    for (const b of this.accountBindings) {
      if (b.match.accountId === accountId) {
        return { agentId: b.agentId, binding: b };
      }
    }

    // ④ channel type match (가장 넓은 범위)
    for (const b of this.typeBindings) {
      if (b.match.channel === channelType) {
        return { agentId: b.agentId, binding: b };
      }
    }

    // ⑤ default
    return { agentId: this.defaultAgentId, binding: null };
  }
}

module.exports = { BindingRouter };
