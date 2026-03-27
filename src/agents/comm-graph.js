/**
 * comm-graph.js — 에이전트 커뮤니케이션 그래프 (SpaceBot 차용).
 *
 * 에이전트 간 방향성 있는 통신 링크를 정의.
 * Gateway를 통한 간접 통신에서 에이전트 직접 메시징으로 전환.
 *
 * 링크 타입:
 * - hierarchical: 상위 → 하위 (관리 관계)
 * - peer: 동등한 수준 (양방향)
 * - one_way: 단방향 (발신자만 개시 가능, 수신자는 기존 스레드에서만 응답)
 *
 * 메시지 라우팅:
 * - send_agent_message 도구로 에이전트 간 직접 메시지
 * - 링크가 없으면 통신 불가 (격리)
 * - 조직 계층 반영 가능
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('agent:comm-graph');

const LINK_TYPES = ['hierarchical', 'peer', 'one_way'];

class AgentCommGraph {
  constructor() {
    /** @type {Map<string, Map<string, CommLink>>} - from → Map<to, link> */
    this.links = new Map();

    /** @type {Map<string, AgentNode>} */
    this.agents = new Map();

    /** @type {Array<{ from, to, message, timestamp, threadId }>} */
    this.messageLog = [];
    this.maxLogSize = 500;

    /** @type {Map<string, Set<string>>} - threadId → Set<linkKey> (one_way 스레드 인덱스) */
    this._threadIndex = new Map();
  }

  /**
   * 에이전트 노드 등록.
   * @param {string} agentId
   * @param {Object} [metadata] - { role, capabilities, level }
   */
  registerAgent(agentId, metadata = {}) {
    this.agents.set(agentId, {
      agentId,
      role: metadata.role || 'agent',
      capabilities: metadata.capabilities || [],
      level: metadata.level || 0, // 조직 레벨 (0=최상위)
      registeredAt: Date.now(),
    });
    log.debug('Agent registered', { agentId, role: metadata.role });
  }

  /**
   * 에이전트 간 링크 생성.
   * @param {string} from - 발신 에이전트
   * @param {string} to - 수신 에이전트
   * @param {string} type - 링크 타입 (hierarchical, peer, one_way)
   * @param {Object} [metadata]
   */
  addLink(from, to, type, metadata = {}) {
    if (!LINK_TYPES.includes(type)) {
      throw new Error(`Invalid link type: ${type}. Must be one of: ${LINK_TYPES.join(', ')}`);
    }
    if (from === to) {
      throw new Error('Self-links not allowed');
    }

    if (!this.links.has(from)) this.links.set(from, new Map());
    this.links.get(from).set(to, {
      type,
      metadata,
      createdAt: Date.now(),
      messageCount: 0,
    });

    // peer 타입은 양방향 자동 생성
    if (type === 'peer') {
      if (!this.links.has(to)) this.links.set(to, new Map());
      if (!this.links.get(to).has(from)) {
        this.links.get(to).set(from, {
          type: 'peer',
          metadata,
          createdAt: Date.now(),
          messageCount: 0,
        });
      }
    }

    log.info('Link created', { from, to, type });
  }

  /**
   * 메시지 전송 가능 여부 확인.
   * @param {string} from
   * @param {string} to
   * @param {string} [threadId] - 기존 스레드 ID (one_way 응답용)
   * @returns {{ allowed: boolean, reason: string, link: Object|null }}
   */
  canSend(from, to, threadId) {
    const fromLinks = this.links.get(from);
    if (!fromLinks || !fromLinks.has(to)) {
      // 역방향 one_way 체크 (수신자가 기존 스레드에서 응답)
      const toLinks = this.links.get(to);
      if (toLinks && toLinks.has(from)) {
        const reverseLink = toLinks.get(from);
        if (reverseLink.type === 'one_way' && threadId) {
          // one_way 역방향: 기존 스레드에서만 응답 허용 (O(1) 인덱스 조회)
          const linkKey = `${to}→${from}`;
          const threads = this._threadIndex.get(threadId);
          if (threads && threads.has(linkKey)) {
            return { allowed: true, reason: 'Reply in existing one_way thread', link: reverseLink };
          }
        }
      }
      return { allowed: false, reason: `No communication link from '${from}' to '${to}'`, link: null };
    }

    return { allowed: true, reason: 'Direct link exists', link: fromLinks.get(to) };
  }

  /**
   * 에이전트 간 메시지 전송.
   * @param {string} from
   * @param {string} to
   * @param {string} message
   * @param {Object} [opts] - { threadId, priority }
   * @returns {{ success: boolean, messageId: string, reason: string }}
   */
  sendMessage(from, to, message, opts = {}) {
    const { threadId, priority = 'normal' } = opts;

    const check = this.canSend(from, to, threadId);
    if (!check.allowed) {
      log.warn('Message blocked', { from, to, reason: check.reason });
      return { success: false, messageId: null, reason: check.reason };
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const effectiveThread = threadId || messageId;

    const entry = {
      messageId,
      from,
      to,
      message,
      threadId: effectiveThread,
      priority,
      timestamp: Date.now(),
    };

    this.messageLog.push(entry);

    // 스레드 인덱스 업데이트
    if (!this._threadIndex.has(effectiveThread)) {
      this._threadIndex.set(effectiveThread, new Set());
    }
    this._threadIndex.get(effectiveThread).add(`${from}→${to}`);

    // 카운트 업데이트
    if (check.link) check.link.messageCount++;

    // 로그 크기 제한
    if (this.messageLog.length > this.maxLogSize) {
      this.messageLog = this.messageLog.slice(-this.maxLogSize);
      // 삭제된 메시지의 스레드 정리 (필요시)
    }

    log.info('Agent message sent', { from, to, threadId: effectiveThread, priority });
    return { success: true, messageId, reason: 'Delivered' };
  }

  /**
   * 에이전트의 수신 메시지 조회.
   * @param {string} agentId
   * @param {Object} [opts] - { limit, since }
   * @returns {Array}
   */
  getInbox(agentId, { limit = 20, since } = {}) {
    let messages = this.messageLog.filter(m => m.to === agentId);
    if (since) messages = messages.filter(m => m.timestamp >= since);
    return messages.slice(-limit);
  }

  /**
   * 에이전트의 통신 가능 대상 목록.
   * @param {string} agentId
   * @returns {Array<{ agentId: string, type: string }>}
   */
  getReachable(agentId) {
    const fromLinks = this.links.get(agentId);
    if (!fromLinks) return [];

    return Array.from(fromLinks.entries()).map(([to, link]) => ({
      agentId: to,
      type: link.type,
      messageCount: link.messageCount,
    }));
  }

  /**
   * 전체 그래프 시각화용 데이터.
   * @returns {{ nodes: Array, edges: Array }}
   */
  toGraph() {
    const nodes = Array.from(this.agents.values());
    const edges = [];

    for (const [from, targets] of this.links) {
      for (const [to, link] of targets) {
        edges.push({ from, to, type: link.type, messageCount: link.messageCount });
      }
    }

    return { nodes, edges };
  }

  /**
   * 설정에서 그래프 초기화.
   * @param {Object} config - { agents: [{id, role, level}], links: [{from, to, type}] }
   */
  loadFromConfig(config = {}) {
    for (const agent of (config.agents || [])) {
      this.registerAgent(agent.id, agent);
    }
    for (const link of (config.links || [])) {
      try {
        this.addLink(link.from, link.to, link.type || 'peer', link.metadata);
      } catch (err) {
        log.warn('Failed to add link from config', { error: err.message, link });
      }
    }
    log.info('Graph loaded from config', {
      agents: this.agents.size,
      links: Array.from(this.links.values()).reduce((sum, m) => sum + m.size, 0),
    });
  }
}

module.exports = { AgentCommGraph, LINK_TYPES };
