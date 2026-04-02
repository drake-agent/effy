/**
 * coalescer.js — Message Coalescing.
 *
 * v4.1 Enhanced: Per-user+channel bucketing, max coalesce window, typing feedback, follow-up routing.
 *
 * 빠른 연속 메시지를 (userId:channelId) 독립 타이머로 배치 처리.
 * DM은 즉시 flush (bypass).
 * 최대 대기 시간(maxCoalesceMs) 초과 시 자동 flush.
 * 진행 중인 세션으로 follow-up 메시지 라우팅 지원.
 */
const { config } = require('../config');

class MessageCoalescer {
  constructor(opts = {}) {
    const coalescerCfg = config.coalescer || {};
    this.debounceMs = coalescerCfg.debounceMs || 150;
    this.maxCoalesceMs = coalescerCfg.maxCoalesceMs || 2000;
    this.dmBypass = coalescerCfg.dmBypass !== false;
    this.perUserBucketing = coalescerCfg.perUserBucketing !== false;
    this.enabled = coalescerCfg.enabled !== false;
    // R3-PERF-4: global pending message cap
    this.maxTotalPending = opts.maxTotalPending ?? coalescerCfg.maxTotalPending ?? 1000;
    // R1-005 fix: O(1) pending counter (O(n) scan 제거)
    this._totalPendingCount = 0;
    // R1-008 fix: shutdown 중 add() 차단
    this._destroying = false;

    /** @type {Map<string, { timer: NodeJS.Timeout|null, maxWaitTimer: NodeJS.Timeout|null, messages: object[], flushCallback: function, createdAt: number, typingCallback?: function }>} */
    this._buckets = new Map();

    // v4.1: Per-user pending state for follow-up routing
    // Map<string, { sessionKey: string, agent: string, active: boolean }> — userId:channelId → active session
    this._activeSessions = new Map();
  }

  /**
   * 활성 세션 등록 — follow-up 라우팅용.
   * @param {string} userId
   * @param {string} channelId
   * @param {object} sessionInfo - { sessionKey, agent, ...}
   */
  registerActiveSession(userId, channelId, sessionInfo) {
    const key = this._makeUserChannelKey(userId, channelId);
    this._activeSessions.set(key, { ...sessionInfo, active: true });
  }

  /**
   * 활성 세션 해제.
   */
  deregisterActiveSession(userId, channelId) {
    const key = this._makeUserChannelKey(userId, channelId);
    this._activeSessions.delete(key);
  }

  /**
   * 해당 user:channel에서 진행 중인 세션 조회.
   * @returns {object|null}
   */
  getActiveSession(userId, channelId) {
    const key = this._makeUserChannelKey(userId, channelId);
    return this._activeSessions.get(key) || null;
  }

  /**
   * 메시지 추가.
   * @param {string} channelId
   * @param {boolean} isDM
   * @param {object} msg - NormalizedMessage (msg.sender.id 필요)
   * @param {function} flushCallback - (msgs[]) => Promise<void>
   * @param {object} opts - { typingCallback?: (count) => Promise<void> }
   */
  add(channelId, isDM, msg, flushCallback, opts = {}) {
    if (!this.enabled) { flushCallback([msg]); return; }
    if (this._destroying) { return; } // R1-008 fix: shutdown 중 새 메시지 차단
    if (isDM && this.dmBypass) { flushCallback([msg]); return; }

    const userId = msg.sender?.id || 'unknown';
    const bucketKey = this.perUserBucketing
      ? this._makeUserChannelKey(userId, channelId)
      : channelId;

    // R1-005 fix: O(1) pending cap 체크 (O(n) scan 제거)
    if (this._totalPendingCount >= this.maxTotalPending) {
      flushCallback([msg]);
      return;
    }

    let bucket = this._buckets.get(bucketKey);
    if (!bucket) {
      bucket = {
        timer: null,
        maxWaitTimer: null,
        messages: [],
        flushCallback,
        createdAt: Date.now(),
        typingCallback: opts.typingCallback,
      };
      this._buckets.set(bucketKey, bucket);
    }

    bucket.messages.push(msg);
    this._totalPendingCount++; // R1-005 fix
    bucket.flushCallback = flushCallback;
    bucket.typingCallback = opts.typingCallback || bucket.typingCallback;

    // 청소: 기존 타이머 제거
    if (bucket.timer) clearTimeout(bucket.timer);
    if (bucket.maxWaitTimer) clearTimeout(bucket.maxWaitTimer);

    // v4.1: 최대 대기 시간 설정 — maxCoalesceMs 초과 시 강제 flush
    bucket.maxWaitTimer = setTimeout(() => {
      this._flushBucket(bucketKey);
    }, this.maxCoalesceMs);

    // 정규 debounce 타이머
    bucket.timer = setTimeout(() => {
      this._flushBucket(bucketKey);
    }, this.debounceMs);

    // v4.1: typing indicator 피드백 (pending count 표시)
    if (bucket.typingCallback && bucket.messages.length > 1) {
      bucket.typingCallback(bucket.messages.length).catch(e => {
        console.error('[coalescer] Typing indicator error:', e.message);
      });
    }
  }

  /**
   * 내부: 버킷을 flush하고 정리.
   * @private
   */
  _flushBucket(bucketKey) {
    const bucket = this._buckets.get(bucketKey);
    if (!bucket) return;

    // 타이머 정리 (R1-BUG-003 fix: 양쪽 타이머 명시적 정리)
    if (bucket.timer) clearTimeout(bucket.timer);
    if (bucket.maxWaitTimer) clearTimeout(bucket.maxWaitTimer);
    bucket.timer = null;
    bucket.maxWaitTimer = null;

    const msgs = bucket.messages;
    this._totalPendingCount -= msgs.length; // R1-005 fix
    this._buckets.delete(bucketKey);

    if (msgs.length > 0) {
      try {
        bucket.flushCallback(msgs);
      } catch (e) {
        console.error(`[coalescer] Error flushing bucket ${bucketKey}:`, e.message);
      }
    }
  }

  /**
   * 버킷 키 생성: userId:channelId 또는 channelId
   * @private
   */
  _makeUserChannelKey(userId, channelId) {
    return this.perUserBucketing ? `${userId}:${channelId}` : channelId;
  }

  /**
   * STRUCT-8+ARCH-007: Synchronously execute all pending callbacks and clear timers.
   * Flushes all pending messages before cleanup to prevent message loss.
   * v4.1: Updated for per-user bucketing.
   */
  flushAll() {
    // Synchronously execute all pending callbacks
    for (const [key, bucket] of this._buckets.entries()) {
      if (bucket.timer) {
        clearTimeout(bucket.timer);
        bucket.timer = null;
      }
      if (bucket.maxWaitTimer) {
        clearTimeout(bucket.maxWaitTimer);
        bucket.maxWaitTimer = null;
      }
      if (bucket.messages && bucket.messages.length > 0) {
        try {
          bucket.flushCallback(bucket.messages);
        } catch (e) {
          console.error(`[coalescer] Error flushing bucket ${key}:`, e.message);
        }
        bucket.messages = [];
      }
    }
  }

  /**
   * ARCH-007: Cleanup and destroy all pending timers.
   * Call this during graceful shutdown to prevent timer leaks.
   * Always calls flushAll first to ensure no messages are lost.
   * v4.1: Cleanup active sessions too.
   */
  destroy() {
    this._destroying = true; // R1-008 fix: 새 메시지 차단
    this.flushAll(); // Flush first, then clean up
    this._buckets.clear();
    this._activeSessions.clear();
    this._totalPendingCount = 0;
  }

  /**
   * v4.1: Get pending message count.
   */
  get pendingCount() {
    return this._totalPendingCount; // R1-005 fix: O(1) counter
  }

  /**
   * v4.1: Get number of active buckets (channels or user:channel combinations).
   */
  get pendingBuckets() { return this._buckets.size; }

  /**
   * v4.1: Backward compatibility — pendingChannels alias.
   */
  get pendingChannels() { return this._buckets.size; }

  /**
   * v4.1: Get active session count.
   */
  get activeSessions() { return this._activeSessions.size; }
}

module.exports = { MessageCoalescer };
