/**
 * state-adapters.js — Gateway-compatible adapters for StateBackendFactory.
 *
 * Bridges the async, distributed-ready state backend API to the synchronous,
 * single-process API that Gateway currently expects.
 *
 * Pattern: Each adapter wraps a Local* or Redis* backend, exposing the
 * same method signatures the Gateway pipeline uses today. This allows
 * Gateway to work with either in-process or Redis-backed state transparently.
 *
 * @module gateway/state-adapters
 */
const { createLogger } = require('../shared/logger');
const { summarizationQueue } = require('../shared/summarization-queue');
const {
  LocalWorkingMemory,
  LocalConcurrencyGovernor,
  LocalRateLimiter,
  LocalCircuitBreakerState,
  LocalEmbeddingCache,
} = require('../state/state-backend');

const log = createLogger('gateway:state');

// ═══════════════════════════════════════════════════════════════
// GatewayWorkingMemory — wraps Local/RedisWorkingMemory
// ═══════════════════════════════════════════════════════════════

/**
 * Adapts the async LocalWorkingMemory/RedisWorkingMemory to the
 * synchronous add/get/clear/replace API that Gateway expects.
 *
 * Strategy: Maintain a local cache that syncs to the backend.
 * add() and get() are synchronous (reading from cache).
 * Backend sync happens fire-and-forget on writes.
 *
 * For single-instance mode, the local cache IS the source of truth.
 * For multi-instance (Redis), the cache is write-through — reads also
 * serve from the async backend, populated eagerly on first access.
 */
class GatewayWorkingMemory {
  /**
   * @param {LocalWorkingMemory|RedisWorkingMemory} backend
   * @param {Object} [options]
   * @param {number} [options.maxEntries=50]
   * @param {number} [options.ttlMs=1800000]
   * @param {boolean} [options.summarizationEnabled=true]
   * @param {number} [options.summarizeThreshold=30]
   * @param {number} [options.keepRecent=10]
   * @param {number} [options.maxSummaryTokens=500]
   */
  constructor(backend, options = {}) {
    this._backend = backend;
    this._cache = new Map(); // conversationKey → { entries: [], needsSummary: false }
    this._timers = new Map();
    this._dirtyKeys = new Set(); // CE-2: dirty-tracking for failed backend writes
    this.maxEntries = options.maxEntries || 50;
    this.ttlMs = options.ttlMs || 30 * 60 * 1000;

    // Summarization config (same as original WorkingMemory)
    this.summarizationEnabled = options.summarizationEnabled !== false;
    this.summarizeThreshold = options.summarizeThreshold ?? 30;
    this.keepRecent = options.keepRecent ?? 10;
    this.maxSummaryTokens = options.maxSummaryTokens ?? 500;
  }

  /**
   * Add entry to working memory (sync — mirrors original WorkingMemory.add).
   * Writes to local cache immediately, syncs to backend fire-and-forget.
   */
  add(conversationKey, entry) {
    let bucket = this._cache.get(conversationKey);
    if (!bucket) {
      bucket = { entries: [], needsSummary: false };
      this._cache.set(conversationKey, bucket);
    }

    // Reset TTL timer
    if (this._timers.has(conversationKey)) clearTimeout(this._timers.get(conversationKey));
    this._timers.set(conversationKey, setTimeout(() => {
      this._cache.delete(conversationKey);
      this._timers.delete(conversationKey);
    }, this.ttlMs));

    bucket.entries.push({ ...entry, timestamp: Date.now() });

    // Summarization flag
    if (this.summarizationEnabled && bucket.entries.length > this.summarizeThreshold) {
      bucket.needsSummary = true;
    }

    // Trim to max
    if (bucket.entries.length > this.maxEntries) {
      bucket.entries = bucket.entries.slice(-this.maxEntries);
    }

    // Fire-and-forget sync to backend — CE-2: mark dirty on failure, reconcile on success
    this._backend.append(conversationKey, entry)
      .then(() => {
        // Backend succeeded — attempt to reconcile any previously dirty keys
        if (this._dirtyKeys.size > 0) {
          this.reconcile().catch(() => {});
        }
      })
      .catch(err => {
        this._dirtyKeys.add(conversationKey);
        log.warn('Backend WM append failed, key marked dirty', { error: err.message, key: conversationKey, dirtyCount: this._dirtyKeys.size });
      });
  }

  /**
   * CE-2: Reconcile dirty keys by re-syncing local cache to backend.
   * Called automatically on next successful backend operation.
   * @returns {Promise<number>} number of keys reconciled
   */
  async reconcile() {
    if (this._dirtyKeys.size === 0) return 0;

    const keysToReconcile = [...this._dirtyKeys];
    let reconciled = 0;

    for (const key of keysToReconcile) {
      const bucket = this._cache.get(key);
      if (!bucket) {
        // Key was evicted from cache — nothing to reconcile
        this._dirtyKeys.delete(key);
        continue;
      }
      try {
        await this._backend.clear(key);
        for (const entry of bucket.entries) {
          await this._backend.append(key, entry);
        }
        this._dirtyKeys.delete(key);
        reconciled++;
      } catch (err) {
        log.warn('Reconcile failed for key, will retry later', { key, error: err.message });
        // Leave in dirtyKeys for next reconcile attempt
      }
    }

    if (reconciled > 0) {
      log.info('Reconciled dirty keys', { reconciled, remaining: this._dirtyKeys.size });
    }
    return reconciled;
  }

  /**
   * Get entries (sync — mirrors original WorkingMemory.get).
   * Returns entries array from local cache.
   */
  get(conversationKey) {
    const bucket = this._cache.get(conversationKey);
    return bucket ? bucket.entries : [];
  }

  /**
   * Clear conversation (sync — mirrors original WorkingMemory.clear).
   */
  clear(conversationKey) {
    if (this._timers.has(conversationKey)) {
      clearTimeout(this._timers.get(conversationKey));
      this._timers.delete(conversationKey);
    }
    this._cache.delete(conversationKey);

    // Fire-and-forget backend clear
    this._backend.clear(conversationKey).catch(err => {
      log.warn('Backend WM clear failed', { error: err.message, key: conversationKey });
    });
  }

  /**
   * Replace all entries (sync — mirrors original WorkingMemory.replace).
   */
  replace(conversationKey, newMessages) {
    // Build new data first before touching cache
    const newEntries = Array.isArray(newMessages)
      ? newMessages.filter(entry => entry !== null && entry !== undefined)
      : [];

    // Sync to backend: clear then re-append all; swap local cache only after Redis confirms
    this._backend.clear(conversationKey)
      .then(() => {
        const promises = newEntries.map(e => this._backend.append(conversationKey, e));
        return Promise.all(promises);
      })
      .then(() => {
        // Atomically swap local cache after backend confirms
        let bucket = this._cache.get(conversationKey);
        if (!bucket) {
          bucket = { entries: [], needsSummary: false };
          this._cache.set(conversationKey, bucket);
        }
        bucket.entries = newEntries;

        // Reset TTL
        if (this._timers.has(conversationKey)) clearTimeout(this._timers.get(conversationKey));
        this._timers.set(conversationKey, setTimeout(() => {
          this._cache.delete(conversationKey);
          this._timers.delete(conversationKey);
        }, this.ttlMs));
      })
      .catch(err => {
        // Backend failed — still update local cache as fallback for single-instance mode
        let bucket = this._cache.get(conversationKey);
        if (!bucket) {
          bucket = { entries: [], needsSummary: false };
          this._cache.set(conversationKey, bucket);
        }
        bucket.entries = newEntries;

        if (this._timers.has(conversationKey)) clearTimeout(this._timers.get(conversationKey));
        this._timers.set(conversationKey, setTimeout(() => {
          this._cache.delete(conversationKey);
          this._timers.delete(conversationKey);
        }, this.ttlMs));

        log.warn('Backend WM replace failed', { error: err.message, key: conversationKey });
      });
  }

  /**
   * Check if conversation needs summarization.
   * @param {string} conversationKey
   * @returns {boolean}
   */
  needsSummary(conversationKey) {
    const bucket = this._cache.get(conversationKey);
    return bucket ? bucket.needsSummary : false;
  }

  /**
   * Summarize long conversation (async — mirrors original WorkingMemory.maybeSummarize).
   */
  async maybeSummarize(conversationKey, anthropicClient, model) {
    const bucket = this._cache.get(conversationKey);
    if (!bucket || !bucket.needsSummary) return false;

    bucket.needsSummary = false;

    const entries = bucket.entries;
    const toSummarize = entries.slice(0, entries.length - this.keepRecent);
    if (toSummarize.length < 5) return false;

    try {
      const conversationText = toSummarize
        .map(e => `[${e.role}] ${e.content}`)
        .join('\n')
        .slice(0, 6000);

      // R2-PERF-4 fix: Route through SummarizationQueue to limit concurrent LLM calls
      const maxTokens = this.maxSummaryTokens;
      const response = await summarizationQueue.enqueue(() =>
        anthropicClient.messages.create({
          model,
          max_tokens: maxTokens,
          system: '이전 대화를 3-5문장으로 요약하세요. 핵심 결정사항, 논의된 주요 주제, 미해결 질문을 포함하세요. 요약문만 출력하세요.',
          messages: [{ role: 'user', content: conversationText }],
        })
      );

      // Queue was full → summarization dropped (non-critical, retry next turn)
      if (!response) return false;

      const summaryText = response.content[0]?.text || '';
      if (!summaryText) return false;

      const recent = entries.slice(-this.keepRecent);
      this.replace(conversationKey, [
        { role: 'assistant', content: `[이전 대화 요약]\n${summaryText}`, timestamp: Date.now() },
        ...recent,
      ]);

      log.info('Summarized', { entries: toSummarize.length, summaryLen: summaryText.length, conversationKey });
      return true;
    } catch (err) {
      log.warn('Summarization failed', { error: err.message, conversationKey });
      return false;
    }
  }

  /** Destroy all state — process shutdown. */
  destroy() {
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
    this._cache.clear();
    if (this._backend.shutdown) this._backend.shutdown();
  }

  get size() { return this._cache.size; }
}

// ═══════════════════════════════════════════════════════════════
// GatewayConcurrencyGovernor — wraps Local/RedisConcurrencyGovernor
// ═══════════════════════════════════════════════════════════════

/**
 * Adapts the async LocalConcurrencyGovernor/RedisConcurrencyGovernor to
 * the waitForSlot/release API that Gateway expects.
 *
 * The backend uses requestId-keyed locks; this adapter generates
 * requestIds from userId+channelId and manages the FIFO wait queue
 * just like the original ConcurrencyGovernor.
 */
class GatewayConcurrencyGovernor {
  /**
   * @param {LocalConcurrencyGovernor|RedisConcurrencyGovernor} backend
   */
  constructor(backend) {
    this._backend = backend;
    this._activeLocks = new Map(); // `${userId}:${channelId}:${lockId}` → requestId
    this._lockCounter = 0;
    this._queue = [];
    this._globalCount = 0;
  }

  /**
   * Wait for a concurrency slot (async — mirrors original waitForSlot).
   * @param {string} userId
   * @param {string} channelId
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<boolean>} true if acquired, false if timeout
   */
  async waitForSlot(userId, channelId, timeoutMs = 30_000) {
    const requestId = `${userId}:${channelId}:${++this._lockCounter}`;
    const result = await this._backend.acquire(requestId, userId, channelId);

    if (result.granted) {
      const lockKey = `${userId}:${channelId}`;
      // Check if a lock already exists for this key — queue instead of overwriting
      // CE-8: Release the backend slot first to prevent slot leak
      if (this._activeLocks.has(lockKey)) {
        this._backend.release(requestId).catch(err => {
          log.warn('Backend CC release failed for duplicate request', { error: err.message, lockKey });
        });
        return new Promise((resolve) => {
          const entry = { userId, channelId, resolve, done: false };
          const timer = setTimeout(() => {
            entry.done = true;
            resolve(false);
          }, timeoutMs);
          entry.timer = timer;
          this._queue.push(entry);
        });
      }
      this._activeLocks.set(lockKey, requestId);
      this._globalCount++;
      return true;
    }

    // Queue with timeout
    return new Promise((resolve) => {
      const entry = { userId, channelId, resolve, done: false };
      const timer = setTimeout(() => {
        entry.done = true;
        resolve(false);
      }, timeoutMs);
      entry.timer = timer;
      this._queue.push(entry);
    });
  }

  /**
   * Release a concurrency slot (sync fire-and-forget — mirrors original release).
   */
  release(userId, channelId) {
    const lockKey = `${userId}:${channelId}`;
    const requestId = this._activeLocks.get(lockKey);
    if (requestId) {
      this._activeLocks.delete(lockKey);
      this._globalCount = Math.max(0, this._globalCount - 1);
      this._backend.release(requestId)
        .then(() => this._drainQueue())
        .catch(err => {
          log.warn('Backend CC release failed', { error: err.message });
        });
    }
  }

  async _drainQueue() {
    const remaining = [];
    for (const entry of this._queue) {
      if (entry.done) continue;
      const requestId = `${entry.userId}:${entry.channelId}:${++this._lockCounter}`;
      const result = await this._backend.acquire(requestId, entry.userId, entry.channelId);
      if (result.granted) {
        this._activeLocks.set(`${entry.userId}:${entry.channelId}`, requestId);
        this._globalCount++;
        clearTimeout(entry.timer);
        entry.done = true;
        entry.resolve(true);
      } else {
        remaining.push(entry);
      }
    }
    this._queue = remaining;
  }

  /**
   * @returns {{ global: number, queued: number }}
   */
  get stats() {
    return {
      global: this._globalCount,
      queued: this._queue.filter(e => !e.done).length,
    };
  }

  /** Alias for stats.global used in graceful shutdown */
  get globalCount() { return this._globalCount; }
}

// ═══════════════════════════════════════════════════════════════
// GatewayStateBridge — factory that creates all Gateway state
// ═══════════════════════════════════════════════════════════════

/**
 * Creates all Gateway-compatible state instances from a single config.
 * Uses StateBackendFactory internally but can also create directly from
 * Local* classes (for synchronous initialization without Redis).
 *
 * Usage in app.js:
 *   const bridge = new GatewayStateBridge(config);
 *   const gateway = new Gateway({ stateBridge: bridge });
 */
class GatewayStateBridge {
  /**
   * @param {Object} config
   * @param {Object} [config.redis] - Redis config (if present, will use Redis backends)
   * @param {Object} [config.concurrency] - { global, perUser, perChannel }
   * @param {Object} [config.rateLimit] - { windowMs, maxRequests }
   * @param {Object} [config.circuitBreaker] - { failureThreshold, resetTimeoutMs }
   * @param {Object} [config.workingMemory] - { maxEntries, ttlSec, ... }
   */
  constructor(config = {}) {
    this._config = config;
    this._mode = 'local'; // Will be 'redis' after async init with Redis
    this._factory = null;

    // Create local backends synchronously (default)
    const wmBackend = new LocalWorkingMemory(config.workingMemory);
    const ccBackend = new LocalConcurrencyGovernor(config.concurrency);
    const rlBackend = new LocalRateLimiter(config.rateLimit);
    const cbBackend = new LocalCircuitBreakerState(config.circuitBreaker);
    const ecBackend = new LocalEmbeddingCache();

    // Create Gateway-compatible adapters
    this.workingMemory = new GatewayWorkingMemory(wmBackend, config.workingMemory);
    this.governor = new GatewayConcurrencyGovernor(ccBackend);
    this.rateLimiter = rlBackend;
    this.circuitBreakerState = cbBackend;
    this.embeddingCache = ecBackend;
  }

  /**
   * Async initialization — connects to Redis if configured.
   * Call this after construction to upgrade from local to Redis backends.
   */
  async initialize() {
    if (!this._config.redis) return;

    try {
      const { StateBackendFactory } = require('../state/state-backend');
      this._factory = new StateBackendFactory(this._config);
      await this._factory.initialize();

      if (this._factory.mode === 'redis') {
        this._rebuildAdapters('redis');
      }

      // CE-1: Listen for mode changes (Redis recovery/failure) and re-initialize adapters
      this._factory.on('modeChanged', (newMode) => {
        log.info(`StateBridge: factory mode changed to ${newMode}, re-initializing adapters`);
        this._rebuildAdapters(newMode);
      });
    } catch (err) {
      log.warn('StateBridge: Redis init failed, staying local', { error: err.message });
    }
  }

  /**
   * Rebuild all adapters from the factory for the given mode.
   * @param {'redis'|'local'} mode
   */
  _rebuildAdapters(mode) {
    this._mode = mode;

    if (mode === 'redis' && this._factory) {
      const wmBackend = this._factory.createWorkingMemory(this._config.workingMemory);
      const ccBackend = this._factory.createConcurrencyGovernor(this._config.concurrency);
      this.rateLimiter = this._factory.createRateLimiter(this._config.rateLimit);
      this.circuitBreakerState = this._factory.createCircuitBreaker(this._config.circuitBreaker);
      this.embeddingCache = this._factory.createEmbeddingCache(this._config.embeddingCache);

      this.workingMemory = new GatewayWorkingMemory(wmBackend, this._config.workingMemory);
      this.governor = new GatewayConcurrencyGovernor(ccBackend);

      log.info('StateBridge: upgraded to Redis mode');
    } else {
      // Fallback to local backends
      const wmBackend = new LocalWorkingMemory(this._config.workingMemory);
      const ccBackend = new LocalConcurrencyGovernor(this._config.concurrency);
      const rlBackend = new LocalRateLimiter(this._config.rateLimit);
      const cbBackend = new LocalCircuitBreakerState(this._config.circuitBreaker);
      const ecBackend = new LocalEmbeddingCache();

      this.workingMemory = new GatewayWorkingMemory(wmBackend, this._config.workingMemory);
      this.governor = new GatewayConcurrencyGovernor(ccBackend);
      this.rateLimiter = rlBackend;
      this.circuitBreakerState = cbBackend;
      this.embeddingCache = ecBackend;

      log.info('StateBridge: downgraded to local mode');
    }
  }

  /** Alias so Gateway can access governor as stateBridge.concurrencyGovernor */
  get concurrencyGovernor() { return this.governor; }

  /** @returns {'redis'|'local'} */
  get mode() { return this._mode; }

  /** Shutdown all resources */
  shutdown() {
    this.workingMemory.destroy();
    if (this._factory) {
      this._factory.shutdown().catch(() => {});
    }
  }
}

module.exports = {
  GatewayWorkingMemory,
  GatewayConcurrencyGovernor,
  GatewayStateBridge,
};
