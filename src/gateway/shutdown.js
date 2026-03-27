/**
 * gateway/shutdown.js — 우아한 컨테이너 종료 (Graceful Shutdown)
 *
 * SIGTERM/SIGINT 처리:
 * 1. 신규 연결 중단 (circuitBreaker 활성화)
 * 2. 활성 채널 드레인 (완료 또는 타임아웃 대기)
 * 3. 등록된 정리 핸들러 실행 (우선순위 순)
 * 4. 프로세스 종료
 *
 * 사용:
 *   const shutdown = new GracefulShutdown();
 *   shutdown.register('db', async () => { ... }, 5); // 우선순위 5
 *   shutdown.install();
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('gateway:shutdown');

class GracefulShutdown {
  constructor(opts = {}) {
    /** @type {number} 채널 드레인 최대 대기 시간 (ms) */
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 30000;

    /** @type {Array<{ name: string, handler: Function, priority: number }>} */
    this._handlers = [];

    /** @type {Set<string>} 활성 채널 ID 추적 */
    this._activeChannels = new Set();

    /** 종료 진행 중 여부 */
    this._shutdownInProgress = false;

    /** 종료 시작 시각 (타임아웃 계산용) */
    this._shutdownStart = 0;
  }

  /**
   * 정리 핸들러 등록
   * 종료 시 우선순위순으로 실행됨 (낮은 번호 먼저)
   *
   * @param {string} name - 핸들러 이름
   * @param {Function} handler - async () => void
   * @param {number} [priority=10] - 낮을수록 먼저 실행
   */
  register(name, handler, priority = 10) {
    if (typeof handler !== 'function') {
      throw new Error(`Handler '${name}' must be a function`);
    }
    this._handlers.push({ name, handler, priority });
    this._handlers.sort((a, b) => a.priority - b.priority);
    log.debug('Registered shutdown handler', { name, priority });
  }

  /**
   * 활성 채널 추적
   *
   * @param {string} channelId
   */
  trackChannel(channelId) {
    this._activeChannels.add(channelId);
    log.debug('Channel tracked', { channelId });
  }

  /**
   * 활성 채널 추적 해제 (완료 시)
   *
   * @param {string} channelId
   */
  untrackChannel(channelId) {
    this._activeChannels.delete(channelId);
    log.debug('Channel untracked', { channelId });
  }

  /**
   * 신호 핸들러 설치 (startup 시 한 번 호출)
   * SIGTERM, SIGINT를 listen하고 graceful shutdown 시작
   */
  install() {
    const handler = async (signal) => {
      if (this._shutdownInProgress) {
        log.warn('Shutdown already in progress, ignoring signal', { signal });
        return;
      }
      log.info('Signal received', { signal });
      await this.shutdown(signal);
    };

    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
    log.info('Signal handlers installed');
  }

  /**
   * 우아한 종료 실행
   * 1. 신규 연결 차단
   * 2. 활성 채널 드레인 (타임아웃 또는 완료)
   * 3. 정리 핸들러 실행
   * 4. 프로세스 종료
   *
   * @param {string} [signal='SIGTERM']
   */
  async shutdown(signal = 'SIGTERM') {
    if (this._shutdownInProgress) {
      log.warn('Shutdown already in progress');
      return;
    }

    this._shutdownInProgress = true;
    this._shutdownStart = Date.now();

    try {
      log.info('Graceful shutdown started', {
        signal,
        activeChannels: this._activeChannels.size,
      });

      // Step 1: 신규 연결 차단 (circuitBreaker enabled)
      // → 외부에서 circuitBreaker.enabled = true로 설정됨

      // Step 2: 활성 채널 드레인
      await this._drainChannels();

      // Step 3: 정리 핸들러 실행
      await this._runHandlers();

      log.info('Graceful shutdown completed', {
        elapsedMs: Date.now() - this._shutdownStart,
      });
    } catch (err) {
      log.error('Error during shutdown', err);
    }

    // Step 4: 프로세스 종료
    process.exit(0);
  }

  /**
   * 활성 채널 드레인
   * 모든 활성 채널이 완료될 때까지 대기 (또는 타임아웃)
   *
   * @private
   */
  async _drainChannels() {
    const startDrain = Date.now();

    log.info('Draining active channels', {
      count: this._activeChannels.size,
      timeoutMs: this.drainTimeoutMs,
    });

    while (this._activeChannels.size > 0) {
      const elapsedMs = Date.now() - startDrain;
      if (elapsedMs > this.drainTimeoutMs) {
        log.warn('Drain timeout reached, forcing shutdown', {
          remainingChannels: this._activeChannels.size,
          elapsedMs,
        });
        break;
      }

      // 100ms 간격으로 체크
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    log.info('Channels drained', {
      remainingChannels: this._activeChannels.size,
      elapsedMs: Date.now() - startDrain,
    });
  }

  /**
   * 등록된 핸들러 실행 (우선순위 순)
   *
   * @private
   */
  async _runHandlers() {
    log.info('Running shutdown handlers', { count: this._handlers.length });

    for (const { name, handler, priority } of this._handlers) {
      try {
        const start = Date.now();
        await handler();
        const elapsed = Date.now() - start;
        log.info('Handler completed', { name, priority, elapsedMs: elapsed });
      } catch (err) {
        log.error(`Handler '${name}' failed`, err);
        // 핸들러 실패해도 계속 진행
      }
    }
  }

  /**
   * 종료 진행 중인지 확인
   *
   * @returns {boolean}
   */
  isShuttingDown() {
    return this._shutdownInProgress;
  }

  /**
   * 활성 채널 수
   *
   * @returns {number}
   */
  getActiveChannelCount() {
    return this._activeChannels.size;
  }
}

module.exports = { GracefulShutdown };
