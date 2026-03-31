/**
 * state-backend.js — StateBackendFactory with graceful degradation.
 *
 * Creates the appropriate state backend instances based on available infrastructure.
 * Priority: Redis → PostgreSQL → In-Memory (local)
 *
 * If Redis becomes unavailable at runtime, automatically falls back.
 * All modules share the same Redis/PG connections.
 *
 * Usage:
 *   const factory = new StateBackendFactory(config);
 *   await factory.initialize();
 *   const wm = factory.createWorkingMemory();
 *   const cc = factory.createConcurrencyGovernor();
 *   const rl = factory.createRateLimiter();
 *   const cb = factory.createCircuitBreaker();
 *   const ec = factory.createEmbeddingCache();
 *
 * @module state/state-backend
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('state:backend');

// Redis-backed implementations
const { RedisWorkingMemory } = require('./redis-working-memory');
const { RedisConcurrencyGovernor } = require('./redis-concurrency');
const { RedisRateLimiter } = require('./redis-rate-limit');
const { RedisCircuitBreakerState } = require('./redis-circuit-breaker');
const { TieredEmbeddingCache } = require('./tiered-embedding-cache');

// ─── Local (in-memory) fallback implementations ───

class LocalWorkingMemory {
  constructor(options = {}) {
    this._store = new Map();
    this._ttlMs = (options.ttlSec || 1800) * 1000;
    this._maxEntries = options.maxEntries || 50;
    this._timers = new Map();
  }

  async append(convKey, entry) {
    let conv = this._store.get(convKey);
    if (!conv) {
      conv = { entries: [], needsSummary: false, updatedAt: null };
      this._store.set(convKey, conv);
    }
    conv.entries.push(entry);
    if (conv.entries.length > this._maxEntries) {
      conv.entries = conv.entries.slice(-this._maxEntries);
    }
    conv.updatedAt = new Date().toISOString();
    if (conv.entries.length > this._maxEntries * 0.8) {
      conv.needsSummary = true;
    }
    // Reset TTL timer
    if (this._timers.has(convKey)) clearTimeout(this._timers.get(convKey));
    this._timers.set(convKey, setTimeout(() => this.clear(convKey), this._ttlMs));
    return conv.entries.length;
  }

  async get(convKey) {
    return this._store.get(convKey) || null;
  }

  async clear(convKey) {
    this._store.delete(convKey);
    if (this._timers.has(convKey)) {
      clearTimeout(this._timers.get(convKey));
      this._timers.delete(convKey);
    }
    return 1;
  }

  async setNeedsSummary(convKey, value) {
    const conv = this._store.get(convKey);
    if (conv) conv.needsSummary = value;
  }

  async touch(_convKey) { /* No-op for local — timer already handles TTL */ }

  async listActive() { return [...this._store.keys()]; }
  async getStats() { return { activeConversations: this._store.size }; }

  shutdown() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    this._store.clear();
  }
}

class LocalConcurrencyGovernor {
  constructor(config = {}) {
    this._limits = { global: config.global || 20, perUser: config.perUser || 2, perChannel: config.perChannel || 3 };
    this._global = 0;
    this._users = new Map();
    this._channels = new Map();
    this._locks = new Map();
  }

  async acquire(requestId, userId, channelId) {
    if (this._global >= this._limits.global) return { granted: false, reason: 'global_limit' };
    const userCount = this._users.get(userId) || 0;
    if (userCount >= this._limits.perUser) return { granted: false, reason: 'user_limit' };
    const channelCount = this._channels.get(channelId) || 0;
    if (channelCount >= this._limits.perChannel) return { granted: false, reason: 'channel_limit' };

    this._global++;
    this._users.set(userId, userCount + 1);
    this._channels.set(channelId, channelCount + 1);
    this._locks.set(requestId, { userId, channelId });
    return { granted: true };
  }

  async release(requestId) {
    const lock = this._locks.get(requestId);
    if (!lock) return false;
    this._global = Math.max(0, this._global - 1);
    this._users.set(lock.userId, Math.max(0, (this._users.get(lock.userId) || 1) - 1));
    this._channels.set(lock.channelId, Math.max(0, (this._channels.get(lock.channelId) || 1) - 1));
    this._locks.delete(requestId);
    return true;
  }

  async getStatus() { return { globalActive: this._global, limits: { ...this._limits } }; }
}

class LocalRateLimiter {
  constructor(config = {}) {
    this._windowMs = config.windowMs || 60000;
    this._maxRequests = config.maxRequests || 30;
    this._windows = new Map();  // userId → [timestamps]
  }

  async check(userId, _requestId) {
    const now = Date.now();
    const windowStart = now - this._windowMs;
    let timestamps = this._windows.get(userId) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= this._maxRequests) {
      return { allowed: false, remaining: 0, retryAfterMs: timestamps[0] + this._windowMs - now };
    }
    timestamps.push(now);
    this._windows.set(userId, timestamps);
    return { allowed: true, remaining: this._maxRequests - timestamps.length };
  }

  async getStatus(userId) {
    const timestamps = (this._windows.get(userId) || []).filter(t => t > Date.now() - this._windowMs);
    return { current: timestamps.length, limit: this._maxRequests, remaining: this._maxRequests - timestamps.length };
  }

  async reset(userId) { this._windows.delete(userId); }
}

class LocalCircuitBreakerState {
  constructor(config = {}) {
    this._breakers = new Map();
    this._threshold = config.failureThreshold || 5;
    this._resetMs = config.resetTimeoutMs || 30000;
  }

  async isOpen(key) {
    const b = this._breakers.get(key);
    if (!b || b.state === 'CLOSED') return false;
    if (b.state === 'OPEN' && Date.now() - b.openedAt > this._resetMs) {
      b.state = 'HALF_OPEN';
      return false;
    }
    return b.state === 'OPEN';
  }

  async recordSuccess(key) {
    const b = this._getOrCreate(key);
    b.consecutiveFailures = 0;
    b.state = 'CLOSED';
  }

  async recordFailure(key, error = {}) {
    const b = this._getOrCreate(key);
    b.consecutiveFailures++;
    b.lastError = error;
    if (b.consecutiveFailures >= this._threshold) {
      b.state = 'OPEN';
      b.openedAt = Date.now();
    }
  }

  async getState(key) {
    return this._breakers.get(key) || { state: 'CLOSED', consecutiveFailures: 0, lastError: null };
  }

  async getAllStates() {
    const result = {};
    for (const [k, v] of this._breakers) result[k] = { ...v };
    return result;
  }

  async reset(key) { this._breakers.delete(key); }

  _getOrCreate(key) {
    if (!this._breakers.has(key)) {
      this._breakers.set(key, { state: 'CLOSED', consecutiveFailures: 0, consecutiveSuccesses: 0, openedAt: 0, lastError: null });
    }
    return this._breakers.get(key);
  }
}

class LocalEmbeddingCache {
  constructor() {
    this._cache = new Map();
    this._stats = { localHits: 0, redisHits: 0, misses: 0 };
  }
  async get(hash) {
    const entry = this._cache.get(hash);
    if (entry) { this._stats.localHits++; return entry; }
    this._stats.misses++;
    return null;
  }
  async set(hash, embedding) { this._cache.set(hash, embedding); }
  async invalidate(hash) { this._cache.delete(hash); }
  getStats() {
    const total = this._stats.localHits + this._stats.misses;
    return { ...this._stats, total, hitRate: total > 0 ? (this._stats.localHits / total * 100).toFixed(1) + '%' : 'N/A', localSize: this._cache.size };
  }
  clearLocal() { this._cache.clear(); }
}

// ─── Factory ───

class StateBackendFactory {
  /**
   * @param {Object} config
   * @param {Object} [config.redis] - { host, port, prefix, password }
   * @param {Object} [config.concurrency] - { global, perUser, perChannel }
   * @param {Object} [config.rateLimit] - { windowMs, maxRequests }
   * @param {Object} [config.circuitBreaker] - { failureThreshold, resetTimeoutMs }
   * @param {Object} [config.embeddingCache] - { localMax, redisTtlSec }
   */
  constructor(config = {}) {
    this._config = config;
    this._redis = null;
    this._mode = 'local';  // 'redis' | 'local'
    this._redisHealthy = false;
    this._healthInterval = null;
  }

  /**
   * Initialize the factory. Connects to Redis if configured.
   */
  async initialize() {
    if (this._config.redis) {
      try {
        const Redis = require('ioredis');
        this._redis = new Redis({
          host: this._config.redis.host || 'localhost',
          port: this._config.redis.port || 6379,
          password: this._config.redis.password || undefined,
          keyPrefix: this._config.redis.prefix || '',
          maxRetriesPerRequest: 3,
          retryStrategy: (times) => Math.min(times * 200, 3000),
          lazyConnect: true,
        });

        await this._redis.connect();
        await this._redis.ping();
        this._redisHealthy = true;
        this._mode = 'redis';
        log.info('State backend: Redis connected');

        // Health monitoring
        this._healthInterval = setInterval(() => this._checkRedisHealth(), 10000);
      } catch (err) {
        log.warn('State backend: Redis unavailable, using local fallback', { error: err.message });
        this._redis = null;
        this._mode = 'local';
      }
    } else {
      log.info('State backend: No Redis configured, using local mode');
    }
  }

  async _checkRedisHealth() {
    if (!this._redis) return;
    try {
      await this._redis.ping();
      if (!this._redisHealthy) {
        log.info('State backend: Redis recovered');
        this._redisHealthy = true;
        this._mode = 'redis';
      }
    } catch (e) {
      if (this._redisHealthy) {
        log.warn('State backend: Redis down, falling back to local');
        this._redisHealthy = false;
        this._mode = 'local';
      }
    }
  }

  /** @returns {'redis'|'local'} */
  get mode() { return this._mode; }

  createWorkingMemory(options) {
    if (this._mode === 'redis') return new RedisWorkingMemory(this._redis, options);
    return new LocalWorkingMemory(options);
  }

  createConcurrencyGovernor(config) {
    const cc = config || this._config.concurrency;
    if (this._mode === 'redis') return new RedisConcurrencyGovernor(this._redis, cc);
    return new LocalConcurrencyGovernor(cc);
  }

  createRateLimiter(config) {
    const rl = config || this._config.rateLimit;
    if (this._mode === 'redis') return new RedisRateLimiter(this._redis, rl);
    return new LocalRateLimiter(rl);
  }

  createCircuitBreaker(config) {
    const cb = config || this._config.circuitBreaker;
    if (this._mode === 'redis') return new RedisCircuitBreakerState(this._redis, cb);
    return new LocalCircuitBreakerState(cb);
  }

  createEmbeddingCache(options) {
    const ec = options || this._config.embeddingCache;
    if (this._mode === 'redis') return new TieredEmbeddingCache(this._redis, ec);
    return new LocalEmbeddingCache();
  }

  /**
   * Shutdown: close Redis connection, clear intervals.
   */
  async shutdown() {
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
    if (this._redis) {
      await this._redis.quit().catch(() => {});
      this._redis = null;
    }
  }
}

module.exports = {
  StateBackendFactory,
  // Direct exports for targeted usage
  LocalWorkingMemory,
  LocalConcurrencyGovernor,
  LocalRateLimiter,
  LocalCircuitBreakerState,
  LocalEmbeddingCache,
};
