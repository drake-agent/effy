/**
 * delegation.js — Channel → Worker 위임 모델 (SpaceBot 차용).
 *
 * Channel (사용자 대면 프로세스)은 절대 직접 실행하지 않고,
 * Worker에게 작업을 위임하여 항상 반응 가능 상태를 유지.
 *
 * 프로세스 타입:
 * - Channel: 사용자와 대화, 작업 위임만 담당
 * - Worker: 독립 실행 프로세스 (fire-and-forget 또는 interactive)
 * - Branch: Channel 컨텍스트를 fork한 독립 사고 프로세스
 *
 * 위임 방식:
 * - fireAndForget: Worker 시작 후 즉시 사용자에게 응답
 * - interactive: Worker 결과를 기다려서 응답
 * - branch: 독립 사고 후 결과를 Channel에 병합
 */
const { createLogger } = require('../shared/logger');
const { EventEmitter } = require('events');
const crypto = require('crypto');

const log = createLogger('delegation');

// ─── Worker 상태 ───
const WORKER_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Worker 프로세스 추상화.
 * 실제 LLM 호출은 runAgent()를 통해 수행.
 */
class WorkerProcess {
  /**
   * @param {Object} opts
   * @param {string} opts.id - Worker ID
   * @param {string} opts.type - 'fire_and_forget' | 'interactive' | 'branch'
   * @param {string} opts.task - 작업 설명
   * @param {Object} opts.context - 위임 시 전달할 컨텍스트
   * @param {string} [opts.parentChannelId] - 위임한 Channel ID
   * @param {number} [opts.maxTurns=50] - 최대 LLM 턴 수
   * @param {number} [opts.timeoutMs=300000] - 타임아웃 (5분)
   */
  constructor(opts) {
    this.id = opts.id || `worker-${crypto.randomBytes(4).toString('hex')}`;
    this.type = opts.type || 'interactive';
    this.task = opts.task;
    this.context = opts.context || {};
    this.parentChannelId = opts.parentChannelId || null;
    this.maxTurns = opts.maxTurns ?? 50;
    this.timeoutMs = opts.timeoutMs ?? 300000;

    this.state = WORKER_STATES.PENDING;
    this.result = null;
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
    this.turns = 0;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      task: this.task,
      state: this.state,
      turns: this.turns,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      parentChannelId: this.parentChannelId,
    };
  }
}

/**
 * DelegationManager — Channel → Worker 위임 관리자.
 *
 * Gateway에서 인스턴스화하여 사용:
 *   this.delegation = new DelegationManager();
 *   const worker = await this.delegation.delegate({ task, context, type });
 */
class DelegationManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.maxConcurrentWorkers = opts.maxConcurrentWorkers ?? 10;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 300000;

    /** @type {Map<string, WorkerProcess>} */
    this.workers = new Map();

    /** @type {Map<string, WorkerProcess>} — parentChannelId → active workers */
    this.channelWorkers = new Map();

    // 정리 타이머 (완료된 워커 5분 후 제거)
    this._cleanupInterval = setInterval(() => this._cleanup(), 60000);
  }

  /**
   * 작업 위임 — Channel이 Worker에게 작업을 넘김.
   *
   * @param {Object} opts
   * @param {string} opts.task - 작업 설명 (Worker의 시스템 프롬프트에 주입)
   * @param {Object} opts.context - 대화 컨텍스트 (메시지 히스토리, 유저 정보 등)
   * @param {string} [opts.type='interactive'] - 'fire_and_forget' | 'interactive' | 'branch'
   * @param {string} [opts.channelId] - 위임하는 Channel ID
   * @param {Function} opts.executor - 실제 실행 함수 (runAgent 래퍼)
   * @param {Function} [opts.onProgress] - 진행 상황 콜백
   * @returns {Promise<WorkerProcess>}
   */
  async delegate(opts) {
    const { task, context, type = 'interactive', channelId, executor, onProgress } = opts;

    // 동시 워커 수 제한
    const activeCount = Array.from(this.workers.values())
      .filter(w => w.state === WORKER_STATES.RUNNING).length;
    if (activeCount >= this.maxConcurrentWorkers) {
      throw new Error(`Worker limit reached (${this.maxConcurrentWorkers}). Wait for existing workers to complete.`);
    }

    const worker = new WorkerProcess({
      type,
      task,
      context,
      parentChannelId: channelId,
      timeoutMs: this.defaultTimeoutMs,
    });

    this.workers.set(worker.id, worker);
    log.info('Worker delegated', { workerId: worker.id, type, task: task.slice(0, 100) });

    // Fire-and-forget: 즉시 반환, 백그라운드 실행
    if (type === 'fire_and_forget') {
      this._executeWorker(worker, executor, onProgress).catch(err => {
        log.error('Fire-and-forget worker failed', { workerId: worker.id, error: err.message });
      });
      return worker;
    }

    // Interactive / Branch: 완료까지 대기
    await this._executeWorker(worker, executor, onProgress);
    return worker;
  }

  /**
   * Worker 실행 (내부).
   * @private
   */
  async _executeWorker(worker, executor, onProgress) {
    worker.state = WORKER_STATES.RUNNING;
    worker.startedAt = Date.now();
    this.emit('worker:start', worker);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Worker timeout (${worker.timeoutMs}ms)`)), worker.timeoutMs)
    );

    try {
      const resultPromise = executor({
        workerId: worker.id,
        task: worker.task,
        context: worker.context,
        maxTurns: worker.maxTurns,
        onTurn: (turnInfo) => {
          worker.turns++;
          if (onProgress) onProgress({ workerId: worker.id, turns: worker.turns, ...turnInfo });
        },
      });

      const result = await Promise.race([resultPromise, timeoutPromise]);

      worker.state = WORKER_STATES.COMPLETED;
      worker.result = result;
      worker.completedAt = Date.now();
      this.emit('worker:complete', worker);

      log.info('Worker completed', {
        workerId: worker.id,
        turns: worker.turns,
        durationMs: worker.completedAt - worker.startedAt,
      });
    } catch (err) {
      worker.state = WORKER_STATES.FAILED;
      worker.error = err.message;
      worker.completedAt = Date.now();
      this.emit('worker:error', worker, err);

      log.error('Worker failed', { workerId: worker.id, error: err.message });
      throw err;
    }
  }

  /**
   * Worker 취소.
   * @param {string} workerId
   */
  cancel(workerId) {
    const worker = this.workers.get(workerId);
    if (!worker) return false;
    if (worker.state !== WORKER_STATES.RUNNING) return false;

    worker.state = WORKER_STATES.CANCELLED;
    worker.completedAt = Date.now();
    this.emit('worker:cancel', worker);
    log.info('Worker cancelled', { workerId });
    return true;
  }

  /**
   * Channel의 활성 워커 목록.
   * @param {string} channelId
   * @returns {Array<Object>}
   */
  getChannelWorkers(channelId) {
    return Array.from(this.workers.values())
      .filter(w => w.parentChannelId === channelId && w.state === WORKER_STATES.RUNNING)
      .map(w => w.toJSON());
  }

  /**
   * 전체 워커 상태 요약.
   * @returns {Object}
   */
  getStats() {
    const workers = Array.from(this.workers.values());
    return {
      total: workers.length,
      running: workers.filter(w => w.state === WORKER_STATES.RUNNING).length,
      completed: workers.filter(w => w.state === WORKER_STATES.COMPLETED).length,
      failed: workers.filter(w => w.state === WORKER_STATES.FAILED).length,
      cancelled: workers.filter(w => w.state === WORKER_STATES.CANCELLED).length,
    };
  }

  /**
   * 완료된 오래된 워커 정리.
   * @private
   */
  _cleanup() {
    const cutoff = Date.now() - 300000; // 5분
    let removed = 0;
    for (const [id, worker] of this.workers) {
      if (worker.completedAt && worker.completedAt < cutoff) {
        this.workers.delete(id);
        removed++;
      }
    }
    if (removed > 0) log.debug('Workers cleaned up', { removed });
  }

  /**
   * 종료 (타이머 정리).
   */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.workers.clear();
  }
}

module.exports = { DelegationManager, WorkerProcess, WORKER_STATES };
