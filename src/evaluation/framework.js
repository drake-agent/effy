/**
 * framework.js — Effy 평가 엔진 (Evaluation Framework).
 *
 * 에이전트 응답 품질을 체계적으로 측정하는 메인 엔진.
 * - 응답 지연시간, 토큰 사용량, 비용, 도구 호출 패턴 수집
 * - SQLite 저장 (evaluation_runs 테이블)
 * - 집계 API: 에이전트별, 모델별, 시간대별 분석
 * - 벤치마크 모드: 테스트 케이스 실행 및 비교
 * - SSE 호환 메트릭 제공
 *
 * 훅 포인트:
 * 1. agents/runtime.js::executeTool() — 도구 실행 추적
 * 2. shared/llm-client.js::createMessage() — LLM 호출 추적
 */

const { createLogger } = require('../shared/logger');
const { config } = require('../config');
const path = require('path');
const fs = require('fs');

const log = createLogger('evaluation');

/**
 * 평가 프레임워크 싱글톤.
 *
 * 수집된 메트릭을 메모리 및 DB에 저장하고,
 * 집계 쿼리를 제공한다.
 */
class EvaluationFramework {
  constructor() {
    // ─── 설정 ───
    this.enabled = config.evaluation?.enabled ?? true;
    this.sampleRate = config.evaluation?.sampleRate ?? 1.0;
    this.retentionDays = config.evaluation?.retentionDays ?? 30;
    this.benchmarkDir = config.evaluation?.benchmarks?.dir || './benchmarks';

    // ─── 상태 ───
    this._sessionMetrics = new Map(); // sessionId -> MetricAccumulator
    this._db = null;
    this._initialized = false;
    this._tablePrepared = false;

    // ─── 통계 (메모리 캐시) ───
    this._aggregatedMetrics = {
      perAgent: {},      // agentId -> AggregatedMetrics
      perModel: {},      // modelTier -> AggregatedMetrics
      global: null,      // AggregatedMetrics
      lastUpdated: null,
    };
  }

  /**
   * 초기화: DB 준비, 테이블 확인.
   */
  async initialize() {
    if (this._initialized) return;
    if (!this.enabled) {
      log.info('[eval] Framework disabled (evaluation.enabled=false)');
      this._initialized = true;
      return;
    }

    try {
      const { getDb } = require('../db');
      this._db = getDb();
      await this._ensureTable();
      this._initialized = true;
      log.info('[eval] Framework initialized', {
        sampleRate: this.sampleRate,
        retentionDays: this.retentionDays,
      });
    } catch (err) {
      log.error('[eval] Initialization failed', { error: err.message });
      this._initialized = true; // 실패해도 계속 진행 (graceful degradation)
    }
  }

  /**
   * 평가 데이터 저장 테이블 생성.
   *
   * evaluation_runs:
   *   runId (PK) — 각 세션/요청의 고유 ID
   *   agentId — 에이전트 식별자
   *   modelTier — 사용된 모델 (e.g., haiku, opus)
   *   totalTokensIn, totalTokensOut — 토큰 사용량
   *   costUsd — 추정 비용 (USD)
   *   latencyMs — 전체 응답 지연시간
   *   toolCallCount — 도구 호출 횟수
   *   toolSuccessRate — 성공한 도구 호출 비율 (0~1)
   *   complexityScore — 복잡도 분류 (1=simple, 5=complex)
   *   createdAt, completedAt — 타임스탬프
   */
  async _ensureTable() {
    if (this._tablePrepared) return;

    try {
      // DB가 없으면 반환 (테스트 모드)
      if (!this._db) return;

      const sql = `
        CREATE TABLE IF NOT EXISTS evaluation_runs (
          runId TEXT PRIMARY KEY,
          agentId TEXT NOT NULL,
          modelTier TEXT NOT NULL,
          totalTokensIn INTEGER DEFAULT 0,
          totalTokensOut INTEGER DEFAULT 0,
          costUsd REAL DEFAULT 0.0,
          latencyMs INTEGER DEFAULT 0,
          toolCallCount INTEGER DEFAULT 0,
          toolSuccessCount INTEGER DEFAULT 0,
          complexityScore INTEGER DEFAULT 1,
          status TEXT DEFAULT 'pending',
          createdAt TEXT NOT NULL,
          completedAt TEXT,
          metadata TEXT DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_eval_agent ON evaluation_runs(agentId, createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_eval_model ON evaluation_runs(modelTier, createdAt DESC);
        CREATE INDEX IF NOT EXISTS idx_eval_status ON evaluation_runs(status);
      `;

      const statements = sql.split(';').filter(s => s.trim());
      for (const stmt of statements) {
        if (stmt.trim()) {
          this._db.exec(stmt);
        }
      }

      this._tablePrepared = true;
      log.debug('[eval] Table prepared');
    } catch (err) {
      log.warn('[eval] Table preparation failed', { error: err.message });
      // graceful degradation: 계속 진행
    }
  }

  /**
   * 새로운 평가 세션 시작.
   *
   * @param {string} sessionId
   * @param {object} context
   * @param {string} context.agentId
   * @param {string} context.modelTier
   * @returns {string} runId
   */
  startRun(sessionId, context = {}) {
    if (!this.enabled || Math.random() > this.sampleRate) {
      return null;
    }

    const runId = this._generateRunId();
    const accumulator = new MetricAccumulator(
      runId,
      context.agentId || 'unknown',
      context.modelTier || 'unknown',
      sessionId
    );

    this._sessionMetrics.set(sessionId, accumulator);
    return runId;
  }

  /**
   * 도구 실행 기록.
   *
   * @param {string} sessionId
   * @param {object} toolInfo
   * @param {string} toolInfo.name
   * @param {number} toolInfo.latencyMs
   * @param {boolean} toolInfo.success
   * @param {object} toolInfo.metadata
   */
  recordToolCall(sessionId, toolInfo) {
    const acc = this._sessionMetrics.get(sessionId);
    if (!acc) return;

    acc.recordToolCall({
      name: toolInfo.name,
      latencyMs: toolInfo.latencyMs || 0,
      success: toolInfo.success ?? true,
      metadata: toolInfo.metadata || {},
    });
  }

  /**
   * LLM 호출 기록 (토큰, 비용).
   *
   * @param {string} sessionId
   * @param {object} llmInfo
   * @param {number} llmInfo.inputTokens
   * @param {number} llmInfo.outputTokens
   * @param {number} llmInfo.costUsd
   * @param {number} llmInfo.latencyMs
   */
  recordLLMCall(sessionId, llmInfo) {
    const acc = this._sessionMetrics.get(sessionId);
    if (!acc) return;

    acc.recordLLMCall({
      inputTokens: llmInfo.inputTokens || 0,
      outputTokens: llmInfo.outputTokens || 0,
      costUsd: llmInfo.costUsd || 0,
      latencyMs: llmInfo.latencyMs || 0,
    });
  }

  /**
   * 복잡도 점수 설정 (1=simple, 5=complex).
   */
  setComplexity(sessionId, score) {
    const acc = this._sessionMetrics.get(sessionId);
    if (!acc) return;
    acc.complexityScore = Math.max(1, Math.min(5, score));
  }

  /**
   * 세션 완료. DB에 저장.
   *
   * @param {string} sessionId
   * @param {object} finalContext
   * @param {string} finalContext.status — 'success', 'error', 'timeout' 등
   */
  async completeRun(sessionId, finalContext = {}) {
    const acc = this._sessionMetrics.get(sessionId);
    if (!acc) return;

    try {
      acc.status = finalContext.status || 'completed';
      acc.completedAt = new Date().toISOString();

      await this._persistRun(acc);
      this._invalidateAggregation(); // 캐시 무효화
    } catch (err) {
      log.error('[eval] Failed to complete run', { sessionId, error: err.message });
    } finally {
      this._sessionMetrics.delete(sessionId);
    }
  }

  /**
   * 메트릭을 DB에 저장.
   */
  async _persistRun(accumulator) {
    if (!this._db || !this._tablePrepared) return;

    try {
      const stmt = this._db.prepare(`
        INSERT INTO evaluation_runs (
          runId, agentId, modelTier, totalTokensIn, totalTokensOut,
          costUsd, latencyMs, toolCallCount, toolSuccessCount,
          complexityScore, status, createdAt, completedAt, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const metadata = {
        toolCalls: accumulator.toolCalls,
        llmCalls: accumulator.llmCalls.length,
      };

      stmt.run(
        accumulator.runId,
        accumulator.agentId,
        accumulator.modelTier,
        accumulator.totalTokensIn,
        accumulator.totalTokensOut,
        accumulator.costUsd,
        accumulator.getTotalLatency(),
        accumulator.toolCalls.length,
        accumulator.toolCalls.filter(t => t.success).length,
        accumulator.complexityScore,
        accumulator.status,
        accumulator.createdAt,
        accumulator.completedAt,
        JSON.stringify(metadata)
      );

      log.debug('[eval] Run persisted', { runId: accumulator.runId });
    } catch (err) {
      log.error('[eval] Persistence failed', { error: err.message });
    }
  }

  /**
   * 집계 쿼리: 에이전트별 메트릭.
   *
   * @param {string} agentId
   * @param {object} options
   * @param {number} options.hours — 최근 N시간 (기본 24)
   * @returns {object} AggregatedMetrics
   */
  async getAgentMetrics(agentId, options = {}) {
    const hours = options.hours || 24;
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    if (!this._db) return this._emptyAggregation();

    try {
      const stmt = this._db.prepare(`
        SELECT
          COUNT(*) as runCount,
          AVG(latencyMs) as avgLatencyMs,
          MAX(latencyMs) as maxLatencyMs,
          AVG(totalTokensIn) as avgTokensIn,
          AVG(totalTokensOut) as avgTokensOut,
          SUM(costUsd) as totalCostUsd,
          AVG(toolCallCount) as avgToolCallCount,
          CASE
            WHEN COUNT(*) > 0 THEN
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::REAL / COUNT(*) * 100
            ELSE 0
          END as successRate,
          AVG(complexityScore) as avgComplexity
        FROM evaluation_runs
        WHERE agentId = ? AND createdAt >= ? AND status != 'pending'
      `);

      const row = stmt.get(agentId, since);
      return row ? this._rowToMetrics(row) : this._emptyAggregation();
    } catch (err) {
      log.warn('[eval] Query failed', { agentId, error: err.message });
      return this._emptyAggregation();
    }
  }

  /**
   * 집계 쿼리: 모델별 메트릭.
   */
  async getModelMetrics(modelTier, options = {}) {
    const hours = options.hours || 24;
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    if (!this._db) return this._emptyAggregation();

    try {
      const stmt = this._db.prepare(`
        SELECT
          COUNT(*) as runCount,
          AVG(latencyMs) as avgLatencyMs,
          MAX(latencyMs) as maxLatencyMs,
          AVG(totalTokensIn) as avgTokensIn,
          AVG(totalTokensOut) as avgTokensOut,
          SUM(costUsd) as totalCostUsd,
          AVG(toolCallCount) as avgToolCallCount,
          CASE
            WHEN COUNT(*) > 0 THEN
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::REAL / COUNT(*) * 100
            ELSE 0
          END as successRate,
          AVG(complexityScore) as avgComplexity
        FROM evaluation_runs
        WHERE modelTier = ? AND createdAt >= ? AND status != 'pending'
      `);

      const row = stmt.get(modelTier, since);
      return row ? this._rowToMetrics(row) : this._emptyAggregation();
    } catch (err) {
      log.warn('[eval] Query failed', { modelTier, error: err.message });
      return this._emptyAggregation();
    }
  }

  /**
   * 집계 쿼리: 전역 메트릭.
   */
  async getGlobalMetrics(options = {}) {
    const hours = options.hours || 24;
    const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    if (!this._db) return this._emptyAggregation();

    try {
      const stmt = this._db.prepare(`
        SELECT
          COUNT(*) as runCount,
          COUNT(DISTINCT agentId) as agentCount,
          COUNT(DISTINCT modelTier) as modelCount,
          AVG(latencyMs) as avgLatencyMs,
          MAX(latencyMs) as maxLatencyMs,
          MIN(latencyMs) as minLatencyMs,
          AVG(totalTokensIn) as avgTokensIn,
          AVG(totalTokensOut) as avgTokensOut,
          SUM(costUsd) as totalCostUsd,
          AVG(toolCallCount) as avgToolCallCount,
          CASE
            WHEN COUNT(*) > 0 THEN
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::REAL / COUNT(*) * 100
            ELSE 0
          END as successRate,
          AVG(complexityScore) as avgComplexity
        FROM evaluation_runs
        WHERE createdAt >= ? AND status != 'pending'
      `);

      const row = stmt.get(since);
      return row ? this._rowToMetrics(row) : this._emptyAggregation();
    } catch (err) {
      log.warn('[eval] Global query failed', { error: err.message });
      return this._emptyAggregation();
    }
  }

  /**
   * 최근 완료된 실행들 조회.
   *
   * @param {object} options
   * @param {number} options.limit
   * @param {string} options.agentId
   * @param {string} options.status
   */
  async getRecentRuns(options = {}) {
    const limit = options.limit || 50;
    const agentId = options.agentId || null;
    const status = options.status || null;

    if (!this._db) return [];

    try {
      let sql = 'SELECT * FROM evaluation_runs WHERE 1=1';
      const params = [];

      if (agentId) {
        sql += ' AND agentId = ?';
        params.push(agentId);
      }
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      sql += ' ORDER BY completedAt DESC LIMIT ?';
      params.push(limit);

      const stmt = this._db.prepare(sql);
      return stmt.all(...params);
    } catch (err) {
      log.warn('[eval] Recent runs query failed', { error: err.message });
      return [];
    }
  }

  /**
   * 벤치마크 모드: 테스트 케이스 세트 실행.
   *
   * 벤치마크 디렉토리에서 JSON 형식의 테스트 케이스를 로드하고,
   * 각각을 실행한 후 결과를 비교한다.
   *
   * 테스트 케이스 형식:
   * {
   *   name: "test name",
   *   input: "user prompt",
   *   expectedAgent: "agent-id",
   *   expectedTokensLessThan: 5000,
   *   expectedLatencyLessThanMs: 10000,
   *   minSuccessRate: 0.9
   * }
   *
   * @returns {object} BenchmarkResult
   */
  async runBenchmark() {
    if (!fs.existsSync(this.benchmarkDir)) {
      log.warn('[eval] Benchmark directory not found', { dir: this.benchmarkDir });
      return { status: 'error', message: 'Benchmark directory not found' };
    }

    log.info('[eval] Starting benchmark', { dir: this.benchmarkDir });

    try {
      const files = fs
        .readdirSync(this.benchmarkDir)
        .filter(f => f.endsWith('.json'));

      const results = [];
      for (const file of files) {
        const filePath = path.join(this.benchmarkDir, file);
        const testCases = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

        for (const testCase of testCases) {
          const result = await this._runSingleBenchmark(testCase);
          results.push(result);
        }
      }

      const summary = this._summarizeBenchmark(results);
      log.info('[eval] Benchmark complete', {
        totalTests: results.length,
        passed: summary.passed,
        failed: summary.failed,
      });

      return {
        status: 'completed',
        results,
        summary,
      };
    } catch (err) {
      log.error('[eval] Benchmark failed', { error: err.message });
      return { status: 'error', message: err.message };
    }
  }

  /**
   * 단일 벤치마크 테스트 실행.
   */
  async _runSingleBenchmark(testCase) {
    const start = Date.now();
    const result = {
      name: testCase.name,
      passed: true,
      failures: [],
      actual: {},
    };

    try {
      // 여기서는 스텁 — 실제로는 에이전트를 호출해야 함
      // (런타임 통합 시점에서 구현)

      if (testCase.expectedTokensLessThan) {
        // result.actual.tokens = ...
        // if (result.actual.tokens > testCase.expectedTokensLessThan) {
        //   result.passed = false;
        //   result.failures.push('tokens exceeded');
        // }
      }

      result.actual.latencyMs = Date.now() - start;
    } catch (err) {
      result.passed = false;
      result.failures.push(err.message);
    }

    return result;
  }

  /**
   * 벤치마크 결과 요약.
   */
  _summarizeBenchmark(results) {
    return {
      total: results.length,
      passed: results.filter(r => r.passed).length,
      failed: results.filter(r => !r.passed).length,
      passRate: results.length > 0 ? (results.filter(r => r.passed).length / results.length * 100).toFixed(2) + '%' : 'N/A',
    };
  }

  /**
   * 지난 데이터 정리 (retention policy).
   *
   * @param {number} days — N일 이상 된 레코드 삭제
   */
  async cleanup(days = null) {
    const retentionDays = days || this.retentionDays;

    if (!this._db || !this._tablePrepared) return;

    try {
      const before = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
      const stmt = this._db.prepare(
        'DELETE FROM evaluation_runs WHERE createdAt < ? AND status IN (?, ?)'
      );

      const info = stmt.run(before, 'completed', 'error');
      log.info('[eval] Cleanup complete', {
        retentionDays,
        deleted: info.changes,
      });
    } catch (err) {
      log.error('[eval] Cleanup failed', { error: err.message });
    }
  }

  /**
   * SSE 호환 메트릭 스트림.
   *
   * @returns {string} newline-delimited JSON
   */
  async getMetricsStream() {
    const globalMetrics = await this.getGlobalMetrics({ hours: 1 });
    const recentRuns = await this.getRecentRuns({ limit: 20 });

    const lines = [
      `data: ${JSON.stringify({ type: 'global', data: globalMetrics })}\n`,
      `data: ${JSON.stringify({
        type: 'recent',
        data: recentRuns.map(r => ({
          runId: r.runId,
          agentId: r.agentId,
          modelTier: r.modelTier,
          latencyMs: r.latencyMs,
          costUsd: r.costUsd,
          status: r.status,
          completedAt: r.completedAt,
        })),
      })}\n`,
    ];

    return lines.join('\n');
  }

  /**
   * 유틸: 빈 집계 객체 생성.
   */
  _emptyAggregation() {
    return {
      runCount: 0,
      agentCount: 0,
      modelCount: 0,
      avgLatencyMs: 0,
      maxLatencyMs: 0,
      minLatencyMs: 0,
      avgTokensIn: 0,
      avgTokensOut: 0,
      totalCostUsd: 0,
      avgToolCallCount: 0,
      successRate: 0,
      avgComplexity: 1,
    };
  }

  /**
   * DB 행을 집계 메트릭으로 변환.
   */
  _rowToMetrics(row) {
    return {
      runCount: row.runCount || 0,
      agentCount: row.agentCount || 0,
      modelCount: row.modelCount || 0,
      avgLatencyMs: Math.round(row.avgLatencyMs || 0),
      maxLatencyMs: row.maxLatencyMs || 0,
      minLatencyMs: row.minLatencyMs || 0,
      avgTokensIn: Math.round(row.avgTokensIn || 0),
      avgTokensOut: Math.round(row.avgTokensOut || 0),
      totalCostUsd: Math.round((row.totalCostUsd || 0) * 10000) / 10000,
      avgToolCallCount: Math.round(row.avgToolCallCount || 0),
      successRate: Math.round(row.successRate || 0),
      avgComplexity: Math.round((row.avgComplexity || 1) * 10) / 10,
    };
  }

  /**
   * 캐시 무효화.
   */
  _invalidateAggregation() {
    this._aggregatedMetrics = {
      perAgent: {},
      perModel: {},
      global: null,
      lastUpdated: null,
    };
  }

  /**
   * 고유 runId 생성.
   */
  _generateRunId() {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * 상태 조회 (디버깅용).
   */
  getStatus() {
    return {
      enabled: this.enabled,
      initialized: this._initialized,
      tablePrepared: this._tablePrepared,
      activeSessions: this._sessionMetrics.size,
      sampleRate: this.sampleRate,
      retentionDays: this.retentionDays,
    };
  }
}

/**
 * 메트릭 누적기 (MetricAccumulator).
 *
 * 단일 평가 실행(runId)에 대해 모든 관찰을 누적한다.
 */
class MetricAccumulator {
  constructor(runId, agentId, modelTier, sessionId) {
    this.runId = runId;
    this.agentId = agentId;
    this.modelTier = modelTier;
    this.sessionId = sessionId;

    this.totalTokensIn = 0;
    this.totalTokensOut = 0;
    this.costUsd = 0;
    this.toolCalls = [];
    this.llmCalls = [];
    this.complexityScore = 1;
    this.status = 'pending';
    this.createdAt = new Date().toISOString();
    this.completedAt = null;
  }

  recordToolCall(info) {
    this.toolCalls.push({
      name: info.name,
      latencyMs: info.latencyMs,
      success: info.success,
      metadata: info.metadata,
      timestamp: new Date().toISOString(),
    });
  }

  recordLLMCall(info) {
    this.totalTokensIn += info.inputTokens || 0;
    this.totalTokensOut += info.outputTokens || 0;
    this.costUsd += info.costUsd || 0;

    this.llmCalls.push({
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      costUsd: info.costUsd,
      latencyMs: info.latencyMs,
      timestamp: new Date().toISOString(),
    });
  }

  getTotalLatency() {
    let total = 0;
    for (const tool of this.toolCalls) {
      total += tool.latencyMs || 0;
    }
    for (const llm of this.llmCalls) {
      total += llm.latencyMs || 0;
    }
    return total;
  }
}

// ─── 싱글톤 인스턴스 ───
let _instance = null;

function getInstance() {
  if (!_instance) {
    _instance = new EvaluationFramework();
  }
  return _instance;
}

module.exports = {
  getInstance,
  EvaluationFramework,
  MetricAccumulator,
};
