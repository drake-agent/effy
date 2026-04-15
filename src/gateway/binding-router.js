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
 * ⑥ [P2 확장] CapabilityRegistry 폴백 — 디폴트로 떨어지면 학습된 라우팅 적용
 */

class BindingRouter {
  /**
   * @param {Array} bindings - config.bindings
   * @param {string} defaultAgentId - default: true인 에이전트 ID
   * @param {Object} [opts] - { capabilityRegistry, logger }
   */
  constructor(bindings = [], defaultAgentId = 'general', opts = {}) {
    // 우선순위별 분류
    this.peerBindings = [];
    this.channelBindings = [];
    this.accountBindings = [];
    this.typeBindings = [];
    this.defaultAgentId = defaultAgentId;

    // P2: CapabilityRegistry 주입 (optional)
    this.capabilityRegistry = opts.capabilityRegistry || null;
    this.log = opts.logger || null;

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
   * NormalizedMessage → 바인딩 매칭 (동기).
   * @param {object} msg - NormalizedMessage
   * @returns {{ agentId: string, binding: object|null, source: string }}
   */
  match(msg) {
    const senderId = msg.sender?.id;
    const channelId = msg.channel?.channelId;
    const accountId = msg.channel?.accountId;
    const channelType = msg.channel?.type;

    // ① peer match
    for (const b of this.peerBindings) {
      if (b.match.peer === senderId) {
        return { agentId: b.agentId, binding: b, source: 'peer' };
      }
    }

    // ② channelId match
    for (const b of this.channelBindings) {
      if (b.match.channelId === channelId) {
        if (b.match.channel && b.match.channel !== channelType) continue;
        return { agentId: b.agentId, binding: b, source: 'channelId' };
      }
    }

    // ③ accountId match
    for (const b of this.accountBindings) {
      if (b.match.accountId === accountId) {
        return { agentId: b.agentId, binding: b, source: 'accountId' };
      }
    }

    // ④ channel type match
    for (const b of this.typeBindings) {
      if (b.match.channel === channelType) {
        return { agentId: b.agentId, binding: b, source: 'channelType' };
      }
    }

    // ⑤ default
    return { agentId: this.defaultAgentId, binding: null, source: 'default' };
  }

  /**
   * P2: 비동기 매칭 — default로 떨어진 경우 CapabilityRegistry 폴백 적용.
   * 기존 match()의 결과가 default일 때만 레지스트리 조회.
   *
   * @param {object} msg - NormalizedMessage
   * @returns {Promise<{ agentId: string, binding: object|null, source: string }>}
   */
  async matchAsync(msg) {
    const staticHit = this.match(msg);

    // CapabilityRegistry 없거나 config 매칭 성공 시 바로 반환
    if (!this.capabilityRegistry || staticHit.source !== 'default') {
      return staticHit;
    }

    const channelId = msg.channel?.channelId;
    const senderId = msg.sender?.id;

    // ⑥-1: 채널의 active agent 있으면 선택 (weight > 2.0)
    try {
      const channelAgents = await this.capabilityRegistry.getAgentsForChannel(channelId);
      const strong = channelAgents.find(a => a.weight > 2.0);
      if (strong) {
        if (this.log) this.log.info('Routing (learned-channel)', { agentId: strong.agentId, channelId, weight: strong.weight });
        return { agentId: strong.agentId, binding: null, source: 'learned-channel' };
      }
    } catch { /* graceful degradation */ }

    // ⑥-2: 사용자 최근 라우팅 (30분 이내)
    try {
      const recentAgent = await this.capabilityRegistry.getRecentAgentForUser(senderId, 30);
      if (recentAgent) {
        if (this.log) this.log.info('Routing (learned-user)', { agentId: recentAgent, userId: senderId });
        return { agentId: recentAgent, binding: null, source: 'learned-user' };
      }
    } catch { /* graceful degradation */ }

    // ⑥-3: 폴백 — default
    return staticHit;
  }
}

module.exports = { BindingRouter };
