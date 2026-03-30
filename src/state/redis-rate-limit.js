/**
 * redis-rate-limit.js — Distributed sliding window rate limiter.
 *
 * Uses Redis Sorted Sets for precise sliding window counting.
 * Each request is scored by timestamp; expired entries are pruned atomically.
 *
 * Redis key: effy:rl:{userId} → Sorted Set (score=timestamp, member=requestId)
 *
 * @module state/redis-rate-limit
 */
const { createLogger } = require('../shared/logger');
const _log = createLogger('state:redis-rl');

const PREFIX = 'effy:rl:';

// Lua: atomic sliding window check + add
const RATE_LIMIT_LUA = `
  local key = KEYS[1]
  local windowStart = tonumber(ARGV[1])
  local now = tonumber(ARGV[2])
  local maxRequests = tonumber(ARGV[3])
  local requestId = ARGV[4]
  local windowMs = tonumber(ARGV[5])

  redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

  local count = redis.call('ZCARD', key)

  if count >= maxRequests then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local retryAfterMs = 0
    if oldest and #oldest >= 2 then
      retryAfterMs = math.max(0, tonumber(oldest[2]) + windowMs - now)
    end
    return cjson.encode({allowed=false, remaining=0, retryAfterMs=retryAfterMs, current=count})
  end

  redis.call('ZADD', key, now, requestId)
  redis.call('PEXPIRE', key, windowMs)

  return cjson.encode({allowed=true, remaining=maxRequests - count - 1, current=count + 1})
`;

class RedisRateLimiter {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {Object} [config]
   * @param {number} [config.windowMs=60000] - Window size in ms (default: 1 minute)
   * @param {number} [config.maxRequests=30] - Max requests per window per user
   */
  constructor(redis, config = {}) {
    this._redis = redis;
    this._windowMs = config.windowMs || 60000;
    this._maxRequests = config.maxRequests || 30;
  }

  /**
   * Check if a request is within rate limits.
   * If allowed, the request is automatically counted.
   *
   * @param {string} userId - User identifier
   * @param {string} requestId - Unique request ID (for dedup)
   * @returns {Promise<{ allowed: boolean, remaining: number, retryAfterMs?: number }>}
   */
  async check(userId, requestId) {
    const key = `${PREFIX}${userId}`;
    const now = Date.now();
    const windowStart = now - this._windowMs;

    const result = await this._redis.eval(
      RATE_LIMIT_LUA, 1, key,
      windowStart, now, this._maxRequests, requestId, this._windowMs
    );
    return JSON.parse(result);
  }

  /**
   * Get current rate limit status for a user (without counting).
   * @param {string} userId
   * @returns {Promise<{ current: number, limit: number, remaining: number }>}
   */
  async getStatus(userId) {
    const key = `${PREFIX}${userId}`;
    const now = Date.now();
    const windowStart = now - this._windowMs;

    // Clean expired, then count
    await this._redis.zremrangebyscore(key, '-inf', windowStart);
    const current = await this._redis.zcard(key);

    return {
      current,
      limit: this._maxRequests,
      remaining: Math.max(0, this._maxRequests - current),
      windowMs: this._windowMs,
    };
  }

  /**
   * Reset rate limit for a user (admin action).
   * @param {string} userId
   */
  async reset(userId) {
    await this._redis.del(`${PREFIX}${userId}`);
  }
}

module.exports = { RedisRateLimiter };
