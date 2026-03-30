/**
 * redis-concurrency.js — Distributed concurrency governor using Redis.
 *
 * Replaces per-process Map counters with atomic Redis operations,
 * enabling shared concurrency limits across multiple Gateway instances.
 *
 * Redis keys:
 *   effy:cc:global               → current global count
 *   effy:cc:user:{userId}        → per-user count
 *   effy:cc:channel:{channelId}  → per-channel count
 *   effy:cc:lock:{requestId}     → lock record { userId, channelId, acquiredAt }
 *
 * @module state/redis-concurrency
 */
const { createLogger } = require('../shared/logger');
const _log = createLogger('state:redis-cc');

const PREFIX = 'effy:cc:';
const DEFAULT_LOCK_TTL_SEC = 300;  // 5 min safety expiry

// Lua: atomic acquire with 3-way limit check
const ACQUIRE_LUA = `
  local globalKey = KEYS[1]
  local userKey = KEYS[2]
  local channelKey = KEYS[3]
  local lockKey = KEYS[4]
  local globalLimit = tonumber(ARGV[1])
  local userLimit = tonumber(ARGV[2])
  local channelLimit = tonumber(ARGV[3])
  local ttl = tonumber(ARGV[4])
  local lockValue = ARGV[5]

  local globalCount = tonumber(redis.call('GET', globalKey) or '0')
  if globalCount >= globalLimit then
    return '{"granted":false,"reason":"global_limit","current":' .. globalCount .. '}'
  end

  local userCount = tonumber(redis.call('GET', userKey) or '0')
  if userCount >= userLimit then
    return '{"granted":false,"reason":"user_limit","current":' .. userCount .. '}'
  end

  local channelCount = tonumber(redis.call('GET', channelKey) or '0')
  if channelCount >= channelLimit then
    return '{"granted":false,"reason":"channel_limit","current":' .. channelCount .. '}'
  end

  redis.call('INCR', globalKey)
  redis.call('EXPIRE', globalKey, ttl)
  redis.call('INCR', userKey)
  redis.call('EXPIRE', userKey, ttl)
  redis.call('INCR', channelKey)
  redis.call('EXPIRE', channelKey, ttl)
  redis.call('SET', lockKey, lockValue, 'EX', ttl)

  return '{"granted":true}'
`;

// Lua: atomic release (idempotent — only decrements if lock exists)
const RELEASE_LUA = `
  local lockKey = KEYS[1]
  local globalKey = KEYS[2]
  local userPrefix = ARGV[1]
  local channelPrefix = ARGV[2]

  local lockData = redis.call('GET', lockKey)
  if not lockData then return 0 end

  local lock = cjson.decode(lockData)
  local userKey = userPrefix .. lock.userId
  local channelKey = channelPrefix .. lock.channelId

  local g = redis.call('DECR', globalKey)
  if g < 0 then redis.call('SET', globalKey, '0') end
  local u = redis.call('DECR', userKey)
  if u < 0 then redis.call('SET', userKey, '0') end
  local c = redis.call('DECR', channelKey)
  if c < 0 then redis.call('SET', channelKey, '0') end

  redis.call('DEL', lockKey)
  return 1
`;

class RedisConcurrencyGovernor {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {Object} [config]
   * @param {number} [config.global=20] - Max global concurrent requests
   * @param {number} [config.perUser=2] - Max per-user concurrent requests
   * @param {number} [config.perChannel=3] - Max per-channel concurrent requests
   * @param {number} [config.lockTtlSec=300] - Safety TTL for lock keys
   */
  constructor(redis, config = {}) {
    this._redis = redis;
    this._limits = {
      global: config.global || 20,
      perUser: config.perUser || 2,
      perChannel: config.perChannel || 3,
    };
    this._lockTtlSec = config.lockTtlSec || DEFAULT_LOCK_TTL_SEC;
  }

  /**
   * Acquire a concurrency slot.
   * @param {string} requestId - Unique request identifier
   * @param {string} userId - User requesting
   * @param {string} channelId - Channel of the request
   * @returns {Promise<{ granted: boolean, reason?: string }>}
   */
  async acquire(requestId, userId, channelId) {
    const result = await this._redis.eval(
      ACQUIRE_LUA, 4,
      `${PREFIX}global`,
      `${PREFIX}user:${userId}`,
      `${PREFIX}channel:${channelId}`,
      `${PREFIX}lock:${requestId}`,
      this._limits.global,
      this._limits.perUser,
      this._limits.perChannel,
      this._lockTtlSec,
      JSON.stringify({ userId, channelId, acquiredAt: Date.now() })
    );
    return JSON.parse(result);
  }

  /**
   * Release a concurrency slot.
   * Idempotent: safe to call multiple times.
   * @param {string} requestId
   * @returns {Promise<boolean>} - true if released, false if already released
   */
  async release(requestId) {
    const result = await this._redis.eval(
      RELEASE_LUA, 2,
      `${PREFIX}lock:${requestId}`,
      `${PREFIX}global`,
      `${PREFIX}user:`,
      `${PREFIX}channel:`
    );
    return result === 1;
  }

  /**
   * Get current concurrency status.
   * @returns {Promise<{ globalActive: number, limits: Object }>}
   */
  async getStatus() {
    const global = await this._redis.get(`${PREFIX}global`) || '0';
    return {
      globalActive: parseInt(global, 10),
      limits: { ...this._limits },
    };
  }
}

module.exports = { RedisConcurrencyGovernor };
