/**
 * task-manager.js — A2A Task Lifecycle Manager.
 *
 * Manages the complete lifecycle of A2A tasks:
 * - submitted → working → completed/failed/canceled
 *
 * Implements the A2A standard task schema:
 * {
 *   id: UUID,
 *   status: { state, timestamp },
 *   messages: [ { role, parts } ],
 *   artifacts: [ { name, parts } ],
 *   history: [ { state, timestamp } ],
 *   metadata: { source, agentId, skill }
 * }
 */

const crypto = require('crypto');
const { createLogger } = require('../shared/logger');

const log = createLogger('a2a:task-manager');

/**
 * A2ATaskManager — Manages task lifecycle.
 */
class A2ATaskManager {
  /**
   * @param {object} agentRuntime - Agent runtime instance (runAgent function)
   * @param {object} memoryManager - Memory manager instance
   * @param {object} [options] - Optional configuration
   * @param {object} [options.stateStore] - External state store (e.g. from StateBackendFactory)
   *        Must implement: get(key), set(key, value, ttlSec?), delete(key), keys(pattern?)
   *        When provided, tasks are persisted externally (Redis/PG) instead of in-memory Map.
   * @param {number} [options.maxTasks=10000] - Maximum concurrent tasks
   */
  constructor(agentRuntime, memoryManager, options = {}) {
    this._runtime = agentRuntime;
    this._memory = memoryManager;
    this._taskTimeouts = new Map(); // taskId → timeout handle
    this._maxTasks = options.maxTasks || 10000;

    // State store: external (Redis via StateBackendFactory) or in-memory Map fallback
    if (options.stateStore) {
      this._store = options.stateStore;
      this._useExternalStore = true;
      log.info('A2A TaskManager using external state store');
    } else {
      this._tasks = new Map();
      this._store = {
        get: async (key) => this._tasks.get(key) || null,
        set: async (key, value) => { this._tasks.set(key, value); },
        delete: async (key) => { this._tasks.delete(key); },
        size: () => this._tasks.size,
        entries: () => this._tasks.entries(),
      };
      this._useExternalStore = false;
      log.info('A2A TaskManager using in-memory store (configure Redis for persistence)');
    }

    // Auto-cleanup every 30 minutes
    this._cleanupInterval = setInterval(() => {
      this.cleanupOldTasks();
    }, 30 * 60 * 1000);
    // Allow process to exit even if timer is active
    if (this._cleanupInterval.unref) this._cleanupInterval.unref();
  }

  /**
   * Create task from A2A request.
   *
   * @param {object} request - A2A request
   * @param {object} request.message - Message object
   * @param {string} request.message.text - Message text (required)
   * @param {string} request.skill - Skill ID (optional, defaults to 'general-chat')
   * @param {object} request.context - Additional context (optional)
   * @returns {Promise<object>} Task object
   */
  async createTask(request) {
    // Validate request
    if (!request.message || !request.message.text) {
      const err = new Error('Request must have message.text');
      log.warn('Invalid A2A request', { error: err.message });
      throw err;
    }

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();

    const task = {
      id: taskId,
      status: {
        state: 'submitted',
        timestamp: now,
      },
      messages: [
        {
          role: 'user',
          parts: [
            {
              type: 'text',
              text: request.message.text,
            },
          ],
        },
      ],
      artifacts: [],
      history: [
        {
          state: 'submitted',
          timestamp: now,
        },
      ],
      metadata: {
        source: 'a2a',
        skill: request.skill || 'general-chat',
        context: request.context || {},
        createdAt: now,
      },
    };

    // Evict oldest tasks if at capacity (in-memory store only)
    if (!this._useExternalStore) {
      const currentSize = this._store.size();
      if (currentSize >= this._maxTasks) {
        const evictCount = Math.floor(this._maxTasks * 0.1); // evict 10%
        let evicted = 0;
        for (const [oldId, oldTask] of this._store.entries()) {
          const state = oldTask.status.state;
          if (state === 'completed' || state === 'failed' || state === 'canceled') {
            await this._store.delete(oldId);
            if (this._taskTimeouts.has(oldId)) {
              clearTimeout(this._taskTimeouts.get(oldId));
              this._taskTimeouts.delete(oldId);
            }
            if (++evicted >= evictCount) break;
          }
        }
        log.info(`Evicted ${evicted} old tasks (capacity: ${this._maxTasks})`);
      }
    }

    // Store task
    await this._store.set(taskId, task);
    log.debug(`Task created: ${taskId}`, {
      skill: task.metadata.skill,
      text: request.message.text.substring(0, 50),
    });

    return task;
  }

  /**
   * Execute task (route to agent and process).
   *
   * @param {string} taskId - Task ID
   * @param {object} agentConfig - Agent configuration
   * @returns {Promise<object>} Updated task object
   */
  async executeTask(taskId, agentConfig = {}) {
    const task = await this._store.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Update status to 'working'
    const workingTime = new Date().toISOString();
    task.status = {
      state: 'working',
      timestamp: workingTime,
    };
    task.history.push({
      state: 'working',
      timestamp: workingTime,
    });

    try {
      // Determine agent ID from skill mapping
      const agentId = this._skillToAgent(task.metadata.skill) || 'general';

      // Extract message text
      const messageText = task.messages[0]?.parts?.[0]?.text || '';

      log.debug(`Executing task: ${taskId} with agent: ${agentId}`);

      // Call agent runtime
      const result = await this._runtime({
        systemPrompt: agentConfig.systemPrompt || '',
        messages: [
          {
            role: 'user',
            content: messageText,
          },
        ],
        functionType: 'general',
        agentId: agentId,
        model: agentConfig.model || 'claude-haiku-4-5-20251001',
        maxTokens: agentConfig.maxTokens || 4096,
        userId: 'a2a',
        sessionId: `a2a:${taskId}`,
        accessiblePools: agentConfig.accessiblePools || ['team'],
        writablePools: agentConfig.writablePools || ['team'],
        channelId: '',
        threadId: '',
      });

      // Extract response text
      let responseText = '';
      if (typeof result === 'string') {
        responseText = result;
      } else if (result?.response) {
        responseText = result.response;
      } else if (result?.text) {
        responseText = result.text;
      } else if (result?.content) {
        if (Array.isArray(result.content)) {
          responseText = result.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n');
        } else {
          responseText = String(result.content);
        }
      }

      // Mark as completed
      const completedTime = new Date().toISOString();
      task.status = {
        state: 'completed',
        timestamp: completedTime,
      };
      task.history.push({
        state: 'completed',
        timestamp: completedTime,
      });

      // Add response as artifact
      task.artifacts.push({
        name: 'response',
        parts: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      });

      // Store interaction in episodic memory (if available)
      try {
        if (this._memory?.episodic) {
          await this._memory.episodic.record({
            type: 'a2a_interaction',
            agentId,
            taskId,
            input: messageText,
            output: responseText,
            timestamp: completedTime,
            pool: 'team',
          });
        }
      } catch (memErr) {
        log.warn(`Failed to record episodic memory: ${memErr.message}`);
      }

      // Persist updated task state to store
      await this._store.set(task.id, task);

      log.info(`Task completed: ${taskId}`, {
        agent: agentId,
        responseLength: responseText.length,
      });

      return task;
    } catch (err) {
      // Mark as failed
      const failedTime = new Date().toISOString();
      task.status = {
        state: 'failed',
        timestamp: failedTime,
        error: err.message,
      };
      task.history.push({
        state: 'failed',
        timestamp: failedTime,
        error: err.message,
      });

      // Add error as artifact
      task.artifacts.push({
        name: 'error',
        parts: [
          {
            type: 'text',
            text: err.message,
          },
        ],
      });

      // Persist updated task state to store
      await this._store.set(task.id, task);

      log.error(`Task failed: ${taskId}`, {
        error: err.message,
      });

      return task;
    }
  }

  /**
   * Get task by ID.
   *
   * @param {string} taskId
   * @returns {object|null} Task object or null if not found
   */
  async getTask(taskId) {
    return await this._store.get(taskId);
  }

  /**
   * Cancel task.
   *
   * @param {string} taskId
   * @returns {object|null} Updated task object or null if not found
   */
  async cancelTask(taskId) {
    const task = await this._store.get(taskId);
    if (!task) {
      return null;
    }

    // Only cancel if not already completed/failed
    if (task.status.state === 'completed' || task.status.state === 'failed' || task.status.state === 'canceled') {
      log.warn(`Cannot cancel task in state: ${task.status.state}`, { taskId });
      return task;
    }

    const cancelTime = new Date().toISOString();
    task.status = {
      state: 'canceled',
      timestamp: cancelTime,
    };
    task.history.push({
      state: 'canceled',
      timestamp: cancelTime,
    });

    // Clear any pending timeout
    if (this._taskTimeouts.has(taskId)) {
      clearTimeout(this._taskTimeouts.get(taskId));
      this._taskTimeouts.delete(taskId);
    }

    log.info(`Task canceled: ${taskId}`);
    return task;
  }

  /**
   * Map skill to agent ID.
   * @private
   * @param {string} skillId
   * @returns {string} Agent ID
   */
  _skillToAgent(skillId) {
    const skillMap = {
      'knowledge-query': 'knowledge',
      'code-assist': 'code',
      'ops-support': 'ops',
      'strategy-analysis': 'strategy',
      'general-chat': 'general',
    };
    return skillMap[skillId] || 'general';
  }

  /**
   * List all tasks (for debugging/monitoring).
   *
   * @param {object} filter - Filter options
   * @param {string} filter.state - Filter by state (optional)
   * @returns {object[]} Array of task objects
   */
  async listTasks(filter = {}) {
    let tasks;
    if (this._useExternalStore) {
      // External store: delegate to store's list method if available
      tasks = typeof this._store.values === 'function'
        ? Array.from(await this._store.values())
        : [];
    } else {
      tasks = Array.from(this._tasks.values());
    }

    if (filter.state) {
      tasks = tasks.filter(t => t.status.state === filter.state);
    }

    return tasks;
  }

  /**
   * Clean up old tasks (retention policy).
   *
   * @param {number} retentionMs - Age threshold (default 24 hours)
   * @returns {number} Number of tasks removed
   */
  async cleanupOldTasks(retentionMs = 86400000) {
    const now = Date.now();
    let removed = 0;

    if (this._useExternalStore) {
      // External stores handle their own TTL; skip manual cleanup
      return 0;
    }

    for (const [taskId, task] of this._tasks) {
      const createdAt = new Date(task.metadata.createdAt).getTime();
      if (now - createdAt > retentionMs) {
        await this._store.delete(taskId);
        removed++;
      }
    }

    if (removed > 0) {
      log.info(`Cleaned up ${removed} old tasks`);
    }

    return removed;
  }
}

module.exports = {
  A2ATaskManager,
};
