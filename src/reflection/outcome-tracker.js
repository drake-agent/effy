/**
 * outcome-tracker.js — OutcomeTracker: 에이전트 응답 품질 추적.
 *
 * 설계 도면 "복리 효과 측정" 차용:
 * - Lessons Learned 항목 수 (누적)
 * - 동일 실수 반복률 (감소 추세)
 * - Pending Items 평균 체류 시간 (단축 추세)
 *
 * RunLogger 확장: 기존 NDJSON 로그에 outcome 필드 추가
 * 주기적 집계: 에이전트별/유형별 성공률, 교정률, 평균 반복 횟수
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('reflection:outcome');

class OutcomeTracker {
  /**
   * @param {object} deps
   * @param {object} deps.runLogger - RunLogger 인스턴스
   */
  constructor({ runLogger }) {
    this.runLogger = runLogger;

    // 인메모리 집계 (프로세스 재시작 시 리셋 — 영속성은 RunLogger NDJSON에 의존)
    this._stats = new Map(); // agentId → { total, positive, negative, corrections, totalIterations }
  }

  /**
   * 에이전트 실행 완료 후 결과를 기록한다.
   * Gateway Step ⑫ (RunLogger.log) 와 함께 호출.
   *
   * @param {object} runEntry - RunLogger에 기록할 엔트리 (기존 필드)
   * @param {object} outcome  - { sentiment, correctionDetected, correctionScore }
   */
  recordOutcome(runEntry, outcome = {}) {
    // RunLogger 엔트리에 outcome 필드 추가
    const enrichedEntry = {
      ...runEntry,
      outcome: {
        sentiment: outcome.sentiment || 'neutral',
        correctionDetected: outcome.correctionDetected || false,
        correctionScore: outcome.correctionScore || 0,
      },
    };

    // RunLogger에 기록 (NDJSON)
    this.runLogger.log(enrichedEntry);

    // 인메모리 집계 갱신
    this._updateStats(runEntry.agentId, outcome);
  }

  /**
   * 인메모리 통계 갱신.
   * @private
   */
  _updateStats(agentId, outcome) {
    if (!agentId) return;

    let stat = this._stats.get(agentId);
    if (!stat) {
      stat = { total: 0, positive: 0, negative: 0, corrections: 0, totalIterations: 0 };
      this._stats.set(agentId, stat);
    }

    stat.total++;
    if (outcome.sentiment === 'positive') stat.positive++;
    if (outcome.sentiment === 'negative') stat.negative++;
    if (outcome.correctionDetected) stat.corrections++;
  }

  /**
   * 에이전트별 성과 리포트 생성.
   * Slack DM이나 Nightly Distillation 리포트에 사용.
   *
   * @returns {Array<{ agentId, total, positiveRate, correctionRate, avgIterations }>}
   */
  getPerformanceReport() {
    const report = [];

    for (const [agentId, stat] of this._stats) {
      report.push({
        agentId,
        total: stat.total,
        positiveRate: stat.total > 0 ? (stat.positive / stat.total * 100).toFixed(1) + '%' : 'N/A',
        correctionRate: stat.total > 0 ? (stat.corrections / stat.total * 100).toFixed(1) + '%' : 'N/A',
        negativeRate: stat.total > 0 ? (stat.negative / stat.total * 100).toFixed(1) + '%' : 'N/A',
      });
    }

    return report.sort((a, b) => b.total - a.total);
  }

  /**
   * 특정 에이전트의 교정률이 임계치를 초과하는지 확인.
   * 임계치 초과 시 → 해당 에이전트의 SOUL.md 개선 제안을 트리거할 수 있음.
   *
   * @param {string} agentId
   * @param {number} threshold - 교정률 임계치 (0~1, 기본 0.2 = 20%)
   * @returns {{ alert: boolean, correctionRate: number, message?: string }}
   */
  checkAgentHealth(agentId, threshold = 0.2) {
    const stat = this._stats.get(agentId);
    if (!stat || stat.total < 10) {
      return { alert: false, correctionRate: 0 }; // 데이터 부족
    }

    const correctionRate = stat.corrections / stat.total;
    if (correctionRate > threshold) {
      return {
        alert: true,
        correctionRate,
        message: `Agent '${agentId}'의 교정률이 ${(correctionRate * 100).toFixed(1)}%로 임계치(${threshold * 100}%)를 초과했습니다. SOUL.md 또는 AGENTS.md 점검이 필요합니다.`,
      };
    }

    return { alert: false, correctionRate };
  }

  /**
   * 통계 초기화 (테스트용 또는 주기적 리셋).
   */
  reset() {
    this._stats.clear();
  }

  /**
   * 현재 통계를 직렬화 (로그 또는 리포트용).
   */
  toJSON() {
    const obj = {};
    for (const [agentId, stat] of this._stats) {
      obj[agentId] = { ...stat };
    }
    return obj;
  }
}

module.exports = { OutcomeTracker };
