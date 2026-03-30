/**
 * summarization-queue.js — Concurrency-limited summarization queue.
 *
 * R2-PERF-4 fix: Prevents all LLM summarization calls from firing at once.
 * Under 500+ concurrent users, 10+ summarizations can trigger simultaneously
 * — each hitting Claude API (2-3s RTT) — causing P99 latency spikes for
 * unrelated users. This queue limits concurrent summarizations to a
 * configurable max (default: 2).
 *
 * Usage:
 *   const { summarizationQueue } = require('../shared/summarization-queue');
 *   const result = await summarizationQueue.enqueue(() => anthropic.messages.create(...));
 *
 * @module shared/summarization-queue
 */
const { createLogger } = require('./logger');
const log = createLogger('summarization-queue');

class SummarizationQueue {
  /**
   * @param {number} [maxConcurrent=2] - Max simultaneous LLM summarization calls
   */
  constructor(maxConcurrent = 2) {
    this._maxConcurrent = maxConcurrent;
    this._active = 0;
    this._pending = [];
    this._totalProcessed = 0;
    this._totalDropped = 0;
    this._maxQueueDepth = 20; // Prevent unbounded queue growth
  }

  /**
   * Enqueue a summarization task. Returns a promise that resolves when the task completes.
   * If queue is full, returns null immediately (task dropped — not critical).
   *
   * @param {Function} fn - Async function to execute (the LLM call)
   * @returns {Promise<*>} Result of fn(), or null if dropped
   */
  async enqueue(fn) {
    // Load shedding: if queue too deep, drop this summarization
    if (this._pending.length >= this._maxQueueDepth) {
      this._totalDropped++;
      log.warn('Summarization dropped (queue full)', {
        queueDepth: this._pending.length,
        active: this._active,
        totalDropped: this._totalDropped,
      });
      return null;
    }

    // If under concurrency limit, execute immediately
    if (this._active < this._maxConcurrent) {
      return this._execute(fn);
    }

    // Otherwise queue it
    return new Promise((resolve, reject) => {
      this._pending.push({ fn, resolve, reject });
    });
  }

  /** @private */
  async _execute(fn) {
    this._active++;
    try {
      const result = await fn();
      this._totalProcessed++;
      return result;
    } finally {
      this._active--;
      this._drain();
    }
  }

  /** @private Process next item in queue */
  _drain() {
    if (this._pending.length === 0) return;
    if (this._active >= this._maxConcurrent) return;

    const { fn, resolve, reject } = this._pending.shift();
    this._execute(fn).then(resolve).catch(reject);
  }

  /** @returns {{ active: number, pending: number, processed: number, dropped: number }} */
  getStats() {
    return {
      active: this._active,
      pending: this._pending.length,
      processed: this._totalProcessed,
      dropped: this._totalDropped,
      maxConcurrent: this._maxConcurrent,
    };
  }

  /** Update max concurrency at runtime */
  setMaxConcurrent(n) {
    this._maxConcurrent = Math.max(1, n);
    // If we lowered, do nothing (excess will drain naturally)
    // If we raised, drain queue to fill new slots
    this._drain();
  }
}

// Singleton — shared across WorkingMemory and GatewayWorkingMemory
const summarizationQueue = new SummarizationQueue(
  parseInt(process.env.EFFY_SUMMARIZATION_CONCURRENCY || '2', 10)
);

module.exports = { SummarizationQueue, summarizationQueue };
