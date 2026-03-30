/**
 * state/index.js — Unified entry point for all state management modules.
 *
 * Usage:
 *   const { StateBackendFactory } = require('./state');
 *   const factory = new StateBackendFactory({ redis: { host: 'localhost' } });
 *   await factory.initialize();
 *
 *   const wm = factory.createWorkingMemory();
 *   const cc = factory.createConcurrencyGovernor();
 *   const rl = factory.createRateLimiter();
 *   const cb = factory.createCircuitBreaker();
 *   const ec = factory.createEmbeddingCache();
 *
 * @module state
 */

// Factory (recommended entry point)
const {
  StateBackendFactory,
  LocalWorkingMemory,
  LocalConcurrencyGovernor,
  LocalRateLimiter,
  LocalCircuitBreakerState,
  LocalEmbeddingCache,
} = require('./state-backend');

// Redis implementations (for direct usage)
const { RedisWorkingMemory } = require('./redis-working-memory');
const { RedisConcurrencyGovernor } = require('./redis-concurrency');
const { RedisRateLimiter } = require('./redis-rate-limit');
const { RedisCircuitBreakerState } = require('./redis-circuit-breaker');
const { TieredEmbeddingCache } = require('./tiered-embedding-cache');

module.exports = {
  // Factory (auto-detects Redis availability)
  StateBackendFactory,

  // Redis implementations
  RedisWorkingMemory,
  RedisConcurrencyGovernor,
  RedisRateLimiter,
  RedisCircuitBreakerState,
  TieredEmbeddingCache,

  // Local fallbacks
  LocalWorkingMemory,
  LocalConcurrencyGovernor,
  LocalRateLimiter,
  LocalCircuitBreakerState,
  LocalEmbeddingCache,
};
