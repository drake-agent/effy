/**
 * warmup.js — 시스템 컴포넌트 준비 완료 추적.
 * SpaceBot Warmup 패턴: 모든 컴포넌트 ready일 때만 트래픽 수용.
 *
 * Tracks system component readiness and ensures all components are ready before accepting traffic.
 * Integrates with health checks and provides warmup status.
 */
const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');

const log = createLogger('gateway:warmup');

/**
 * ComponentStatus — 컴포넌트 상태
 * @typedef {Object} ComponentStatus
 * @property {'initializing' | 'ready' | 'failed'} status
 * @property {number|null} readyAt - Ready 시간 (timestamp)
 * @property {Error|null} error - 실패 이유
 */

/**
 * WarmupTracker — 시스템 워밍업 추적
 * Tracks readiness of all system components
 */
class WarmupTracker extends EventEmitter {
  constructor(opts = {}) {
    super();

    /**
     * 컴포넌트별 상태
     * @type {Map<string, ComponentStatus>}
     */
    this.components = new Map();

    /**
     * 전체 시스템 시작 시간
     * @type {number}
     */
    this.startedAt = Date.now();

    /**
     * 전체 시스템 ready 시간
     * @type {number|null}
     */
    this.readyAt = null;

    /**
     * 워밍업 전에 받은 요청 수
     * @type {number}
     */
    this.coldDispatchCount = 0;

    /**
     * 워밍업 타임아웃 (ms)
     * @type {number}
     */
    this.timeoutMs = opts.timeoutMs || 30000;

    /**
     * 워밍업 완료 대기 Promise들
     * @type {Array<{ resolve: Function, reject: Function }>}
     */
    this.waiters = [];

    log.info('WarmupTracker initialized', { timeoutMs: this.timeoutMs });
  }

  /**
   * 컴포넌트 등록
   * Register a component to track
   *
   * @param {string} componentName - 컴포넌트 이름 (e.g., 'database', 'llm', 'memory')
   */
  register(componentName) {
    if (!this.components.has(componentName)) {
      this.components.set(componentName, {
        status: 'initializing',
        readyAt: null,
        error: null,
      });
      log.debug('Component registered', { componentName });
    }
  }

  /**
   * 컴포넌트를 ready로 표시
   * Mark component as ready
   *
   * @param {string} componentName - 컴포넌트 이름
   */
  markReady(componentName) {
    if (!this.components.has(componentName)) {
      this.register(componentName);
    }

    const status = this.components.get(componentName);
    status.status = 'ready';
    status.readyAt = Date.now();
    status.error = null;

    log.info('Component ready', { componentName });
    this.emit('component:ready', { componentName, readyAt: status.readyAt });

    // 모든 컴포넌트가 ready면 전체 ready
    if (this._allReady()) {
      this._markSystemReady();
    }
  }

  /**
   * 컴포넌트를 failed로 표시
   * Mark component as failed
   *
   * @param {string} componentName - 컴포넌트 이름
   * @param {Error|string} error - 실패 이유
   */
  markFailed(componentName, error) {
    if (!this.components.has(componentName)) {
      this.register(componentName);
    }

    const err = error instanceof Error ? error : new Error(String(error));
    const status = this.components.get(componentName);
    status.status = 'failed';
    status.error = err;

    log.error('Component failed', { componentName, error: err.message });
    this.emit('component:failed', { componentName, error: err });

    // 실패한 컴포넌트가 있으면 시스템 ready 불가능
    // Reject all waiters
    for (const waiter of this.waiters) {
      waiter.reject(new Error(`Component ${componentName} failed: ${err.message}`));
    }
    this.waiters = [];
  }

  /**
   * 모든 컴포넌트가 ready인지 확인
   * Check if system is ready
   *
   * @returns {boolean} 모든 등록된 컴포넌트가 ready면 true
   */
  isReady() {
    if (this.components.size === 0) {
      return false; // 아직 컴포넌트 등록 안 됨
    }

    for (const status of this.components.values()) {
      if (status.status !== 'ready') {
        return false;
      }
    }

    return true;
  }

  /**
   * 전체 상태 조회
   * Get full warmup status
   *
   * @returns {Object} 상태 정보
   */
  getStatus() {
    const components = {};
    for (const [name, status] of this.components) {
      components[name] = {
        status: status.status,
        readyAt: status.readyAt,
        error: status.error ? status.error.message : null,
      };
    }

    const totalMs = this.readyAt ? this.readyAt - this.startedAt : null;

    return {
      ready: this.isReady(),
      components,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      totalMs,
      coldDispatchCount: this.coldDispatchCount,
    };
  }

  /**
   * 워밍업 완료 대기
   * Wait for system to be ready
   *
   * @param {number} [timeoutMs=30000] - 타임아웃 (ms)
   * @returns {Promise<void>} Ready 될 때까지 대기
   */
  waitForReady(timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      // 이미 ready면 즉시 반환
      if (this.isReady()) {
        resolve();
        return;
      }

      // Waiter 등록
      const waiter = { resolve, reject };
      this.waiters.push(waiter);

      // 타임아웃 설정
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        reject(new Error(`Warmup timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      // Ready 될 때 정리
      const onReady = () => {
        clearTimeout(timer);
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        this.removeListener('ready', onReady);
        resolve();
      };

      this.once('ready', onReady);
    });
  }

  /**
   * 콜드 디스패치 요청 카운트
   * Count a request received before warmup completed
   */
  recordColdDispatch() {
    if (!this.isReady()) {
      this.coldDispatchCount++;
      log.warn('Request received during warmup', {
        coldDispatchCount: this.coldDispatchCount,
      });
    }
  }

  /**
   * 모든 컴포넌트가 ready인지 확인 (내부용)
   * Check if all registered components are ready
   *
   * @private
   * @returns {boolean}
   */
  _allReady() {
    if (this.components.size === 0) {
      return false;
    }

    for (const status of this.components.values()) {
      if (status.status !== 'ready') {
        return false;
      }
    }

    return true;
  }

  /**
   * 전체 시스템 ready로 표시
   * Mark entire system as ready
   *
   * @private
   */
  _markSystemReady() {
    this.readyAt = Date.now();
    const totalMs = this.readyAt - this.startedAt;

    log.info('System fully ready', {
      totalMs,
      componentsCount: this.components.size,
      coldDispatches: this.coldDispatchCount,
    });

    this.emit('ready', {
      readyAt: this.readyAt,
      totalMs,
      coldDispatchCount: this.coldDispatchCount,
    });

    // 모든 waiter 실행
    for (const waiter of this.waiters) {
      waiter.resolve();
    }
    this.waiters = [];
  }

  /**
   * 재설정 (테스트 또는 재시작용)
   * Reset tracker
   */
  reset() {
    this.components.clear();
    this.startedAt = Date.now();
    this.readyAt = null;
    this.coldDispatchCount = 0;
    this.waiters = [];
    log.info('Warmup tracker reset');
  }
}

module.exports = { WarmupTracker };
