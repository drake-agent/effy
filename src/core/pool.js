/**
 * pool.js — Agent Pool Manager + Concurrency Governor.
 *
 * 세션 관리, 동시성 제한, FIFO 큐잉.
 * 오케스트레이션은 코드(결정적), LLM 아님.
 */
const { config } = require('../config');
const { getDb } = require('../db/sqlite');

class ConcurrencyGovernor {
  constructor() {
    this.globalCount = 0;
    this.userCounts = new Map();   // userId → count
    this.channelCounts = new Map(); // channelId → count
    this.queue = [];                // FIFO 대기열
  }

  canAcquire(userId, channelId) {
    if (this.globalCount >= config.concurrency.global) return false;
    if ((this.userCounts.get(userId) || 0) >= config.concurrency.perUser) return false;
    if (channelId && (this.channelCounts.get(channelId) || 0) >= config.concurrency.perChannel) return false;
    return true;
  }

  acquire(userId, channelId) {
    this.globalCount++;
    this.userCounts.set(userId, (this.userCounts.get(userId) || 0) + 1);
    if (channelId) {
      this.channelCounts.set(channelId, (this.channelCounts.get(channelId) || 0) + 1);
    }
  }

  /** NEW-05 fix: atomic canAcquire+acquire — TOCTOU 방지 */
  tryAcquire(userId, channelId) {
    if (!this.canAcquire(userId, channelId)) return false;
    this.acquire(userId, channelId);
    return true;
  }

  release(userId, channelId) {
    this.globalCount = Math.max(0, this.globalCount - 1);
    const uc = this.userCounts.get(userId) || 0;
    if (uc > 1) this.userCounts.set(userId, uc - 1); else this.userCounts.delete(userId);
    if (channelId) {
      const cc = this.channelCounts.get(channelId) || 0;
      if (cc > 1) this.channelCounts.set(channelId, cc - 1); else this.channelCounts.delete(channelId);
    }
    // 큐에 대기 중인 것 깨우기
    this._drainQueue();
  }

  /**
   * 동시성 획득 대기 (30초 타임아웃).
   * R2-BUG-003 fix: Queue depth limit to prevent OOM under sustained overload.
   * @returns {Promise<boolean>} true면 획득, false면 타임아웃
   */
  waitForSlot(userId, channelId, timeoutMs = 30_000) {
    // NEW-05 fix: use atomic tryAcquire
    if (this.tryAcquire(userId, channelId)) {
      return Promise.resolve(true);
    }
    // R2-BUG-003: Reject immediately if queue is too deep (load shedding)
    const maxQueueDepth = config.concurrency?.maxQueueDepth || 500;
    if (this.queue.filter(e => !e.done).length >= maxQueueDepth) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const entry = { userId, channelId, resolve, done: false };
      const timer = setTimeout(() => {
        entry.done = true;
        resolve(false);
      }, timeoutMs);
      entry.timer = timer;
      this.queue.push(entry);
    });
  }

  _drainQueue() {
    const remaining = [];
    for (const entry of this.queue) {
      if (entry.done) continue;
      // NEW-05 fix: use atomic tryAcquire in drain loop
      if (this.tryAcquire(entry.userId, entry.channelId)) {
        clearTimeout(entry.timer);
        entry.done = true;
        entry.resolve(true);
      } else {
        remaining.push(entry);
      }
    }
    this.queue = remaining;
  }

  get stats() {
    return {
      global: this.globalCount,
      users: Object.fromEntries(this.userCounts),
      channels: Object.fromEntries(this.channelCounts),
      queued: this.queue.filter(e => !e.done).length,
    };
  }
}

// ─── Session Registry ───

class SessionRegistry {
  constructor(idleTimeoutMs, maxSessions = 10000) {
    this.sessions = new Map();  // sessionKey → { lastActivity, agentType, functionType, ... }
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxSessions = maxSessions;
    this.idleCallbacks = [];    // (sessionKey, sessionData) => void
  }

  onIdle(callback) {
    this.idleCallbacks.push(callback);
  }

  touch(sessionKey, data = {}) {
    let session = this.sessions.get(sessionKey);
    if (!session) {
      // ARCH-003 fix: Evict oldest session if at capacity
      if (this.sessions.size >= this.maxSessions) {
        this._evictOldest();
      }
      session = { ...data, createdAt: Date.now() };
      this.sessions.set(sessionKey, session);
    }

    // idle 타이머 리셋 (세션 삭제 경쟁 조건 방지)
    if (session._idleTimer) clearTimeout(session._idleTimer);
    session.lastActivity = Date.now();
    session._idleTimer = setTimeout(() => {
      const current = this.sessions.get(sessionKey);
      if (current) this._onSessionIdle(sessionKey);
    }, this.idleTimeoutMs);

    // 내부 필드 보호: _idleTimer, createdAt 등 덮어쓰기 방지
    const { _idleTimer, createdAt, lastActivity, ...safeData } = data;
    Object.assign(session, safeData);
    return session;
  }

  get(sessionKey) {
    return this.sessions.get(sessionKey);
  }

  _onSessionIdle(sessionKey) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;
    console.log(`[pool] Session idle: ${sessionKey}`);
    for (const cb of this.idleCallbacks) {
      try { cb(sessionKey, session); } catch (e) { console.error('[pool] Idle callback error:', e); }
    }
    this.sessions.delete(sessionKey);
  }

  /** ARCH-003 fix: Evict oldest session by lastActivity when at capacity */
  _evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [key, session] of this.sessions) {
      if (session.lastActivity < oldestTime) {
        oldestTime = session.lastActivity;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const session = this.sessions.get(oldestKey);
      if (session?._idleTimer) clearTimeout(session._idleTimer);
      // R2-ARCH-3 fix: Trigger onIdle callbacks BEFORE deletion to prevent data loss
      // This ensures session data is indexed/persisted before eviction
      for (const cb of this.idleCallbacks) {
        try { cb(oldestKey, session); } catch (e) { console.error('[pool] Eviction callback error:', e); }
      }
      this.sessions.delete(oldestKey);
      console.log(`[pool] Session evicted (max capacity): ${oldestKey}`);
    }
  }

  /**
   * 세션 직렬화 — DB에 저장.
   * PERF-2: Use writeQueue for proper async serialization under concurrent load.
   * No synchronous fallback to prevent event loop blocking.
   */
  async serialize(sessionKey, stateJson) {
    const session = this.sessions.get(sessionKey);
    if (!session) return;

    // Get writeQueue from sqlite module (if available)
    try {
      const sqlite = require('../db/sqlite');
      if (sqlite.writeQueue && sqlite.writeQueue.enqueue) {
        // Use writeQueue for async serialization
        await sqlite.writeQueue.enqueue((db) => {
          db.prepare(`
            INSERT INTO sessions (id, user_id, channel_id, thread_ts, agent_type, function_type, state_json, last_activity)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, last_activity = datetime('now')
          `).run(sessionKey, session.userId || '', session.channelId || '', session.threadTs || '',
                 session.agentType || '', session.functionType || '', stateJson || '');
        });
        return;
      }
    } catch (err) {
      console.error('[pool] Session serialize failed:', err);
      // Graceful degradation: do not fall back to sync call
    }
  }

  get size() {
    return this.sessions.size;
  }
}

module.exports = { ConcurrencyGovernor, SessionRegistry };
