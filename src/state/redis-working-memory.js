/**
 * redis-working-memory.js — L1 Working Memory externalized to Redis.
 *
 * Replaces the process-local Map in WorkingMemory with Redis Hashes,
 * enabling multi-instance sharing and crash recovery.
 *
 * Redis structure per conversation:
 *   effy:wm:{convKey} → Hash {
 *     entries: JSON array of messages,
 *     needsSummary: "0" | "1",
 *     updatedAt: ISO timestamp,
 *   }
 *   TTL: 30 minutes (reset on every write)
 *
 * @module state/redis-working-memory
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('state:redis-wm');

const PREFIX = 'effy:wm:';
const DEFAULT_TTL_SEC = 1800;  // 30 minutes
const MAX_ENTRIES = 50;

// Lua script: atomic append with trim + TTL reset
const APPEND_LUA = `
  local key = KEYS[1]
  local entry = ARGV[1]
  local maxEntries = tonumber(ARGV[2])
  local ttlSec = tonumber(ARGV[3])
  local now = ARGV[4]

  local raw = redis.call('HGET', key, 'entries')
  local entries = raw and cjson.decode(raw) or {}

  table.insert(entries, cjson.decode(entry))

  while #entries > maxEntries do
    table.remove(entries, 1)
  end

  redis.call('HSET', key, 'entries', cjson.encode(entries))
  redis.call('HSET', key, 'updatedAt', now)

  if #entries > math.floor(maxEntries * 0.8) then
    redis.call('HSET', key, 'needsSummary', '1')
  end

  redis.call('EXPIRE', key, ttlSec)
  return #entries
`;

class RedisWorkingMemory {
  /**
   * @param {import('ioredis').Redis} redis - ioredis client instance
   * @param {Object} [options]
   * @param {number} [options.ttlSec=1800] - TTL in seconds (30 min default)
   * @param {number} [options.maxEntries=50] - Max entries per conversation
   */
  constructor(redis, options = {}) {
    this._redis = redis;
    this._ttlSec = options.ttlSec || DEFAULT_TTL_SEC;
    this._maxEntries = options.maxEntries || MAX_ENTRIES;
  }

  /**
   * Append a message entry to a conversation's working memory.
   * Atomic: uses Lua script for read-modify-write.
   *
   * @param {string} convKey - Conversation key (e.g. 'dm:U001:C001:ts')
   * @param {Object} entry - { role, content, timestamp }
   * @returns {Promise<number>} - Current entry count
   */
  async append(convKey, entry) {
    const key = PREFIX + convKey;
    try {
      const count = await this._redis.eval(
        APPEND_LUA, 1, key,
        JSON.stringify(entry),
        String(this._maxEntries),
        String(this._ttlSec),
        new Date().toISOString()
      );
      return count;
    } catch (err) {
      log.error('append failed', { convKey, error: err.message });
      throw err;
    }
  }

  /**
   * Get all entries for a conversation.
   * @param {string} convKey
   * @returns {Promise<{ entries: Object[], needsSummary: boolean, updatedAt: string } | null>}
   */
  async get(convKey) {
    const key = PREFIX + convKey;
    const data = await this._redis.hgetall(key);
    if (!data || !data.entries) return null;

    return {
      entries: JSON.parse(data.entries),
      needsSummary: data.needsSummary === '1',
      updatedAt: data.updatedAt || null,
    };
  }

  /**
   * Clear a conversation's working memory (e.g. after L1→L2 promotion).
   * @param {string} convKey
   * @returns {Promise<number>} - 1 if deleted, 0 if not found
   */
  async clear(convKey) {
    return this._redis.del(PREFIX + convKey);
  }

  /**
   * Set the needsSummary flag.
   * @param {string} convKey
   * @param {boolean} value
   */
  async setNeedsSummary(convKey, value) {
    const key = PREFIX + convKey;
    const exists = await this._redis.exists(key);
    if (!exists) return;
    await this._redis.hset(key, 'needsSummary', value ? '1' : '0');
  }

  /**
   * Touch the TTL without modifying entries (keep conversation alive).
   * @param {string} convKey
   */
  async touch(convKey) {
    await this._redis.expire(PREFIX + convKey, this._ttlSec);
  }

  /**
   * List all active conversation keys (for monitoring / admin).
   * Uses SCAN to avoid blocking.
   * @returns {Promise<string[]>}
   */
  async listActive() {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await this._redis.scan(
        cursor, 'MATCH', PREFIX + '*', 'COUNT', 100
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys.map(k => k.slice(PREFIX.length));
  }

  /**
   * Get stats for monitoring.
   * @returns {Promise<{ activeConversations: number }>}
   */
  async getStats() {
    const keys = await this.listActive();
    return { activeConversations: keys.length };
  }
}

module.exports = { RedisWorkingMemory };
