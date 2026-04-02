/**
 * agent-service.js — Agent-as-a-Service (AaaS) HTTP 래퍼.
 *
 * 각 Effy 에이전트를 Express 기반 마이크로서비스로 노출.
 * - POST /execute: 도구 호출 실행
 * - POST /chat: 메시지 처리
 * - GET /health: 헬스 체크
 * - GET /metrics: Prometheus 스타일 메트릭
 * - Redis 선택 공유 세션 (local Map으로 우아하게 재설정)
 *
 * 모드:
 *  - local: 프로세스 내 (기본, 현재 동작)
 *  - redis: Redis 기반 분산 세션
 *  - kubernetes: K8s 네트워크
 */

const { createLogger } = require('../shared/logger');
const { authenticate, requireAuth } = require('../security/auth-middleware');
const http = require('http');

const log = createLogger('agent-service');

// Express는 필요할 때만 로드 (선택적 의존성)
let express = null;

/**
 * AgentService: 에이전트 마이크로서비스 인스턴스.
 *
 * @param {object} agentInstance - Gateway 에이전트 인스턴스
 * @param {number} port - HTTP 서버 포트
 * @param {object} options - { sessionStore, messagebus, mode }
 */
class AgentService {
  constructor(agentInstance, port, options = {}) {
    this.agentInstance = agentInstance;
    this.agentId = agentInstance.id;
    this.port = port;
    this.mode = options.mode || 'local';
    this.sessionStore = options.sessionStore || null;
    this.messageBus = options.messageBus || null;

    this.app = null;
    this._appInitialized = false;
    this.server = null;
    this.running = false;

    // 메트릭
    this.metrics = {
      requests: 0,
      errors: 0,
      avgResponseTimeMs: 0,
      lastErrorAt: null,
      health: 'up',
    };

    // 응답 시간 추적 (이동 평균)
    this.responseTimes = [];
    this.maxResponseTimes = 100;

    this._setupRoutes();
  }

  /**
   * Express 라우트 설정.
   */
  _setupRoutes() {
    // Express 초기화 (지연 로드)
    if (!express) {
      try {
        express = require('express');
      } catch (err) {
        log.error('Express not found. Install with: npm install express', { error: err.message });
        throw new Error('Express required for AgentService. Install with: npm install express');
      }
    }

    if (!this.app && !this._appInitialized) {
      this.app = express();
      this._appInitialized = true;
    }

    // JSON 파싱
    this.app.use(express.json({ limit: '10mb' }));

    // v4.0 security: authenticate all requests (sets req.user if valid credentials)
    this.app.use(authenticate());

    // 요청/응답 로깅
    this.app.use((req, res, next) => {
      const startTime = Date.now();
      res.on('finish', () => {
        const elapsed = Date.now() - startTime;
        this.metrics.requests++;
        this._trackResponseTime(elapsed);
        log.debug(`${req.method} ${req.path} → ${res.statusCode} (${elapsed}ms)`);
      });
      next();
    });

    // ─── 헬스 체크 ───
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.metrics.health,
        agentId: this.agentId,
        uptime: process.uptime(),
        mode: this.mode,
      });
    });

    // ─── 메트릭 (Prometheus 호환) ───
    this.app.get('/metrics', (req, res) => {
      const metrics = `
# HELP agent_requests_total Total requests
# TYPE agent_requests_total counter
agent_requests_total{agent="${this.agentId}"} ${this.metrics.requests}

# HELP agent_errors_total Total errors
# TYPE agent_errors_total counter
agent_errors_total{agent="${this.agentId}"} ${this.metrics.errors}

# HELP agent_response_time_ms Average response time
# TYPE agent_response_time_ms gauge
agent_response_time_ms{agent="${this.agentId}"} ${this.metrics.avgResponseTimeMs.toFixed(2)}

# HELP agent_health Agent health status (1=up, 0=down)
# TYPE agent_health gauge
agent_health{agent="${this.agentId}"} ${this.metrics.health === 'up' ? 1 : 0}
      `.trim();
      res.type('text/plain').send(metrics);
    });

    // ─── 도구 실행 (execute) ───
    // POST /execute
    // 바디: { toolName, input, sessionId, context? }
    this.app.post('/execute', requireAuth(), async (req, res) => {
      try {
        const { toolName, input, sessionId, context } = req.body;

        if (!toolName || !input || !sessionId) {
          return res.status(400).json({
            error: 'Missing required fields: toolName, input, sessionId',
          });
        }

        // 세션 로드
        const session = await this._loadSession(sessionId);

        // 도구 실행 위임 (에이전트 구현에 따름)
        // 간단한 예: await this.agentInstance.executeTool(toolName, input, session)
        const result = await this.agentInstance.executeTool?.(
          toolName,
          input,
          session,
          context
        );

        // 세션 저장
        await this._saveSession(sessionId, session);

        res.json({
          success: true,
          result,
          sessionId,
        });
      } catch (err) {
        this.metrics.errors++;
        this.metrics.lastErrorAt = new Date();
        log.error(`execute failed: ${err.message}`, { error: err });
        res.status(500).json({
          error: err.message,
          stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        });
      }
    });

    // ─── 메시지 처리 (chat) ───
    // POST /chat
    // 바디: { message, sessionId, channel?, user?, context? }
    this.app.post('/chat', requireAuth(), async (req, res) => {
      try {
        const { message, sessionId, channel, user, context } = req.body;

        if (!message || !sessionId) {
          return res.status(400).json({
            error: 'Missing required fields: message, sessionId',
          });
        }

        // 세션 로드
        const session = await this._loadSession(sessionId);

        // 메시지 처리 위임
        const response = await this.agentInstance.processMessage?.(
          message,
          session,
          {
            channel,
            user,
            ...context,
          }
        );

        // 세션 저장
        await this._saveSession(sessionId, session);

        res.json({
          success: true,
          response,
          sessionId,
        });
      } catch (err) {
        this.metrics.errors++;
        this.metrics.lastErrorAt = new Date();
        log.error(`chat failed: ${err.message}`, { error: err });
        res.status(500).json({
          error: err.message,
          stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        });
      }
    });

    // ─── 세션 조회 ───
    // GET /session/:sessionId
    this.app.get('/session/:sessionId', async (req, res) => {
      try {
        const { sessionId } = req.params;
        const session = await this._loadSession(sessionId);
        res.json({
          sessionId,
          session: session || null,
        });
      } catch (err) {
        log.error(`session load failed: ${err.message}`);
        res.status(500).json({ error: err.message });
      }
    });

    // ─── 에이전트 정보 ───
    // GET /info
    this.app.get('/info', (req, res) => {
      res.json({
        agentId: this.agentId,
        mode: this.mode,
        port: this.port,
        uptime: process.uptime(),
        version: '1.0.0',
      });
    });

    // 404
    this.app.use((req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // 에러 핸들링
    this.app.use((err, req, res, next) => {
      log.error(`Unhandled error: ${err.message}`, { error: err });
      this.metrics.errors++;
      res.status(500).json({ error: 'Internal server error' });
    });
  }

  /**
   * 응답 시간 추적 (이동 평균).
   * @param {number} ms
   */
  _trackResponseTime(ms) {
    this.responseTimes.push(ms);
    if (this.responseTimes.length > this.maxResponseTimes) {
      this.responseTimes.shift();
    }
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    this.metrics.avgResponseTimeMs = sum / this.responseTimes.length;
  }

  /**
   * 세션 로드 (sessionStore 또는 로컬 Map).
   * @param {string} sessionId
   * @returns {Promise<object>}
   */
  async _loadSession(sessionId) {
    if (this.sessionStore) {
      return await this.sessionStore.get(sessionId);
    }
    // 로컬 폴백 (Map)
    return this._localSessions?.get(sessionId) || {};
  }

  /**
   * 세션 저장.
   * @param {string} sessionId
   * @param {object} session
   * @returns {Promise<void>}
   */
  async _saveSession(sessionId, session) {
    if (this.sessionStore) {
      await this.sessionStore.set(sessionId, session);
    } else {
      // 로컬 폴백
      if (!this._localSessions) {
        this._localSessions = new Map();
      }
      this._localSessions.set(sessionId, session);
    }
  }

  /**
   * 서버 시작.
   * @returns {Promise<void>}
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.server = http.createServer(this.app);
        this.server.listen(this.port, () => {
          this.running = true;
          log.info(`AgentService started: ${this.agentId}:${this.port}`);
          resolve();
        });

        this.server.on('error', (err) => {
          this.metrics.health = 'down';
          log.error(`Server error: ${err.message}`, { error: err });
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 서버 중지.
   * @returns {Promise<void>}
   */
  async stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        return resolve();
      }

      this.server.close((err) => {
        this.running = false;
        this.metrics.health = 'down';
        if (err) {
          log.error(`Server close error: ${err.message}`);
          reject(err);
        } else {
          log.info(`AgentService stopped: ${this.agentId}`);
          resolve();
        }
      });

      // 강제 종료 타임아웃 (10초)
      setTimeout(() => {
        if (this.running) {
          log.warn(`Force closing server after timeout`);
          this.server?.destroy();
          resolve();
        }
      }, 10000);
    });
  }

  /**
   * 헬스 체크.
   * @returns {boolean}
   */
  isHealthy() {
    return this.running && this.metrics.health === 'up';
  }

  /**
   * 메트릭 조회.
   * @returns {object}
   */
  getMetrics() {
    return { ...this.metrics };
  }
}

module.exports = {
  AgentService,
};
