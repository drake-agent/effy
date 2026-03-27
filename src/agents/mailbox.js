/**
 * mailbox.js — 에이전트 간 내부 메시지 큐.
 *
 * v3.9: L1 인메모리 + L2 PostgreSQL 2-tier 구조.
 * - L1: 인메모리 큐 (빠른 읽기/쓰기)
 * - L2: PostgreSQL agent_messages 테이블 (영속화)
 * - 프로세스 재시작 시 pending 메시지 자동 복원
 * - 배달 실패 3회 → dead_letter 처리
 *
 * 구조:
 * - send(msg)          → L1 큐 + L2 PG 동시 저장
 * - receive(agentId)   → L1에서 꺼내기 + L2 delivered 마킹
 * - peek(agentId)      → 꺼내지 않고 조회
 * - size()             → 전체 대기 메시지 수
 * - restoreFromDb()    → PG에서 pending 메시지 복원
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('agents:mailbox');

const MAX_QUEUE_SIZE = 500;
const MAX_PER_AGENT = 50;
const MAX_RETRY = 3;

class AgentMailbox {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.db] - PostgreSQL adapter (선택)
   */
  constructor(opts = {}) {
    /** @type {Map<string, Array<object>>} — agentId → messages[] */
    this._queues = new Map();
    this._totalCount = 0;
    this.db = opts.db || null;
  }

  /** DB adapter 설정 (지연 주입). */
  setDb(db) { this.db = db; }

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

    // context 검증 — 오브젝트만 허용, 크기 제한
    let safeContext = {};
    if (msg.context && typeof msg.context === 'object' && !Array.isArray(msg.context)) {
      const ctxStr = JSON.stringify(msg.context);
      if (ctxStr.length <= 10000) { // 10KB 제한
        safeContext = msg.context;
      } else {
        log.warn('Message context too large, truncated', { to, size: ctxStr.length });
      }
    }

    const entry = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      from: msg.from || 'unknown',
      to,
      message: msg.message,
      context: safeContext,
      timestamp: msg.timestamp || Date.now(),
      receivedAt: Date.now(),
    };

    queue.push(entry);
    this._totalCount++;

    // L2: PG 영속화 (비동기, 실패해도 무시)
    this._persistToDb(entry).catch(() => {});

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

    // L2: PG delivered 마킹 (비동기)
    if (this.db && messages.length > 0) {
      const ids = messages.map(m => m.id);
      this._markDelivered(ids).catch(() => {});
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

  // ─── PostgreSQL L2 ────────────────────────────────────

  /** @private L2 PG 영속화 */
  async _persistToDb(entry) {
    if (!this.db) return;
    try {
      await this.db.run(
        `INSERT INTO agent_messages (msg_id, from_agent, to_agent, message, context, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
        [entry.id, entry.from, entry.to, entry.message, JSON.stringify(entry.context || {})]
      );
    } catch (err) {
      log.debug('Mailbox PG persist failed', { error: err.message });
    }
  }

  /** @private L2 배달 완료 마킹 */
  async _markDelivered(msgIds) {
    if (!this.db || msgIds.length === 0) return;
    try {
      // 배치 업데이트
      for (const id of msgIds) {
        await this.db.run(
          `UPDATE agent_messages SET status = 'delivered', delivered_at = NOW() WHERE msg_id = ?`,
          [id]
        );
      }
    } catch (err) {
      log.debug('Mailbox PG delivered mark failed', { error: err.message });
    }
  }

  /**
   * PG에서 pending 메시지 복원 (프로세스 재시작 시).
   * retry_count >= MAX_RETRY인 메시지는 dead_letter 처리.
   */
  async restoreFromDb() {
    if (!this.db) return 0;
    try {
      // dead letter 처리 — retry 3회 초과
      await this.db.run(
        `UPDATE agent_messages SET status = 'dead_letter'
         WHERE status = 'pending' AND retry_count >= ?`,
        [MAX_RETRY]
      );

      // pending 메시지 복원
      const rows = await this.db.all(
        `SELECT msg_id, from_agent, to_agent, message, context, created_at
         FROM agent_messages WHERE status = 'pending'
         ORDER BY created_at ASC LIMIT ?`,
        [MAX_QUEUE_SIZE]
      );

      let restored = 0;
      for (const row of rows) {
        const to = row.to_agent;
        if (!this._queues.has(to)) this._queues.set(to, []);
        const queue = this._queues.get(to);

        if (queue.length < MAX_PER_AGENT) {
          queue.push({
            id: row.msg_id,
            from: row.from_agent,
            to,
            message: row.message,
            context: typeof row.context === 'string' ? JSON.parse(row.context) : (row.context || {}),
            timestamp: new Date(row.created_at).getTime(),
            receivedAt: Date.now(),
          });
          this._totalCount++;
          restored++;
        }

        // retry_count 증가
        await this.db.run(
          `UPDATE agent_messages SET retry_count = retry_count + 1 WHERE msg_id = ?`,
          [row.msg_id]
        );
      }

      if (restored > 0) {
        log.info('Mailbox restored from PG', { restored, deadLettered: rows.length - restored });
      }
      return restored;
    } catch (err) {
      log.warn('Mailbox PG restore failed', { error: err.message });
      return 0;
    }
  }

  /**
   * Dead letter 메시지 조회 (디버깅용).
   * @param {number} [limit=20]
   * @returns {Promise<Array>}
   */
  async getDeadLetters(limit = 20) {
    if (!this.db) return [];
    try {
      return await this.db.all(
        `SELECT msg_id, from_agent, to_agent, message, retry_count, created_at
         FROM agent_messages WHERE status = 'dead_letter'
         ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );
    } catch (err) {
      log.debug('Dead letter query failed', { error: err.message });
      return [];
    }
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
