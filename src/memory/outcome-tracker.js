/**
 * outcome-tracker.js — 턴별 결과 추적기.
 * Bulletin과 Loop Guard에 outcome 데이터를 제공.
 *
 * Outcome history tracker — records per-turn results for Bulletin integration.
 */
const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:outcome-tracker');

class OutcomeTracker extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxHistory=500] - Maximum history entries
   */
  constructor(opts = {}) {
    super();
    this.maxHistory = opts.maxHistory ?? 500;
    this._history = []; // { agentId, turnId, toolName, success, error, timeMs, tokensUsed, timestamp }
    this._agentStats = new Map(); // agentId -> { success, error, retry, total }
  }

  /**
   * Record a turn outcome
   * @param {Object} outcome
   * @param {string} outcome.agentId - Agent identifier
   * @param {string} outcome.turnId - Turn identifier
   * @param {string} [outcome.toolName] - Tool name used
   * @param {boolean} outcome.success - Success flag
   * @param {string} [outcome.error] - Error message if failed
   * @param {number} [outcome.timeMs] - Execution time in ms
   * @param {number} [outcome.tokensUsed] - Tokens consumed
   */
  record(outcome) {
    try {
      // Validate required fields
      if (!outcome || typeof outcome !== 'object') {
        log.warn('Invalid outcome: not an object');
        return;
      }

      if (!outcome.agentId || typeof outcome.agentId !== 'string') {
        log.warn('Invalid outcome: missing or invalid agentId');
        return;
      }

      if (!outcome.turnId || typeof outcome.turnId !== 'string') {
        log.warn('Invalid outcome: missing or invalid turnId');
        return;
      }

      if (typeof outcome.success !== 'boolean') {
        log.warn('Invalid outcome: success must be boolean');
        return;
      }

      // Create record with timestamp
      const record = {
        agentId: outcome.agentId,
        turnId: outcome.turnId,
        toolName: outcome.toolName || null,
        success: outcome.success,
        error: outcome.error || null,
        timeMs: outcome.timeMs ?? 0,
        tokensUsed: outcome.tokensUsed ?? 0,
        timestamp: Date.now(),
      };

      // Add to history
      this._history.push(record);

      // Update agent stats
      this._updateAgentStats(outcome.agentId, outcome.success, !!outcome.error);

      // Trim history if exceeds maxHistory
      if (this._history.length > this.maxHistory) {
        this._history = this._history.slice(-this.maxHistory);
      }

      // Emit event
      this.emit('outcome:recorded', record);

      log.debug('Outcome recorded', {
        agentId: outcome.agentId,
        turnId: outcome.turnId,
        success: outcome.success,
      });
    } catch (err) {
      log.error('Error recording outcome', { error: err.message });
    }
  }

  /**
   * Update statistics for an agent
   * @private
   */
  _updateAgentStats(agentId, success, hasError) {
    if (!this._agentStats.has(agentId)) {
      this._agentStats.set(agentId, {
        success: 0,
        error: 0,
        retry: 0,
        total: 0,
      });
    }

    const stats = this._agentStats.get(agentId);
    stats.total += 1;

    if (success) {
      stats.success += 1;
    } else if (hasError) {
      stats.error += 1;
    } else {
      stats.retry += 1;
    }
  }

  /**
   * Get recent outcomes for an agent
   * @param {string} agentId
   * @param {number} [limit=20] - Max number of outcomes to return
   * @returns {Array<Object>} Recent outcomes
   */
  getRecentOutcomes(agentId, limit = 20) {
    try {
      return this._history
        .filter(record => record.agentId === agentId)
        .slice(-limit);
    } catch (err) {
      log.error('Error getting recent outcomes', { error: err.message });
      return [];
    }
  }

  /**
   * Get statistics for an agent
   * @param {string} agentId
   * @returns {Object} Agent statistics
   */
  getAgentStats(agentId) {
    try {
      if (!this._agentStats.has(agentId)) {
        return {
          success: 0,
          error: 0,
          retry: 0,
          total: 0,
        };
      }
      return { ...this._agentStats.get(agentId) };
    } catch (err) {
      log.error('Error getting agent stats', { error: err.message });
      return { success: 0, error: 0, retry: 0, total: 0 };
    }
  }

  /**
   * Get global statistics across all agents
   * @returns {Object} Global statistics
   */
  getGlobalStats() {
    try {
      const global = {
        success: 0,
        error: 0,
        retry: 0,
        total: 0,
        agents: this._agentStats.size,
      };

      for (const stats of this._agentStats.values()) {
        global.success += stats.success;
        global.error += stats.error;
        global.retry += stats.retry;
        global.total += stats.total;
      }

      return global;
    } catch (err) {
      log.error('Error getting global stats', { error: err.message });
      return { success: 0, error: 0, retry: 0, total: 0, agents: 0 };
    }
  }

  /**
   * Get outcome-weighted importance scores for memory briefing
   * Errors are more important to mention (weight: 1.5)
   * Successes have standard weight (1.0)
   * Retries have higher weight (1.2)
   * @returns {Object} { successWeight, errorWeight, retryWeight }
   */
  getOutcomeWeights() {
    return {
      successWeight: 1.0,
      errorWeight: 1.5,
      retryWeight: 1.2,
    };
  }

  /**
   * Generate a brief outcome summary for injection into Bulletin prompt
   * @param {string} [agentId] - Specific agent or null for all agents
   * @returns {string} 2-3 sentence summary of recent outcomes
   */
  generateOutcomeSummary(agentId) {
    try {
      const recentLimit = 20;
      const outcomes = agentId
        ? this.getRecentOutcomes(agentId, recentLimit)
        : this._history.slice(-recentLimit);

      if (outcomes.length === 0) {
        return 'No recent outcomes recorded.';
      }

      // Count outcomes
      const successCount = outcomes.filter(o => o.success).length;
      const errorCount = outcomes.filter(o => o.error).length;
      const totalCount = outcomes.length;
      const successRate = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(0) : 0;

      // Find common errors
      const errorMap = new Map();
      for (const outcome of outcomes) {
        if (outcome.error) {
          errorMap.set(outcome.error, (errorMap.get(outcome.error) || 0) + 1);
        }
      }

      const topErrors = Array.from(errorMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([error, count]) => `${error} (${count}x)`);

      // Build summary
      let summary = `Recent execution: ${successCount}/${totalCount} successes (${successRate}% success rate).`;

      if (errorCount > 0) {
        summary += ` Top errors: ${topErrors.join(', ')}.`;
      }

      if (successCount > 0) {
        const avgTimeMs = Math.round(
          outcomes.filter(o => o.success).reduce((sum, o) => sum + o.timeMs, 0) /
          successCount
        );
        summary += ` Average execution time: ${avgTimeMs}ms.`;
      }

      return summary;
    } catch (err) {
      log.error('Error generating outcome summary', { error: err.message });
      return 'Unable to generate outcome summary.';
    }
  }

  /**
   * Clear outcomes for a specific agent
   * @param {string} agentId
   */
  reset(agentId) {
    try {
      this._history = this._history.filter(record => record.agentId !== agentId);
      this._agentStats.delete(agentId);
      log.debug('Outcome tracker reset', { agentId });
    } catch (err) {
      log.error('Error resetting outcomes', { error: err.message });
    }
  }

  /**
   * Clear all outcomes and statistics
   */
  resetAll() {
    try {
      this._history = [];
      this._agentStats.clear();
      log.info('All outcome tracking reset');
    } catch (err) {
      log.error('Error resetting all outcomes', { error: err.message });
    }
  }
}

module.exports = { OutcomeTracker };
