/**
 * tiered-embedding-cache.js — Two-level embedding cache (Local LRU + Redis).
 *
 * L1: Process-local Map (fast, ~50MB, 1-hour TTL)
 * L2: Redis (shared across instances, ~500MB, 7-day TTL)
 *
 * Lookup: L1 → L2 → API (miss → write-back to both levels)
 *
 * @module state/tiered-embedding-cache
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('state:embed-cache');

const PREFIX = 'effy:embed:';
const DEFAULT_LOCAL_MAX = 2000;
const DEFAULT_LOCAL_TTL_MS = 3600000;     // 1 hour
const DEFAULT_REDIS_TTL_SEC = 604800;     // 7 days

class TieredEmbeddingCache {
  /**
   * @param {import('ioredis').Redis} redis
   * @param {Object} [options]
   * @param {number} [options.localMax=2000] - Max local cache entries
   * @param {number} [options.localTtlMs=3600000] - Local entry TTL
   * @param {number} [options.redisTtlSec=604800] - Redis entry TTL
   */
  constructor(redis, options = {}) {
    this._redis = redis;
    this._redisTtlSec = options.redisTtlSec || DEFAULT_REDIS_TTL_SEC;

    // L1: Simple Map-based LRU with TTL
    this._local = new Map();
    this._localMax = options.localMax || DEFAULT_LOCAL_MAX;
    this._localTtlMs = options.localTtlMs || DEFAULT_LOCAL_TTL_MS;

    this._stats = { localHits: 0, redisHits: 0, misses: 0 };
  }

  /**
   * Get a cached embedding.
   * @param {string} textHash - Hash of the text content
   * @returns {Promise<Float32Array|null>}
   */
  async get(textHash) {
    // L1: local check
    const localEntry = this._local.get(textHash);
    if (localEntry && Date.now() - localEntry.cachedAt < this._localTtlMs) {
      this._stats.localHits++;
      return localEntry.embedding;
    }
    if (localEntry) {
      this._local.delete(textHash);  // Expired
    }

    // L2: Redis check
    const key = PREFIX + textHash;
    try {
      const raw = await this._redis.getBuffer(key);
      if (raw && raw.length > 0) {
        const embedding = new Float32Array(
          raw.buffer, raw.byteOffset, raw.length / 4
        );
        // Promote to L1
        this._setLocal(textHash, embedding);
        this._stats.redisHits++;
        return embedding;
      }
    } catch (err) {
      log.warn('Redis cache read failed, continuing to API', { error: err.message });
    }

    this._stats.misses++;
    return null;
  }

  /**
   * Store an embedding in both cache levels.
   * @param {string} textHash
   * @param {Float32Array} embedding
   */
  async set(textHash, embedding) {
    // L1: local
    this._setLocal(textHash, embedding);

    // L2: Redis (as raw Buffer)
    const key = PREFIX + textHash;
    try {
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
      await this._redis.setex(key, this._redisTtlSec, buffer);
    } catch (err) {
      log.warn('Redis cache write failed', { error: err.message });
    }
  }

  /**
   * Set in local LRU with eviction.
   * @private
   */
  _setLocal(textHash, embedding) {
    // Evict oldest if at capacity
    if (this._local.size >= this._localMax) {
      const oldestKey = this._local.keys().next().value;
      this._local.delete(oldestKey);
    }
    this._local.set(textHash, { embedding, cachedAt: Date.now() });
  }

  /**
   * Invalidate a specific entry.
   * @param {string} textHash
   */
  async invalidate(textHash) {
    this._local.delete(textHash);
    await this._redis.del(PREFIX + textHash);
  }

  /**
   * Get cache statistics.
   * @returns {{ localHits: number, redisHits: number, misses: number, hitRate: string, localSize: number }}
   */
  getStats() {
    const total = this._stats.localHits + this._stats.redisHits + this._stats.misses;
    return {
      ...this._stats,
      total,
      hitRate: total > 0
        ? ((this._stats.localHits + this._stats.redisHits) / total * 100).toFixed(1) + '%'
        : 'N/A',
      localSize: this._local.size,
      localMax: this._localMax,
    };
  }

  /**
   * Clear all local cache entries.
   */
  clearLocal() {
    this._local.clear();
  }
}

module.exports = { TieredEmbeddingCache };
