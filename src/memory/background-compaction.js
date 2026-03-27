/**
 * background-compaction.js — 메인 스레드 논블로킹 압축 실행기.
 *
 * v3.9: CompactionEngine을 비동기 큐로 래핑하여 메인 스레드 블로킹 방지.
 *
 * 문제: 기존 compaction은 `shouldCompact()` → `compact()` 동기 호출로
 * 요약 LLM 호출 동안 메인 이벤트 루프를 블로킹했음.
 *
 * 해결:
 * 1. 큐 기반 — compact 요청을 큐에 넣고 하나씩 순차 처리
 * 2. PG 잡 트래킹 — compaction_jobs 테이블에 진행 상태 기록
 * 3. setImmediate — 긴 작업을 이벤트 루프 틱으로 분할
 *
 * 사용:
 *   const runner = new BackgroundCompactionRunner({ compactionEngine, db });
 *   runner.enqueue(sessionId, messages, contextLimit, channelId);
 *   // 비동기로 처리됨, 완료 시 'compaction:done' 이벤트 발생
 */
const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:bg-compaction');

const MAX_QUEUE_SIZE = 10;

class BackgroundCompactionRunner extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object} opts.compactionEngine - CompactionEngine 인스턴스
   * @param {Object} [opts.db] - PostgreSQL adapter (잡 트래킹용)
   * @param {number} [opts.maxConcurrent=1] - 동시 실행 수 (보통 1)
   */
  constructor(opts = {}) {
    super();
    this.engine = opts.compactionEngine;
    this.db = opts.db || null;
    this.maxConcurrent = opts.maxConcurrent || 1;

    this._queue = [];
    this._running = 0;
    this._stats = { enqueued: 0, completed: 0, failed: 0, dropped: 0 };
  }

  /** DB adapter 설정 (지연 주입). */
  setDb(db) { this.db = db; }

  /**
   * 압축 작업을 큐에 추가.
   *
   * @param {string} sessionId
   * @param {Array} messages - 압축 대상 메시지 배열
   * @param {number} contextLimit - 토큰 한도
   * @param {Object} [opts]
   * @param {string} [opts.channelId]
   * @param {Function} [opts.createMessage] - LLM 호출 함수
   * @param {Object} [opts.workingMemory] - WorkingMemory 인스턴스
   * @returns {{ enqueued: boolean, reason?: string }}
   */
  enqueue(sessionId, messages, contextLimit, opts = {}) {
    if (!this.engine) {
      return { enqueued: false, reason: 'No compaction engine configured' };
    }

    if (this._queue.length >= MAX_QUEUE_SIZE) {
      this._stats.dropped++;
      log.warn('Compaction queue full, dropping', { sessionId });
      return { enqueued: false, reason: 'Queue full' };
    }

    // 중복 방지 — 같은 세션 이미 큐에 있으면 스킵
    if (this._queue.some(j => j.sessionId === sessionId)) {
      return { enqueued: false, reason: 'Already queued' };
    }

    this._stats.enqueued++;
    this._queue.push({
      sessionId,
      messages,
      contextLimit,
      channelId: opts.channelId || '',
      createMessage: opts.createMessage,
      workingMemory: opts.workingMemory,
      enqueuedAt: Date.now(),
    });

    log.debug('Compaction enqueued', { sessionId, queueSize: this._queue.length });

    // 즉시 처리 시도 (논블로킹)
    setImmediate(() => this._processNext());

    return { enqueued: true };
  }

  /**
   * @private 큐에서 다음 작업 처리.
   */
  async _processNext() {
    if (this._running >= this.maxConcurrent || this._queue.length === 0) return;

    const job = this._queue.shift();
    this._running++;

    let pgJobId = null;

    try {
      // PG 잡 생성
      pgJobId = await this._createPgJob(job);

      // 압축 티어 결정
      const tier = this.engine.needsCompaction(job.messages, job.contextLimit)
        ? this._determineTier(job.messages, job.contextLimit)
        : null;

      if (!tier) {
        log.debug('Compaction not needed after recheck', { sessionId: job.sessionId });
        await this._updatePgJob(pgJobId, 'completed', { tokens_saved: 0 });
        this._stats.completed++;
        this._running--;
        setImmediate(() => this._processNext());
        return;
      }

      await this._updatePgJob(pgJobId, 'running');

      const messagesBefore = job.messages.length;

      // 실제 압축 실행 — 이미 async이므로 이벤트 루프 블로킹 없음
      const result = await this.engine.compact(
        job.messages,
        job.contextLimit,
        {
          createMessage: job.createMessage,
          workingMemory: job.workingMemory,
          tier,
        }
      );

      const messagesAfter = result?.messages?.length || messagesBefore;
      const tokensSaved = result?.tokensSaved || 0;

      await this._updatePgJob(pgJobId, 'completed', {
        messages_before: messagesBefore,
        messages_after: messagesAfter,
        tokens_saved: tokensSaved,
      });

      this._stats.completed++;
      log.info('Background compaction completed', {
        sessionId: job.sessionId,
        tier,
        messagesBefore,
        messagesAfter,
        tokensSaved,
        duration: Date.now() - job.enqueuedAt,
      });

      this.emit('compaction:done', {
        sessionId: job.sessionId,
        tier,
        result,
      });
    } catch (err) {
      this._stats.failed++;
      log.error('Background compaction failed', { sessionId: job.sessionId, error: err.message });
      await this._updatePgJob(pgJobId, 'failed', { error_message: err.message });

      this.emit('compaction:error', {
        sessionId: job.sessionId,
        error: err.message,
      });
    } finally {
      this._running--;
      setImmediate(() => this._processNext());
    }
  }

  /**
   * @private 압축 티어 결정.
   */
  _determineTier(messages, contextLimit) {
    if (!this.engine.tierThresholds) return 'background';

    const { estimateTokens } = require('../shared/utils');
    let totalTokens = 0;
    for (const msg of messages) {
      totalTokens += 4 + estimateTokens(msg.content || '');
    }
    const ratio = totalTokens / contextLimit;

    if (ratio >= (this.engine.tierThresholds.emergency || 0.95)) return 'emergency';
    if (ratio >= (this.engine.tierThresholds.aggressive || 0.85)) return 'aggressive';
    return 'background';
  }

  // ─── PG Job Tracking ───

  /** @private */
  async _createPgJob(job) {
    if (!this.db) return null;
    try {
      const result = await this.db.run(
        `INSERT INTO compaction_jobs (session_id, channel_id, tier, status, messages_before, started_at)
         VALUES (?, ?, 'background', 'pending', ?, NOW())`,
        [job.sessionId, job.channelId, job.messages.length]
      );
      return result.lastInsertRowid;
    } catch (err) {
      log.debug('PG job create failed', { error: err.message });
      return null;
    }
  }

  /** @private */
  async _updatePgJob(jobId, status, extra = {}) {
    if (!this.db || !jobId) return;
    try {
      const sets = [`status = '${status}'`];
      const params = [];

      if (status === 'running') {
        sets.push('started_at = NOW()');
      }
      if (status === 'completed' || status === 'failed') {
        sets.push('completed_at = NOW()');
      }
      if (extra.messages_before !== undefined) {
        sets.push(`messages_before = ${extra.messages_before}`);
      }
      if (extra.messages_after !== undefined) {
        sets.push(`messages_after = ${extra.messages_after}`);
      }
      if (extra.tokens_saved !== undefined) {
        sets.push(`tokens_saved = ${extra.tokens_saved}`);
      }
      if (extra.error_message) {
        params.push(extra.error_message);
        sets.push(`error_message = ?`);
      }
      if (extra.tier) {
        sets.push(`tier = '${extra.tier}'`);
      }

      await this.db.run(
        `UPDATE compaction_jobs SET ${sets.join(', ')} WHERE id = ${jobId}`,
        params
      );
    } catch (err) {
      log.debug('PG job update failed', { error: err.message });
    }
  }

  /** @returns {Object} 통계 */
  getStats() {
    return {
      ...this._stats,
      queueSize: this._queue.length,
      running: this._running,
    };
  }
}

module.exports = { BackgroundCompactionRunner };
