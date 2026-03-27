/**
 * worker-inspect.js — Worker 트랜스크립트 감사 (SpaceBot 차용).
 *
 * Delegation 모델에서 Worker가 실행한 실제 트랜스크립트를
 * Channel/Branch가 열람하여 LLM 요약이 아닌 실제 결과를 검증.
 *
 * 용도:
 * - Worker 결과의 hallucination 방지
 * - 도구 호출 이력 감사 (어떤 도구가 어떤 인자로 실행되었는지)
 * - 에러 디버깅 (Worker가 실패한 원인 파악)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('worker-inspect');

class WorkerTranscriptStore {
  constructor() {
    /** @type {Map<string, WorkerTranscript>} */
    this.transcripts = new Map();
    this.maxTranscripts = 100;
    this.ttlMs = 3600000; // 1시간
  }

  /**
   * Worker 트랜스크립트 기록 시작.
   * @param {string} workerId
   * @param {Object} metadata - { agentId, taskType, delegatedBy, startedAt }
   */
  begin(workerId, metadata = {}) {
    this.transcripts.set(workerId, {
      workerId,
      metadata,
      entries: [],
      startedAt: Date.now(),
      completedAt: null,
      status: 'running',
      outcome: null,
    });
    this._evictOld();
  }

  /**
   * 트랜스크립트에 항목 추가.
   * @param {string} workerId
   * @param {'tool_call'|'tool_result'|'llm_turn'|'error'|'status'} type
   * @param {Object} data
   */
  append(workerId, type, data) {
    const transcript = this.transcripts.get(workerId);
    if (!transcript) return;

    transcript.entries.push({
      type,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Worker 완료 기록.
   * @param {string} workerId
   * @param {'success'|'failure'|'timeout'|'cancelled'} status
   * @param {Object} [outcome]
   */
  complete(workerId, status, outcome = null) {
    const transcript = this.transcripts.get(workerId);
    if (!transcript) return;

    transcript.status = status;
    transcript.completedAt = Date.now();
    transcript.outcome = outcome;

    log.info('Worker transcript completed', {
      workerId,
      status,
      entries: transcript.entries.length,
      durationMs: transcript.completedAt - transcript.startedAt,
    });
  }

  /**
   * 트랜스크립트 조회 (inspect).
   * @param {string} workerId
   * @returns {Object|null}
   */
  inspect(workerId) {
    const transcript = this.transcripts.get(workerId);
    if (!transcript) return null;

    return {
      ...transcript,
      summary: this._summarize(transcript),
    };
  }

  /**
   * 도구 호출만 필터 조회.
   * @param {string} workerId
   * @returns {Array}
   */
  getToolCalls(workerId) {
    const transcript = this.transcripts.get(workerId);
    if (!transcript) return [];

    return transcript.entries
      .filter(e => e.type === 'tool_call' || e.type === 'tool_result')
      .map(e => ({
        type: e.type,
        tool: e.data.name || e.data.toolName,
        input: e.data.input,
        output: e.type === 'tool_result' ? e.data.output : undefined,
        success: e.data.success,
        timestamp: e.timestamp,
      }));
  }

  /**
   * 실행 중인 Worker 목록.
   * @returns {Array}
   */
  getRunning() {
    return Array.from(this.transcripts.values())
      .filter(t => t.status === 'running')
      .map(t => ({
        workerId: t.workerId,
        agentId: t.metadata.agentId,
        taskType: t.metadata.taskType,
        durationMs: Date.now() - t.startedAt,
        entries: t.entries.length,
      }));
  }

  /** @private */
  _summarize(transcript) {
    const toolCalls = transcript.entries.filter(e => e.type === 'tool_call').length;
    const errors = transcript.entries.filter(e => e.type === 'error').length;
    const llmTurns = transcript.entries.filter(e => e.type === 'llm_turn').length;

    return {
      totalEntries: transcript.entries.length,
      toolCalls,
      errors,
      llmTurns,
      durationMs: (transcript.completedAt || Date.now()) - transcript.startedAt,
      status: transcript.status,
    };
  }

  /** @private */
  _evictOld() {
    const now = Date.now();
    for (const [id, t] of this.transcripts) {
      if (t.completedAt && (now - t.completedAt > this.ttlMs)) {
        this.transcripts.delete(id);
      }
    }
    // 초과 시 완료된 것만 제거
    if (this.transcripts.size > this.maxTranscripts) {
      const sorted = [...this.transcripts.entries()]
        .filter(([, t]) => t.status !== 'running')
        .sort((a, b) => a[1].startedAt - b[1].startedAt);
      const toRemove = sorted.slice(0, Math.max(0, this.transcripts.size - this.maxTranscripts));
      for (const [id] of toRemove) this.transcripts.delete(id);
    }
  }
}

module.exports = { WorkerTranscriptStore };
