/**
 * redis-circuit-breaker.js — Shared circuit breaker state via Redis.
 *
 * Enables circuit breaker state to be visible across all Gateway instances.
 * State machine: CLOSED → OPEN → HALF_OPEN → CLOSED
 *
 * Redis key: effy:cb:{key} → Hash {
 *   state: 'CLOSED' | 'OPEN' | 'HALF_OPEN',
 *   consecutiveFailures: number,
 *   consecutiveSuccesses: number,
 *   openedAt: timestamp (ms),
 *   lastError: JSON string,
 * }
 *
 * @module state/redis-circuit-breaker
 */
const { createLogger } = require('../shared/logger');
const _log = createLogger('state:redis-cb');

const PREFIX = 'effy:cb:';
const KEY_TTL_SEC = 3600;  // Cleanup after 1 hour of no activity

// Lua: record failure + auto-trip
const RECORD_FAILURE_LUA = `
  local key = KEYS[1]
  local threshold = tonumber(ARGV[1])
  local errorJson = ARGV[2]
  local now = ARGV[3]

  local failures = redis.call('HINCRBY', key, 'consecutiveFailures', 1)
  redis.call('HSET', key, 'consecutiveSuccesses', '0')
  redis.call('HSET', key, 'lastError', errorJson)

  if failures >= threshold then
    redis.call('HSET', key, 'state', 'OPEN')
    redis.call('HSET', key, 'openedAt', now)
  end

  redis.call('EXPIRE', key, tonumber(ARGV[4]))
  return failures
`;

// Lua: record success + auto-close
const RECORD_SUCCESS_LUA = `
  local key = KEYS[1]
  local ttl = tonumber(ARGV[1])

  redis.call('HSET', key, 'consecutiveFailures', '0')
  local successes = redis.call('HINCRBY', key, 'consecutiveSuccesses', 1)

  local state = redis.call('HGET', key, 'state')
  if state == 'HALF_OPEN' or state == 'OPEN' then
    redis.call('HSET', key, 'state', 'CLOSED')
  end

  redis.call('EXPIRE', key, ttl)
  return successes
`;

class RedisCircuitBreakerState {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {Object} [config]
   * @param {number} [config.failureThreshold=5] - Consecutive failures before opening
   * @param {number} [config.resetTimeoutMs=30000] - Time in OPEN before testing HALF_OPEN
   * @param {Object} [config.categoryOverrides] - Per-error-category thresholds
   */
  constructor(redis, config = {}) {
    this._redis = redis;
    this._config = {
      failureThreshold: config.failureThreshold || 5,
      resetTimeoutMs: config.resetTimeoutMs || 30000,
      categoryOverrides: config.categoryOverrides || {
        rate_limit:     { resetTimeoutMs: 60000 },
        auth:           { resetTimeoutMs: Infinity },
        quota_exceeded: { resetTimeoutMs: 300000 },
      },
    };
  }

  /**
   * Check if circuit is open (requests should not be sent).
   * Auto-transitions OPEN → HALF_OPEN if reset timeout elapsed.
   *
   * @param {string} breakerKey - e.g. 'anthropic:claude-sonnet-4' or 'agent:researcher'
   * @returns {Promise<boolean>} - true if OPEN (block requests)
   */
  async isOpen(breakerKey) {
    const key = PREFIX + breakerKey;
    const state = await this._redis.hget(key, 'state');
    if (!state || state === 'CLOSED') return false;

    if (state === 'OPEN') {
      const openedAt = parseInt(await this._redis.hget(key, 'openedAt') || '0', 10);
      const resetMs = this._config.resetTimeoutMs;

      if (Date.now() - openedAt > resetMs) {
        // Transition to HALF_OPEN
        await this._redis.hset(key, 'state', 'HALF_OPEN');
        return false;
      }
      return true;
    }

    return false;  // HALF_OPEN allows test requests
  }

  /**
   * Record a successful operation.
   * Resets failure count and closes circuit if in HALF_OPEN.
   *
   * @param {string} breakerKey
   */
  async recordSuccess(breakerKey) {
    const key = PREFIX + breakerKey;
    await this._redis.eval(
      RECORD_SUCCESS_LUA, 1, key,
      KEY_TTL_SEC
    );
  }

  /**
   * Record a failed operation.
   * Increments failure count; opens circuit if threshold exceeded.
   *
   * @param {string} breakerKey
   * @param {Object} classifiedError - { category, message, ... }
   */
  async recordFailure(breakerKey, classifiedError = {}) {
    const key = PREFIX + breakerKey;
    const category = classifiedError.category || 'unknown';
    const override = this._config.categoryOverrides[category];
    const threshold = override?.failureThreshold || this._config.failureThreshold;

    await this._redis.eval(
      RECORD_FAILURE_LUA, 1, key,
      threshold,
      JSON.stringify({ category, message: classifiedError.message || '' }),
      String(Date.now()),
      KEY_TTL_SEC
    );
  }

  /**
   * Get state for a specific breaker.
   * @param {string} breakerKey
   * @returns {Promise<{ state: string, consecutiveFailures: number, lastError: Object|null }>}
   */
  async getState(breakerKey) {
    const key = PREFIX + breakerKey;
    const data = await this._redis.hgetall(key);
    if (!data || !data.state) {
      return { state: 'CLOSED', consecutiveFailures: 0, lastError: null };
    }
    return {
      state: data.state,
      consecutiveFailures: parseInt(data.consecutiveFailures || '0', 10),
      consecutiveSuccesses: parseInt(data.consecutiveSuccesses || '0', 10),
      openedAt: parseInt(data.openedAt || '0', 10),
      lastError: data.lastError ? JSON.parse(data.lastError) : null,
    };
  }

  /**
   * Get status of all active breakers (for monitoring dashboard).
   * @returns {Promise<Object>} - { breakerKey: { state, failures, ... }, ... }
   */
  async getAllStates() {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this._redis.scan(
        cursor, 'MATCH', PREFIX + '*', 'COUNT', 100
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    const states = {};
    if (keys.length === 0) return states;

    const pipe = this._redis.pipeline();
    keys.forEach(k => pipe.hgetall(k));
    const results = await pipe.exec();

    keys.forEach((key, i) => {
      const [err, data] = results[i];
      if (!err && data) {
        const id = key.slice(PREFIX.length);
        states[id] = {
          state: data.state || 'CLOSED',
          consecutiveFailures: parseInt(data.consecutiveFailures || '0', 10),
          lastError: data.lastError ? JSON.parse(data.lastError) : null,
        };
      }
    });

    return states;
  }

  /**
   * Manually reset a breaker (admin action).
   * @param {string} breakerKey
   */
  async reset(breakerKey) {
    await this._redis.del(PREFIX + breakerKey);
  }
}

module.exports = { RedisCircuitBreakerState };
