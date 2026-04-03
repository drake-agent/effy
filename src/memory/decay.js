/**
 * memory/decay.js — 메모리 감쇠 및 프루닝 (Memory Decay/Pruning)
 *
 * 자동 메모리 유지:
 * - 중요도 점수 계산 (접근 빈도 + 최근성 + 그래프 중심도)
 * - 임계값(minImportance) 미만 메모리 자동 삭제
 * - 주기적 decay pass (24시간 기본값)
 *
 * 중요도 = recencyWeight * recency
 *        + frequencyWeight * frequency
 *        + centralityWeight * centrality
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('memory:decay');

class MemoryDecay {
  constructor(opts = {}) {
    /** @type {number} decay 실행 주기 (ms) */
    this.decayIntervalMs = opts.decayIntervalMs ?? 86400000; // 24 hours

    /** @type {number} 프루닝 임계값 (이하는 삭제) */
    this.minImportance = opts.minImportance ?? 0.1;

    /** @type {number} 최근성 가중치 (0.0 ~ 1.0) */
    this.recencyWeight = opts.recencyWeight ?? 0.4;

    /** @type {number} 접근 빈도 가중치 */
    this.frequencyWeight = opts.frequencyWeight ?? 0.3;

    /** @type {number} 그래프 중심도 가중치 */
    this.centralityWeight = opts.centralityWeight ?? 0.3;

    /** @type {NodeJS.Timeout|null} auto-decay 타이머 */
    this._timer = null;

    // 가중치 정규화 검증
    const totalWeight = this.recencyWeight + this.frequencyWeight + this.centralityWeight;
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      log.warn('Weights do not sum to 1.0, normalizing', { totalWeight });
      const factor = 1.0 / totalWeight;
      this.recencyWeight *= factor;
      this.frequencyWeight *= factor;
      this.centralityWeight *= factor;
    }
  }

  /**
   * 메모리 노드 중요도 점수 계산
   *
   * @param {Object} node - { id, type, createdAt, lastAccessedAt, accessCount, edgeCount }
   * @returns {{ score: number, components: { recency, frequency, centrality } }}
   */
  calculateImportance(node) {
    const now = Date.now();

    // 1. 최근성 (0 ~ 1): 최근 접근일수록 높음
    const ageMs = now - (node.lastAccessedAt || node.createdAt || now);
    const ageDay = ageMs / (24 * 60 * 60 * 1000);
    const recency = Math.max(0, 1 - Math.min(1, ageDay / 30)); // 30일 이상은 0

    // 2. 접근 빈도 (0 ~ 1): 접근 횟수에 지수 감쇠 적용
    const accessCount = node.accessCount || 0;
    const frequency = Math.min(1, accessCount / 100); // 100회를 1.0으로 정규화

    // 3. 그래프 중심도 (0 ~ 1): 엣지 수에 따른 중요도
    // 많은 연결 = 높은 중심도
    const edgeCount = node.edgeCount || 0;
    const centrality = Math.min(1, edgeCount / 50); // 50개 엣지를 1.0으로

    const score =
      this.recencyWeight * recency +
      this.frequencyWeight * frequency +
      this.centralityWeight * centrality;

    return {
      score,
      components: { recency, frequency, centrality },
    };
  }

  /**
   * Decay 패스 실행: 모든 메모리 노드 점수 계산, 낮은 점수 프루닝
   *
   * @param {Object} db - better-sqlite3 instance
   * @param {string} [agentId] - 특정 에이전트로 스코프 (생략 시 전체)
   * @returns {Promise<{ scored: number, pruned: number, preserved: number }>}
   */
  async runDecay(db, agentId = null) {
    try {
      log.info('Starting decay pass', { agentId, minImportance: this.minImportance });
      const startTime = Date.now();

      const batchSize = 500;
      let scored = 0;
      let pruned = 0;
      let preserved = 0;
      let hasMore = true;
      let lastId = 0;

      // Process in batches using keyset pagination to avoid full-table scan
      while (hasMore) {
        let query = 'SELECT id, type, createdAt, lastAccessedAt, accessCount, edgeCount FROM memories WHERE id > ?';
        const params = [lastId];

        if (agentId) {
          query += ' AND agentId = ?';
          params.push(agentId);
        }

        query += ' ORDER BY id ASC LIMIT ?';
        params.push(batchSize);

        const nodes = db.prepare(query).all(...params) || [];
        if (nodes.length < batchSize) hasMore = false;
        if (nodes.length === 0) break;

        lastId = nodes[nodes.length - 1].id;

        // Collect IDs to prune in this batch
        const toPrune = [];
        for (const node of nodes) {
          const { score } = this.calculateImportance(node);
          scored++;

          if (score < this.minImportance) {
            toPrune.push(node.id);
          } else {
            preserved++;
          }
        }

        // Batch delete pruned nodes
        if (toPrune.length > 0) {
          try {
            const placeholders = toPrune.map(() => '?').join(',');
            db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...toPrune);
            pruned += toPrune.length;
            log.debug('Batch pruned nodes', { count: toPrune.length });
          } catch (err) {
            log.error('Failed to batch prune nodes', { error: err.message });
          }
        }
      }

      const elapsedMs = Date.now() - startTime;
      log.info('Decay pass completed', { scored, pruned, preserved, elapsedMs });

      return { scored, pruned, preserved };
    } catch (err) {
      log.error('Decay pass failed', err);
      throw err;
    }
  }

  /**
   * 주기적 자동 decay 시작
   *
   * @param {Object} db - better-sqlite3 instance
   * @param {string[]} [agentIds=[]] - 특정 에이전트만 decay (생략 시 전체)
   */
  startAutoDecay(db, agentIds = []) {
    if (this._timer) {
      log.warn('Auto decay already running');
      return;
    }

    const runDecay = async () => {
      try {
        if (agentIds.length > 0) {
          for (const agentId of agentIds) {
            await this.runDecay(db, agentId);
          }
        } else {
          await this.runDecay(db);
        }
      } catch (err) {
        log.error('Auto decay error', err);
      }
    };

    // 초기 실행 (즉시)
    runDecay();

    // 주기적 실행
    this._timer = setInterval(runDecay, this.decayIntervalMs);
    log.info('Auto decay started', {
      intervalMs: this.decayIntervalMs,
      agentIds: agentIds.length > 0 ? agentIds : 'all',
    });
  }

  /**
   * 자동 decay 중지
   */
  stopAutoDecay() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      log.info('Auto decay stopped');
    }
  }

  /**
   * Decay 통계 조회
   *
   * @param {Object} db - better-sqlite3 instance
   * @param {string} [agentId] - 특정 에이전트
   * @returns {{ totalNodes: number, lowImportance: number, avgScore: number }}
   */
  getStats(db, agentId = null) {
    try {
      // Use COUNT(*) for totalNodes to avoid loading all rows
      let countQuery = 'SELECT COUNT(*) as cnt FROM memories';
      const countParams = [];
      if (agentId) {
        countQuery += ' WHERE agentId = ?';
        countParams.push(agentId);
      }
      const totalNodes = db.prepare(countQuery).get(...countParams)?.cnt || 0;

      // Sample up to 10000 rows for score statistics
      let query = 'SELECT id, type, createdAt, lastAccessedAt, accessCount, edgeCount FROM memories';
      const params = [];
      if (agentId) {
        query += ' WHERE agentId = ?';
        params.push(agentId);
      }
      query += ' LIMIT 10000';

      const nodes = db.prepare(query).all(...params) || [];
      const scores = nodes.map((node) => this.calculateImportance(node).score);

      const lowImportance = scores.filter((s) => s < this.minImportance).length;
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

      return { totalNodes, lowImportance, avgScore };
    } catch (err) {
      log.error('Failed to get decay stats', err);
      return { totalNodes: 0, lowImportance: 0, avgScore: 0 };
    }
  }
}

module.exports = { MemoryDecay };
