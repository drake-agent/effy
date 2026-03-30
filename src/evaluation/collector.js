/**
 * collector.js — 자동 수집 및 런타임 훅 (Automatic Telemetry Collector).
 *
 * 평가 프레임워크를 agents/runtime.js 및 shared/llm-client.js와
 * 연동하여 자동으로 메트릭을 수집한다.
 *
 * 훅 포인트:
 * 1. executeTool() 래퍼 — 도구 호출 추적
 * 2. createMessage() 래퍼 — LLM 호출 추적
 * 3. middleware — 세션별 메트릭 초기화/완료
 *
 * 사용법:
 *   const collector = require('./collector');
 *   await collector.initialize();
 *   // 런타임에서 자동 수집 시작
 */

const { createLogger } = require('../shared/logger');
const { getInstance: getFrameworkInstance } = require('./framework');
const { config } = require('../config');
const path = require('path');

const log = createLogger('evaluation:collector');

/**
 * 수집기 싱글톤.
 *
 * 런타임 모듈과의 통합, 훅 관리를 담당한다.
 */
class TelemetryCollector {
  constructor() {
    this.framework = getFrameworkInstance();
    this.enabled = config.evaluation?.enabled ?? true;
    this._hooks = {};
    this._initialized = false;
  }

  /**
   * 수집기 초기화.
   *
   * - 프레임워크 초기화
   * - 런타임 훅 설치
   * - 주기적 정리 스케줄
   */
  async initialize() {
    if (this._initialized) return;

    if (!this.enabled) {
      log.info('[collector] Telemetry disabled');
      this._initialized = true;
      return;
    }

    try {
      await this.framework.initialize();

      // ─── 훅 설치 (동적) ───
      this._installHooks();

      // ─── 주기적 정리 ───
      this._scheduleCleanup();

      log.info('[collector] Telemetry collector initialized');
      this._initialized = true;
    } catch (err) {
      log.error('[collector] Initialization failed', { error: err.message });
      this._initialized = true; // graceful degradation
    }
  }

  /**
   * 런타임 모듈 훅 설치.
   *
   * 동적으로 executeTool과 createMessage를 감싼다.
   */
  _installHooks() {
    try {
      // 런타임 모듈에서 기존 executeTool 획득
      // (모듈 로드 순서를 피하기 위해 lazy loading 사용)
      const runtimePath = path.resolve(__dirname, '../agents/runtime');
      if (require.cache[require.resolve(runtimePath)]) {
        // 이미 로드되었으면 훅 설치
        this._wrapExecuteTool();
      }

      // LLM 클라이언트 훅
      const llmClientPath = path.resolve(__dirname, '../shared/llm-client');
      if (require.cache[require.resolve(llmClientPath)]) {
        this._wrapCreateMessage();
      }

      log.debug('[collector] Hooks installed');
    } catch (err) {
      log.warn('[collector] Hook installation failed', { error: err.message });
    }
  }

  /**
   * executeTool 래퍼 설치.
   *
   * 각 도구 호출의 지연시간, 성공 여부를 추적한다.
   */
  _wrapExecuteTool() {
    try {
      const runtime = require('../agents/runtime');
      const originalExecuteTool = runtime.executeTool;

      if (!originalExecuteTool) return;

      // 기존 executeTool을 래핑
      runtime.executeTool = async (toolName, toolInput, ctx = {}) => {
        const sessionId = ctx.sessionId || ctx.messageContext?.threadId;
        if (!sessionId) {
          return originalExecuteTool(toolName, toolInput, ctx);
        }

        // ─── 메트릭 수집 ───
        const startTime = Date.now();
        let success = true;
        let result;

        try {
          result = await originalExecuteTool(toolName, toolInput, ctx);
          success = !result.error; // error 필드 확인
        } catch (err) {
          success = false;
          result = {
            error: err.message,
            originalError: err,
          };
        }

        const latencyMs = Date.now() - startTime;

        // ─── 프레임워크에 기록 ───
        this.framework.recordToolCall(sessionId, {
          name: toolName,
          latencyMs,
          success,
          metadata: {
            inputKeys: toolInput ? Object.keys(toolInput) : [],
          },
        });

        return result;
      };

      log.debug('[collector] executeTool hook installed');
    } catch (err) {
      log.warn('[collector] executeTool hook failed', { error: err.message });
    }
  }

  /**
   * createMessage 래퍼 설치.
   *
   * LLM 호출의 토큰 사용량, 비용, 지연시간을 추적한다.
   */
  _wrapCreateMessage() {
    try {
      const llmClient = require('../shared/llm-client');
      const originalCreateMessage = llmClient.createMessage;

      if (!originalCreateMessage) return;

      // 기존 createMessage를 래핑
      llmClient.createMessage = async (params) => {
        const sessionId = params.sessionId || null;

        const startTime = Date.now();
        const response = await originalCreateMessage(params);
        const latencyMs = Date.now() - startTime;

        if (sessionId && response.usage) {
          // ─── 토큰 및 비용 계산 ───
          const { inputTokens, outputTokens } = response.usage;
          const costUsd = this._estimateCost(params.model, inputTokens, outputTokens);

          // ─── 프레임워크에 기록 ───
          this.framework.recordLLMCall(sessionId, {
            inputTokens,
            outputTokens,
            costUsd,
            latencyMs,
          });
        }

        return response;
      };

      log.debug('[collector] createMessage hook installed');
    } catch (err) {
      log.warn('[collector] createMessage hook failed', { error: err.message });
    }
  }

  /**
   * 모델 토큰 비용 추정.
   *
   * Anthropic 가격 책정 기준 (2024년 기준):
   * - Haiku: $0.80/$4 (in/out per M tokens)
   * - Sonnet: $3/$15 (in/out per M tokens)
   * - Opus: $15/$75 (in/out per M tokens)
   *
   * @param {string} model
   * @param {number} inputTokens
   * @param {number} outputTokens
   * @returns {number} USD
   */
  _estimateCost(model, inputTokens = 0, outputTokens = 0) {
    const rates = {
      'claude-3-5-haiku-20241022': { input: 0.80 / 1000000, output: 4 / 1000000 },
      'claude-3-5-sonnet-20241022': { input: 3 / 1000000, output: 15 / 1000000 },
      'claude-3-opus-20250219': { input: 15 / 1000000, output: 75 / 1000000 },
      // fallback
      'haiku': { input: 0.80 / 1000000, output: 4 / 1000000 },
      'sonnet': { input: 3 / 1000000, output: 15 / 1000000 },
      'opus': { input: 15 / 1000000, output: 75 / 1000000 },
    };

    const rate = rates[model] || rates.haiku;
    const cost = (inputTokens * rate.input) + (outputTokens * rate.output);
    return Math.round(cost * 100000) / 100000; // 5 decimal places
  }

  /**
   * 주기적 정리 스케줄.
   *
   * retention policy에 따라 오래된 데이터를 삭제한다.
   */
  _scheduleCleanup() {
    const cleanupIntervalHours = 24;
    const cleanupIntervalMs = cleanupIntervalHours * 3600 * 1000;

    setInterval(async () => {
      try {
        const retentionDays = this.framework.retentionDays;
        await this.framework.cleanup(retentionDays);
      } catch (err) {
        log.error('[collector] Cleanup error', { error: err.message });
      }
    }, cleanupIntervalMs);

    log.debug('[collector] Cleanup scheduled', { intervalHours: cleanupIntervalHours });
  }

  /**
   * Express 미들웨어: 요청 시작/완료 시 메트릭 초기화/기록.
   *
   * 사용법:
   *   app.use(collector.middleware());
   */
  middleware() {
    return async (req, res, next) => {
      if (!this.enabled) return next();

      // ─── 세션/요청 ID ───
      const sessionId = req.sessionId || req.headers['x-session-id'] || `session_${Date.now()}`;
      const agentId = req.body?.agentId || req.query?.agentId || 'unknown';
      const modelTier = req.body?.modelTier || req.query?.modelTier || 'unknown';

      // ─── 실행 추적 시작 ───
      const runId = this.framework.startRun(sessionId, {
        agentId,
        modelTier,
      });

      req.runId = runId;
      req.sessionId = sessionId;

      // ─── 응답 완료 훅 ───
      const originalSend = res.send;
      res.send = function (data) {
        // 응답 상태로 평가 완료
        const status = res.statusCode >= 400 ? 'error' : 'completed';
        this.framework.completeRun(sessionId, { status }).catch(err => {
          log.error('[collector] Failed to complete run', { sessionId, error: err.message });
        });

        return originalSend.call(this, data);
      }.bind({ framework: this.framework });

      next();
    };
  }

  /**
   * 평가 대시보드 API 엔드포인트 제공.
   *
   * Express 라우터로 마운트:
   *   app.use('/evaluation', collector.getRouter());
   *
   * 엔드포인트:
   *   GET /evaluation/status — 수집기 상태
   *   GET /evaluation/metrics/global — 전역 메트릭
   *   GET /evaluation/metrics/agent/:agentId — 에이전트 메트릭
   *   GET /evaluation/metrics/model/:modelTier — 모델 메트릭
   *   GET /evaluation/runs — 최근 실행 목록
   *   GET /evaluation/benchmark — 벤치마크 실행
   *   GET /evaluation/stream — SSE 메트릭 스트림
   */
  getRouter() {
    const { Router } = require('express');
    const router = Router();

    // ─── 상태 ───
    router.get('/status', (req, res) => {
      return res.json(this.framework.getStatus());
    });

    // ─── 전역 메트릭 ───
    router.get('/metrics/global', async (req, res) => {
      const hours = parseInt(req.query.hours, 10) || 24;
      const metrics = await this.framework.getGlobalMetrics({ hours });
      return res.json(metrics);
    });

    // ─── 에이전트 메트릭 ───
    router.get('/metrics/agent/:agentId', async (req, res) => {
      const { agentId } = req.params;
      const hours = parseInt(req.query.hours, 10) || 24;
      const metrics = await this.framework.getAgentMetrics(agentId, { hours });
      return res.json(metrics);
    });

    // ─── 모델 메트릭 ───
    router.get('/metrics/model/:modelTier', async (req, res) => {
      const { modelTier } = req.params;
      const hours = parseInt(req.query.hours, 10) || 24;
      const metrics = await this.framework.getModelMetrics(modelTier, { hours });
      return res.json(metrics);
    });

    // ─── 최근 실행 ───
    router.get('/runs', async (req, res) => {
      const limit = parseInt(req.query.limit, 10) || 50;
      const agentId = req.query.agentId || null;
      const status = req.query.status || null;
      const runs = await this.framework.getRecentRuns({ limit, agentId, status });
      return res.json(runs);
    });

    // ─── 벤치마크 실행 ───
    router.post('/benchmark', async (req, res) => {
      const result = await this.framework.runBenchmark();
      return res.json(result);
    });

    // ─── SSE 메트릭 스트림 ───
    router.get('/stream', async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const stream = await this.framework.getMetricsStream();
      res.write(stream);
      res.end();
    });

    return router;
  }

  /**
   * 평가 프레임워크 인스턴스 획득.
   *
   * 직접 접근 필요 시 사용.
   */
  getFramework() {
    return this.framework;
  }

  /**
   * 상태 조회.
   */
  getStatus() {
    return {
      initialized: this._initialized,
      enabled: this.enabled,
      framework: this.framework.getStatus(),
    };
  }
}

// ─── 싱글톤 인스턴스 ───
let _instance = null;

function getInstance() {
  if (!_instance) {
    _instance = new TelemetryCollector();
  }
  return _instance;
}

/**
 * 초기화 (진입점).
 *
 * 사용법:
 *   const collector = require('./collector');
 *   await collector.initialize();
 */
async function initialize() {
  const collector = getInstance();
  await collector.initialize();
  return collector;
}

module.exports = {
  getInstance,
  initialize,
  TelemetryCollector,
};
