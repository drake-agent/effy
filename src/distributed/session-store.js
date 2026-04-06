/**
 * session-store.js — 분산 세션 저장소.
 *
 * 모드:
 *  - local: Node.js Map (기본, 현재 동작 유지)
 *  - redis: Redis 기반 (TTL 포함)
 *
 * 기능:
 * - get(sessionId): 세션 로드
 * - set(sessionId, session, ttlMs): 세션 저장
 * - delete(sessionId): 세션 삭제
 * - migrateSession(sessionId, sourceAgent, targetAgent): 세션 마이그레이션
 * - clear(): 모든 세션 삭제
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('session-store');

/**
 * LocalSessionStore: 메모리 기반 세션 저장소.
 *
 * Node.js Map으로 구현. TTL 지원 (간단한 setInterval).
 */
class LocalSessionStore {
  constructor(options = {}) {
    this.mode = 'local';
    this.sessions = new Map(); // { sessionId: { data, expiresAt } }
    this.defaultTtlMs = options.defaultTtlMs || 86400000; // 24시간
    this.cleanupIntervalMs = options.cleanupIntervalMs || 300000; // 5분

    // TTL 정리 타이머
    this.cleanupTimer = setInterval(() => {
      this._cleanup();
    }, this.cleanupIntervalMs);

    log.info(`LocalSessionStore initialized (ttl=${this.defaultTtlMs}ms)`);
  }

  /**
   * 세션 조회.
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async get(sessionId) {
    const entry = this.sessions.get(sessionId);

    if (!entry) {
      return null;
    }

    // TTL 확인
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return null;
    }

    return entry.data || {};
  }

  /**
   * 세션 저장.
   * @param {string} sessionId
   * @param {object} session
   * @param {number} ttlMs - TTL (ms)
   * @returns {Promise<void>}
   */
  async set(sessionId, session, ttlMs) {
    const ttl = ttlMs || this.defaultTtlMs;
    const expiresAt = Date.now() + ttl;

    const existing = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      data: session,
      expiresAt,
      createdAt: existing ? existing.createdAt : Date.now(),
    });

    log.debug(`Session saved: ${sessionId} (ttl=${ttl}ms)`);
  }

  /**
   * 세션 삭제.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async delete(sessionId) {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      log.debug(`Session deleted: ${sessionId}`);
    }
    return deleted;
  }

  /**
   * 모든 세션 삭제.
   * @returns {Promise<void>}
   */
  async clear() {
    const count = this.sessions.size;
    this.sessions.clear();
    log.info(`Sessions cleared: ${count} session(s) removed`);
  }

  /**
   * 세션 마이그레이션 (에이전트 간 이동).
   * @param {string} sessionId
   * @param {string} sourceAgent
   * @param {string} targetAgent
   * @returns {Promise<object|null>}
   */
  async migrateSession(sessionId, sourceAgent, targetAgent) {
    const session = await this.get(sessionId);
    if (!session) {
      log.warn(`Session not found for migration: ${sessionId}`);
      return null;
    }

    // 메타데이터 추가
    session._migratedAt = Date.now();
    session._migratedFrom = sourceAgent;
    session._migratedTo = targetAgent;

    await this.set(sessionId, session);
    log.info(`Session migrated: ${sessionId} (${sourceAgent} → ${targetAgent})`);

    return session;
  }

  /**
   * 통계.
   * @returns {object}
   */
  stats() {
    return {
      mode: this.mode,
      totalSessions: this.sessions.size,
      activeSessions: this._countActiveSessions(),
    };
  }

  /**
   * 활성 세션 수 (TTL 유효).
   * @private
   */
  _countActiveSessions() {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (!entry.expiresAt || entry.expiresAt > Date.now()) {
        count++;
      }
    }
    return count;
  }

  /**
   * TTL 정리.
   * @private
   */
  _cleanup() {
    const now = Date.now();
    let removed = 0;

    for (const [sessionId, entry] of this.sessions) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.sessions.delete(sessionId);
        removed++;
      }
    }

    if (removed > 0) {
      log.debug(`TTL cleanup: ${removed} session(s) removed`);
    }
  }

  /**
   * 종료.
   */
  async close() {
    clearInterval(this.cleanupTimer);
    const count = this.sessions.size;
    this.sessions.clear();
    log.info(`LocalSessionStore closed (${count} session(s) discarded)`);
  }
}

/**
 * RedisSessionStore: Redis 기반 세션 저장소.
 *
 * Redis의 기본 TTL 기능 활용.
 */
class RedisSessionStore {
  constructor(redisClient, options = {}) {
    this.mode = 'redis';
    this.redis = redisClient;
    this.prefix = options.prefix || 'effy:session:';
    this.defaultTtlMs = options.defaultTtlMs || 86400000; // 24시간
    this.defaultTtlSec = Math.ceil(this.defaultTtlMs / 1000);

    log.info(`RedisSessionStore initialized (prefix=${this.prefix}, ttl=${this.defaultTtlMs}ms)`);
  }

  /**
   * 세션 조회.
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async get(sessionId) {
    const key = `${this.prefix}${sessionId}`;
    const data = await this.redis.get(key);

    if (!data) {
      return null;
    }

    try {
      return JSON.parse(data);
    } catch (err) {
      log.warn(`Failed to parse session: ${sessionId}`, { error: err.message });
      return null;
    }
  }

  /**
   * 세션 저장.
   * @param {string} sessionId
   * @param {object} session
   * @param {number} ttlMs
   * @returns {Promise<void>}
   */
  async set(sessionId, session, ttlMs) {
    const key = `${this.prefix}${sessionId}`;
    const ttl = ttlMs || this.defaultTtlMs;
    const ttlSec = Math.ceil(ttl / 1000);

    try {
      const data = JSON.stringify(session);
      await this.redis.setex(key, ttlSec, data);
      log.debug(`Session saved: ${sessionId} (ttl=${ttl}ms)`);
    } catch (err) {
      log.error(`Failed to save session: ${sessionId}`, { error: err.message });
      throw err;
    }
  }

  /**
   * 세션 삭제.
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async delete(sessionId) {
    const key = `${this.prefix}${sessionId}`;
    const result = await this.redis.del(key);
    const deleted = result === 1;
    if (deleted) {
      log.debug(`Session deleted: ${sessionId}`);
    }
    return deleted;
  }

  /**
   * 모든 세션 삭제.
   * @returns {Promise<void>}
   */
  async clear() {
    // SCAN-based iteration instead of KEYS * to avoid blocking Redis
    const pattern = `${this.prefix}*`;
    let cursor = '0';
    let totalDeleted = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.redis.del(...keys);
        totalDeleted += keys.length;
      }
    } while (cursor !== '0');
    if (totalDeleted > 0) {
      log.info(`Sessions cleared: ${totalDeleted} session(s) removed`);
    }
  }

  /**
   * 세션 마이그레이션.
   * @param {string} sessionId
   * @param {string} sourceAgent
   * @param {string} targetAgent
   * @returns {Promise<object|null>}
   */
  async migrateSession(sessionId, sourceAgent, targetAgent) {
    const session = await this.get(sessionId);
    if (!session) {
      log.warn(`Session not found for migration: ${sessionId}`);
      return null;
    }

    // 메타데이터 추가
    session._migratedAt = Date.now();
    session._migratedFrom = sourceAgent;
    session._migratedTo = targetAgent;

    await this.set(sessionId, session);
    log.info(`Session migrated: ${sessionId} (${sourceAgent} → ${targetAgent})`);

    return session;
  }

  /**
   * 통계.
   * @returns {Promise<object>}
   */
  async stats() {
    // SCAN-based iteration instead of KEYS * to avoid blocking Redis
    const pattern = `${this.prefix}*`;
    let cursor = '0';
    let count = 0;
    do {
      const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      count += keys.length;
    } while (cursor !== '0');
    return {
      mode: this.mode,
      totalSessions: count,
      activeSessions: count, // Redis TTL이 자동 처리
    };
  }

  /**
   * 종료.
   * @returns {Promise<void>}
   */
  async close() {
    log.info('RedisSessionStore closed');
  }
}

/**
 * SessionStore 팩토리.
 * @param {object} options - { mode, redis?, defaultTtlMs? }
 * @returns {LocalSessionStore|RedisSessionStore}
 */
function createSessionStore(options = {}) {
  const mode = options.mode || 'local';

  if (mode === 'redis') {
    if (!options.redis) {
      throw new Error('Redis client required for redis mode');
    }
    return new RedisSessionStore(options.redis, options);
  }

  return new LocalSessionStore(options);
}

module.exports = {
  LocalSessionStore,
  RedisSessionStore,
  createSessionStore,
};
