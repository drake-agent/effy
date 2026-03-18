/**
 * mailbox.js — 에이전트 간 내부 메시지 큐.
 *
 * Gateway가 다음 턴에서 대상 에이전트에게 메시지를 전달할 수 있도록
 * 인메모리 큐에 저장한다.
 *
 * 구조:
 * - send(msg)          → 큐에 메시지 추가
 * - receive(agentId)   → 해당 에이전트 대상 메시지 꺼내기 (FIFO)
 * - peek(agentId)      → 꺼내지 않고 조회
 * - size()             → 전체 대기 메시지 수
 *
 * 제약:
 * - 인메모리 전용 — 프로세스 재시작 시 유실 (의도적 설계: 에이전트 메시지는 ephemeral)
 * - MAX_QUEUE_SIZE 초과 시 oldest 메시지 자동 드롭
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('agents:mailbox');

const MAX_QUEUE_SIZE = 500;
const MAX_PER_AGENT = 50;

class AgentMailbox {
  constructor() {
    /** @type {Map<string, Array<object>>} — agentId → messages[] */
    this._queues = new Map();
    this._totalCount = 0;
  }

  /**
   * 메시지 전송 (큐에 추가).
   *
   * @param {object} msg
   * @param {string} msg.from   - 발신 에이전트 ID
   * @param {string} msg.to     - 수신 에이전트 ID
   * @param {string} msg.message - 메시지 본문
   * @param {object} [msg.context] - 추가 컨텍스트
   * @param {number} [msg.timestamp] - 전송 시각 (ms)
   * @returns {{ success: boolean, error?: string }}
   */
  send(msg) {
    if (!msg || !msg.to || !msg.message) {
      return { success: false, error: 'msg.to and msg.message are required' };
    }

    const to = msg.to;
    if (!this._queues.has(to)) {
      this._queues.set(to, []);
    }

    const queue = this._queues.get(to);

    // 에이전트당 큐 상한
    if (queue.length >= MAX_PER_AGENT) {
      const dropped = queue.shift();
      this._totalCount--;
      log.warn('Agent queue full, dropping oldest', { to, droppedFrom: dropped.from });
    }

    // 전체 큐 상한
    if (this._totalCount >= MAX_QUEUE_SIZE) {
      this._dropOldestGlobal();
    }

    const entry = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: msg.from || 'unknown',
      to,
      message: msg.message,
      context: msg.context || {},
      timestamp: msg.timestamp || Date.now(),
      receivedAt: Date.now(),
    };

    queue.push(entry);
    this._totalCount++;
    log.debug('Message queued', { id: entry.id, from: entry.from, to });
    return { success: true, id: entry.id };
  }

  /**
   * 대상 에이전트의 대기 메시지 전부 꺼내기 (FIFO).
   *
   * @param {string} agentId
   * @param {number} [limit=10] - 최대 수신 수
   * @returns {Array<object>}
   */
  receive(agentId, limit = 10) {
    const queue = this._queues.get(agentId);
    if (!queue || queue.length === 0) return [];

    const count = Math.min(limit, queue.length);
    const messages = queue.splice(0, count);
    this._totalCount -= messages.length;

    if (queue.length === 0) {
      this._queues.delete(agentId);
    }

    log.debug('Messages received', { agentId, count: messages.length });
    return messages;
  }

  /**
   * 대상 에이전트의 대기 메시지 조회 (꺼내지 않음).
   *
   * @param {string} agentId
   * @returns {Array<object>}
   */
  peek(agentId) {
    return this._queues.get(agentId) || [];
  }

  /**
   * 에이전트의 대기 메시지 수.
   * @param {string} [agentId] - 생략 시 전체 합계
   * @returns {number}
   */
  size(agentId) {
    if (agentId) {
      return (this._queues.get(agentId) || []).length;
    }
    return this._totalCount;
  }

  /**
   * 전체 큐 비우기.
   */
  clear() {
    this._queues.clear();
    this._totalCount = 0;
  }

  /** @private 전역 큐 상한 도달 시 가장 오래된 메시지 드롭 */
  _dropOldestGlobal() {
    let oldestTime = Infinity;
    let oldestAgent = null;

    for (const [agentId, queue] of this._queues) {
      if (queue.length > 0 && queue[0].receivedAt < oldestTime) {
        oldestTime = queue[0].receivedAt;
        oldestAgent = agentId;
      }
    }

    if (oldestAgent) {
      const queue = this._queues.get(oldestAgent);
      const dropped = queue.shift();
      this._totalCount--;
      if (queue.length === 0) this._queues.delete(oldestAgent);
      log.warn('Global queue full, dropping oldest', { droppedFrom: dropped.from, to: oldestAgent });
    }
  }
}

// ─── 싱글톤 ─────────────────────────────────────────

let _instance = null;

function getAgentMailbox() {
  if (!_instance) {
    _instance = new AgentMailbox();
  }
  return _instance;
}

function resetAgentMailbox() {
  if (_instance) {
    _instance.clear();
    _instance = null;
  }
}

module.exports = { AgentMailbox, getAgentMailbox, resetAgentMailbox };
