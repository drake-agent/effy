/**
 * run-logger.js — P-6: Agent Run Observability.
 *
 * NDJSON append-only 로그로 에이전트 실행 기록을 저장한다.
 * 일별 파일 (runs-YYYY-MM-DD.ndjson)로 자동 로테이션.
 *
 * 쿼리 예시:
 *   cat data/runs/runs-2026-03-16.ndjson | jq 'select(.agentId == "strategy")'
 *   cat data/runs/runs-2026-03-16.ndjson | jq -s 'sort_by(-.costUsd) | .[0:10]'
 */
const fs = require('fs');
const path = require('path');

class RunLogger {
  /**
   * @param {string} logDir - 로그 디렉토리 경로 (기본: ./data/runs)
   */
  constructor(logDir = './data/runs') {
    this.logDir = path.resolve(logDir);
    this.stream = null;
    this.currentDate = null;

    // 디렉토리 생성 (재귀)
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * 현재 날짜의 로그 파일 스트림 확보.
   * 날짜가 바뀌면 이전 스트림 종료 + 새 파일 오픈.
   */
  _ensureStream() {
    const today = new Date().toISOString().slice(0, 10);
    if (today === this.currentDate && this.stream) {
      return this.stream;
    }

    // 이전 스트림 닫기
    if (this.stream) {
      this.stream.end();
    }

    this.currentDate = today;
    const filePath = path.join(this.logDir, `runs-${today}.ndjson`);
    this.stream = fs.createWriteStream(filePath, { flags: 'a' });
    return this.stream;
  }

  /**
   * 에이전트 실행 기록 1건을 로그에 어펜드.
   *
   * @param {object} entry
   * @param {string} entry.traceId
   * @param {string} entry.agentId
   * @param {string} entry.functionType
   * @param {string} entry.budgetProfile
   * @param {string} entry.model
   * @param {string} entry.userId
   * @param {string} entry.channelId
   * @param {number} entry.inputTokens
   * @param {number} entry.outputTokens
   * @param {number} entry.iterations
   * @param {string[]} entry.toolCalls
   * @param {number} entry.durationMs
   * @param {number} entry.costUsd
   */
  log(entry) {
    try {
      const stream = this._ensureStream();
      const record = {
        ts: new Date().toISOString(),
        ...entry,
      };
      stream.write(JSON.stringify(record) + '\n');
    } catch (err) {
      // 로깅 실패는 메인 파이프라인을 중단하지 않음
      console.error(`[run-logger] Write error: ${err.message}`);
    }
  }

  /**
   * 스트림 정리 (graceful shutdown 시 호출).
   */
  close() {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
      this.currentDate = null;
    }
  }
}

module.exports = { RunLogger };
