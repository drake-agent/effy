const { createLogger } = require('../../shared/logger');

// Express는 대시보드 통합 시에만 필요함 (선택적)
let Router;
try {
  Router = require('express').Router;
} catch (err) {
  // Express 미설치 시 Router 함수 목업
  Router = function () {
    return {
      get: () => {},
      post: () => {},
    };
  };
}

const log = createLogger('dashboard:live-logs');

/**
 * 실시간 로그 스트리밍
 * Live Logs Streaming — In-memory Ring Buffer + SSE
 *
 * 동작:
 * 1. 1,000개 링 버퍼에 INFO/WARN/ERROR 이벤트 저장
 * 2. SSE로 연결된 클라이언트에 실시간 브로드캐스트
 * 3. GET /api/logs — 버퍼 내 로그 조회 (필터링)
 * 4. GET /api/logs/stream — SSE 스트리밍
 */
class LiveLogBuffer {
  /**
   * @param {number} [maxSize=1000] - 링 버퍼 최대 크기
   */
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this._buffer = [];
    this._head = 0;
    this._subscribers = new Set();
    this._idCounter = 0;
    log.info('LiveLogBuffer initialized', { maxSize });
  }

  /**
   * 로그 이벤트 추가
   * @param {Object} entry - { level: 'info'|'warn'|'error', target: string, message: string }
   */
  push(entry) {
    if (!entry || typeof entry !== 'object') {
      log.warn('invalid log entry');
      return;
    }

    // 타임스탬프 추가
    const logEntry = {
      id: this._idCounter++,
      timestamp: new Date().toISOString(),
      level: entry.level || 'info',
      target: entry.target || 'unknown',
      message: entry.message || '',
      metadata: entry.metadata || {},
    };

    // 링 버퍼에 추가
    if (this._buffer.length < this.maxSize) {
      this._buffer.push(logEntry);
    } else {
      this._buffer[this._head] = logEntry;
      this._head = (this._head + 1) % this.maxSize;
    }

    // 모든 구독자에게 브로드캐스트
    this._broadcast(logEntry);
  }

  /**
   * 버퍼 내 로그 조회 (필터링)
   * @param {Object} opts - { level, target, search, limit, offset }
   * @returns {Array}
   */
  query(opts = {}) {
    let results = [...this._buffer];

    // 레벨 필터
    if (opts.level) {
      const levels = Array.isArray(opts.level) ? opts.level : [opts.level];
      results = results.filter((e) => levels.includes(e.level));
    }

    // 타겟 필터
    if (opts.target) {
      results = results.filter((e) => e.target.includes(opts.target));
    }

    // 검색 필터 (메시지에서)
    if (opts.search) {
      const searchLower = opts.search.toLowerCase();
      results = results.filter((e) => e.message.toLowerCase().includes(searchLower));
    }

    // 오프셋
    const offset = opts.offset || 0;
    if (offset > 0) {
      results = results.slice(offset);
    }

    // 제한
    const limit = opts.limit || 100;
    results = results.slice(0, limit);

    return results;
  }

  /**
   * SSE 구독자 등록
   * @param {Function} callback - (entry) => void
   * @returns {Function} 구독 해제 함수
   */
  subscribe(callback) {
    if (typeof callback !== 'function') {
      log.warn('invalid subscriber callback');
      return () => {};
    }

    this._subscribers.add(callback);
    log.debug('subscriber added', { count: this._subscribers.size });

    // 구독 해제 함수 반환
    return () => {
      this._subscribers.delete(callback);
      log.debug('subscriber removed', { count: this._subscribers.size });
    };
  }

  /**
   * 모든 구독자에게 브로드캐스트
   * @private
   */
  _broadcast(entry) {
    for (const callback of this._subscribers) {
      try {
        callback(entry);
      } catch (err) {
        log.error('broadcast callback failed', err);
        this._subscribers.delete(callback);
      }
    }
  }

  /**
   * 현재 구독자 수
   */
  get subscriberCount() {
    return this._subscribers.size;
  }

  /**
   * 버퍼 초기화 (테스트용)
   */
  clear() {
    this._buffer = [];
    this._head = 0;
    this._idCounter = 0;
    log.info('buffer cleared');
  }

  /**
   * 버퍼 상태 조회
   */
  getStatus() {
    return {
      size: this._buffer.length,
      maxSize: this.maxSize,
      subscriberCount: this.subscriberCount,
      idCounter: this._idCounter,
    };
  }
}

/**
 * Express 라우터 생성
 * @param {LiveLogBuffer} buffer - 로그 버퍼 인스턴스
 * @returns {Router}
 */
function createLiveLogRouter(buffer) {
  const router = Router();

  /**
   * GET /api/logs — 최근 로그 조회
   * 쿼리: ?level=error,warn&target=core:autonomy&search=failed&limit=50&offset=0
   */
  router.get('/', (req, res) => {
    try {
      const opts = {
        level: req.query.level ? req.query.level.split(',') : undefined,
        target: req.query.target,
        search: req.query.search,
        limit: req.query.limit ? parseInt(req.query.limit, 10) : 100,
        offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
      };

      const logs = buffer.query(opts);
      log.debug('logs queried', { count: logs.length, filters: Object.keys(opts) });

      res.json({
        success: true,
        count: logs.length,
        data: logs,
        status: buffer.getStatus(),
      });
    } catch (err) {
      log.error('query failed', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  /**
   * GET /api/logs/stream — SSE 스트리밍
   * 클라이언트: new EventSource('/api/logs/stream')
   */
  router.get('/stream', (req, res) => {
    // SSE 헤더 설정
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    log.info('sse stream opened', { remoteAddr: req.ip });

    // 기존 버퍼 내용을 초기 배치로 전송
    const initialLogs = buffer.query({ limit: 50 });
    if (initialLogs.length > 0) {
      res.write(`data: ${JSON.stringify({ type: 'batch', logs: initialLogs })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'ready' })}\n\n`);
    }

    // 새 로그 이벤트 구독
    const unsubscribe = buffer.subscribe((entry) => {
      try {
        res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
      } catch (err) {
        log.error('sse write failed', err);
      }
    });

    // 클라이언트 연결 종료 시 정리
    req.on('close', () => {
      unsubscribe();
      log.info('sse stream closed', { remoteAddr: req.ip });
    });

    req.on('error', (err) => {
      log.error('sse stream error', err);
      unsubscribe();
    });

    // 주기적 ping (연결 유지)
    const pingInterval = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch (err) {
        clearInterval(pingInterval);
        unsubscribe();
      }
    }, 30000); // 30초

    // 정리 함수
    const cleanup = () => {
      clearInterval(pingInterval);
      unsubscribe();
    };

    res.on('finish', cleanup);
    res.on('error', cleanup);
  });

  /**
   * GET /api/logs/status — 버퍼 상태 조회
   */
  router.get('/status', (req, res) => {
    try {
      const status = buffer.getStatus();
      res.json({
        success: true,
        status,
      });
    } catch (err) {
      log.error('status query failed', err);
      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  });

  return router;
}

module.exports = { LiveLogBuffer, createLiveLogRouter };
