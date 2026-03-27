/**
 * process-roles.js — 논리적 프로세스 역할 정의.
 * 단일 프로세스에서 역할별 기능을 선택적으로 활성화.
 */
const { createLogger } = require('../shared/logger');
const { Worker } = require('worker_threads');
const os = require('os');

const log = createLogger('core:process-roles');

// ===== Role Definitions =====

const ROLES = {
  CHANNEL: {
    name: 'channel',
    description: 'HTTP Gateway + user-facing conversation handler',
    features: ['http', 'websocket', 'auth', 'routing', 'middleware'],
    defaultModel: 'claude-sonnet-4-20250514',
  },
  WORKER: {
    name: 'worker',
    description: 'Deep LLM reasoning + tool execution',
    features: ['tools', 'sandbox', 'delegation', 'deep-analysis'],
    defaultModel: 'claude-opus-4-20250514',
  },
  COMPACTOR: {
    name: 'compactor',
    description: 'Background memory compaction + bulletin refresh',
    features: ['compaction', 'bulletin', 'decay', 'indexing'],
    defaultModel: 'claude-haiku-4-5-20251001',
  },
  CORTEX: {
    name: 'cortex',
    description: 'Lightweight intent classification + context search',
    features: ['intent', 'search', 'routing', 'scoring'],
    defaultModel: 'claude-haiku-4-5-20251001',
  },
};

// ===== ProcessRoleManager =====

class ProcessRoleManager {
  constructor(opts = {}) {
    this.enabledRoles = new Set(opts.roles || ['channel', 'worker', 'compactor', 'cortex']);
    this._roleConfigs = new Map();

    // Initialize role configs
    for (const [key, role] of Object.entries(ROLES)) {
      this._roleConfigs.set(role.name, {
        ...role,
        enabled: this.enabledRoles.has(role.name),
      });
    }

    log.info(`ProcessRoleManager initialized with roles: ${[...this.enabledRoles].join(', ')}`);
  }

  /**
   * Check if a role is enabled
   */
  isEnabled(roleName) {
    return this.enabledRoles.has(roleName);
  }

  /**
   * Get role configuration
   */
  getRole(roleName) {
    return this._roleConfigs.get(roleName);
  }

  /**
   * Get all enabled roles
   */
  getEnabledRoles() {
    return [...this.enabledRoles]
      .map((r) => this._roleConfigs.get(r))
      .filter(Boolean);
  }

  /**
   * Get default model for a role
   */
  getDefaultModel(roleName) {
    return this._roleConfigs.get(roleName)?.defaultModel;
  }

  /**
   * Check if any enabled role provides a feature
   */
  hasFeature(feature) {
    for (const role of this.getEnabledRoles()) {
      if (role.features.includes(feature)) return true;
    }
    return false;
  }
}

// ===== WorkerPool =====

/**
 * WorkerPool — CPU-bound task offloading via worker_threads.
 * Only for compute-heavy operations (hashing, token estimation, vector similarity).
 * NOT for I/O operations (LLM calls, DB queries).
 */
class WorkerPool {
  constructor(opts = {}) {
    this.maxWorkers = opts.maxWorkers ?? Math.max(1, os.cpus().length - 1);
    this._workers = [];
    this._queue = [];
    this._activeCount = 0;
    this._nextWorkerId = 0;
    this.stats = { tasksCompleted: 0, tasksQueued: 0, errors: 0 };

    log.info(`WorkerPool initialized with max ${this.maxWorkers} workers`);
  }

  /**
   * Get or create a worker (lazy initialization)
   */
  _getWorker() {
    if (this._workers.length < this.maxWorkers) {
      // Create new worker placeholder (actual creation deferred to task execution)
      const workerId = this._nextWorkerId++;
      this._workers.push({ id: workerId, busy: false, instance: null });
      return this._workers[this._workers.length - 1];
    }

    // Find least busy worker
    let leastBusy = this._workers[0];
    for (const w of this._workers) {
      if (!w.busy) return w;
    }
    return leastBusy;
  }

  /**
   * Execute a function in a worker thread.
   * @param {string} workerScript - Path to worker script
   * @param {*} data - Data to pass to worker
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<*>}
   */
  async execute(workerScript, data, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const task = {
        workerScript,
        data,
        timeoutMs,
        resolve,
        reject,
        createdAt: Date.now(),
      };

      // Try to execute immediately if space available
      if (this._activeCount < this.maxWorkers) {
        this._executeTask(task);
      } else {
        // Queue for later
        this._queue.push(task);
        this.stats.tasksQueued++;
      }
    });
  }

  /**
   * Execute a queued task
   */
  _executeTask(task) {
    const { workerScript, data, timeoutMs, resolve, reject } = task;
    const startTime = Date.now();

    this._activeCount++;

    let worker = null;
    let timedOut = false;
    let completed = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      if (worker) {
        worker.terminate();
      }
      this._activeCount--;
      this._processQueue();
      reject(new Error(`Worker task timeout after ${timeoutMs}ms`));
      this.stats.errors++;
    }, timeoutMs);

    try {
      worker = new Worker(workerScript, { eval: false });

      worker.on('message', (result) => {
        if (completed || timedOut) return;
        completed = true;
        clearTimeout(timeout);
        this._activeCount--;
        this.stats.tasksCompleted++;

        resolve(result);
        this._processQueue();
      });

      worker.on('error', (err) => {
        if (completed || timedOut) return;
        completed = true;
        clearTimeout(timeout);
        this._activeCount--;
        this.stats.errors++;

        reject(err);
        this._processQueue();
      });

      worker.on('exit', (code) => {
        if (completed || timedOut) return;
        if (code !== 0 && !completed) {
          completed = true;
          clearTimeout(timeout);
          this._activeCount--;
          this.stats.errors++;
          reject(new Error(`Worker exited with code ${code}`));
          this._processQueue();
        }
      });

      worker.postMessage(data);
    } catch (err) {
      if (completed || timedOut) return;
      completed = true;
      clearTimeout(timeout);
      this._activeCount--;
      this.stats.errors++;
      reject(err);
      this._processQueue();
    }
  }

  /**
   * Process queued tasks
   */
  _processQueue() {
    while (this._queue.length > 0 && this._activeCount < this.maxWorkers) {
      const task = this._queue.shift();
      this._executeTask(task);
    }
  }

  /**
   * Get current active worker count
   */
  get activeCount() {
    return this._activeCount;
  }

  /**
   * Get current queue length
   */
  get queueLength() {
    return this._queue.length;
  }

  /**
   * Shutdown all workers
   */
  async shutdown() {
    log.info('WorkerPool shutting down...');
    
    // Reject all queued tasks
    for (const task of this._queue) {
      task.reject(new Error('WorkerPool shutting down'));
    }
    this._queue = [];

    // Terminate all workers
    for (const w of this._workers) {
      if (w.instance) {
        w.instance.terminate();
      }
    }
    this._workers = [];
    this._activeCount = 0;

    log.info(`WorkerPool shutdown complete. Stats:`, this.stats);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeCount: this._activeCount,
      queueLength: this._queue.length,
      totalWorkers: this._workers.length,
    };
  }
}

module.exports = { ROLES, ProcessRoleManager, WorkerPool };
