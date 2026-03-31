/**
 * Audit Logger — Tier 1 모듈
 * 구조화된 JSONL 형식 감사 로깅
 * 모든 중요 이벤트 추적
 */

const { createLogger } = require('./logger');
const fs = require('fs').promises;
const path = require('path');
const { appendFileSync, writeFileSync } = require('fs');

class AuditLogger {
  /**
   * 초기화 — 감사 로그 저장소 구성
   * @param {Object} opts - 옵션
   * @param {string} opts.logDir - 로그 디렉토리
   * @param {number} opts.maxFileSizeMb - 파일 크기 제한 (MB)
   * @param {number} opts.rotateCount - 보관 파일 개수
   */
  constructor(opts = {}) {
    this._logger = createLogger('AuditLogger');

    this.logDir = opts.logDir ?? 'data/audit';
    this.maxFileSizeMb = opts.maxFileSizeMb ?? 50;
    this.maxFileSize = this.maxFileSizeMb * 1024 * 1024;
    this.rotateCount = opts.rotateCount ?? 5;

    this._currentLogFile = null;
    this._currentSize = 0;
    this._initialized = false;

    this._logger.info('AuditLogger configured', {
      logDir: this.logDir,
      maxFileSizeMb: this.maxFileSizeMb,
      rotateCount: this.rotateCount
    });
  }

  /**
   * 초기화 — 로그 디렉토리 생성 및 스트림 설정
   */
  async init() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
      this._currentLogFile = path.join(this.logDir, 'audit.jsonl');
      this._initialized = true;

      this._logger.info('AuditLogger initialized', { logFile: this._currentLogFile });
    } catch (err) {
      this._logger.error('Failed to initialize AuditLogger', err);
      throw err;
    }
  }

  /**
   * 구조화된 감사 이벤트 로깅
   * @param {Object} event - 이벤트 객체
   * @param {string} event.type - 이벤트 타입 (예: 'message.received', 'tool.executed')
   * @param {string} event.agentId - 에이전트 ID
   * @param {string} [event.processType] - 프로세스 타입 (channel/worker/branch/cortex)
   * @param {string} event.action - 수행된 액션
   * @param {Object} [event.metadata] - 추가 메타데이터
   * @param {string} [event.result] - 결과 (success/failure/error)
   * @param {string} [event.traceId] - OTEL 트레이스 ID
   * @returns {Promise<void>}
   */
  async log(event) {
    try {
      if (!this._initialized) {
        await this.init();
      }

      // 표준 감사 레코드 생성
      const record = {
        timestamp: new Date().toISOString(),
        type: event.type || 'unknown',
        agentId: event.agentId,
        processType: event.processType || 'default',
        action: event.action,
        metadata: event.metadata || {},
        result: event.result || 'pending',
        traceId: event.traceId || null,
        _version: '1.0'
      };

      // JSONL 형식으로 파일에 쓰기 (try-catch로 안전하게)
      const line = JSON.stringify(record);
      const lineBytes = Buffer.byteLength(line + '\n');

      try {
        appendFileSync(this._currentLogFile, line + '\n', { flag: 'a' });
        this._currentSize += lineBytes;
      } catch (writeErr) {
        this._logger.error('Failed to write audit log', writeErr);
        // 크기 추적 불일치 시 파일 크기 재계산
        try {
          const stat = require('fs').statSync(this._currentLogFile);
          this._currentSize = stat.size;
        } catch (e) {
          this._logger.debug('Failed to stat log file', { error: e.message });
          this._currentSize = 0;
        }
      }

      // 파일 크기 초과시 로테이션
      if (this._currentSize >= this.maxFileSize) {
        await this._rotate();
      }

      this._logger.debug('Audit event logged', { type: event.type, agentId: event.agentId });
    } catch (err) {
      this._logger.error('Error logging audit event', err);
    }
  }

  /**
   * 로그 파일 로테이션
   * @private
   */
  async _rotate() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rotatedName = path.join(
        this.logDir,
        `audit.${timestamp}.jsonl`
      );

      await fs.rename(this._currentLogFile, rotatedName);
      this._currentSize = 0;

      // 오래된 파일 삭제
      const files = await fs.readdir(this.logDir);
      const auditFiles = files
        .filter(f => f.startsWith('audit.') && f.endsWith('.jsonl'))
        .sort()
        .reverse();

      if (auditFiles.length > this.rotateCount) {
        for (const oldFile of auditFiles.slice(this.rotateCount)) {
          await fs.unlink(path.join(this.logDir, oldFile));
        }
      }

      this._logger.info('Log file rotated', { rotatedName });
    } catch (err) {
      this._logger.error('Error rotating log file', err);
    }
  }

  /**
   * 감사 로그 쿼리 (기본 필터링)
   * @param {Object} filter - 필터 조건
   * @param {string} [filter.type] - 이벤트 타입
   * @param {string} [filter.agentId] - 에이전트 ID
   * @param {Date} [filter.after] - 시작 시간
   * @param {Date} [filter.before] - 종료 시간
   * @returns {AsyncGenerator<Object>} 이벤트 제너레이터
   */
  async *query(filter = {}) {
    try {
      if (!this._initialized) {
        await this.init();
      }

      const content = await fs.readFile(this._currentLogFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // 필터 적용
          if (filter.type && event.type !== filter.type) continue;
          if (filter.agentId && event.agentId !== filter.agentId) continue;

          const timestamp = new Date(event.timestamp);
          if (filter.after && timestamp < filter.after) continue;
          if (filter.before && timestamp > filter.before) continue;

          yield event;
        } catch (parseErr) {
          this._logger.warn('Failed to parse audit log line', parseErr);
        }
      }
    } catch (err) {
      this._logger.error('Error querying audit log', err);
    }
  }

  /**
   * 감사 로거 종료 및 리소스 정리
   */
  async close() {
    try {
      this._initialized = false;
      this._logger.info('AuditLogger closed');
    } catch (err) {
      this._logger.error('Error closing AuditLogger', err);
    }
  }

  /**
   * 특정 기간의 로그 내보내기
   * @param {Date} from - 시작 시간
   * @param {Date} to - 종료 시간
   * @returns {Promise<Array>}
   */
  async exportRange(from, to) {
    const results = [];
    for await (const event of this.query({ after: from, before: to })) {
      results.push(event);
    }
    return results;
  }
}

module.exports = { AuditLogger };
