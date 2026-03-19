/**
 * insight-store.js — Layer 2: Insight Storage & Management.
 *
 * PatternDetector가 생성한 insight를 저장하고 관리.
 * TTL 기반 자동 만료, 중복 merge, 상태 추적.
 *
 * MemoryGraph와 통합: actionable insight는 graph에도 기록.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('observer:insights');

class InsightStore {
  /**
   * @param {object} opts
   * @param {object} opts.graph - MemoryGraph 인스턴스 (optional)
   * @param {number} opts.ttlMs - 자동 만료 시간 (기본 24시간)
   * @param {number} opts.maxInsights - 최대 보관 수 (기본 200)
   */
  constructor(opts = {}) {
    this.graph = opts.graph || null;
    this.ttlMs = opts.ttlMs || 24 * 60 * 60 * 1000;
    this.maxInsights = opts.maxInsights || 200;

    this.insights = new Map();  // id → Insight
    this._nextId = 1;
  }

  /**
   * Insight 추가.
   * 동일 채널+타입+유사 content → merge (중복 방지).
   *
   * @param {object} insight - { type, channel, content, confidence, evidence, ... }
   * @returns {object} 저장된 insight (id 포함)
   */
  add(insight) {
    // 중복 체크: 같은 채널 + 같은 타입 + 유사 내용
    const existing = this._findDuplicate(insight);
    if (existing) {
      // Merge: confidence 최대값, evidence 합산
      existing.confidence = Math.max(existing.confidence, insight.confidence);
      existing.evidence = [...new Set([...(existing.evidence || []), ...(insight.evidence || [])])];
      existing.mergeCount = (existing.mergeCount || 1) + 1;
      existing.lastUpdated = Date.now();
      log.debug('Insight merged', { id: existing.id, type: existing.type, merges: existing.mergeCount });
      return existing;
    }

    // 용량 체크
    if (this.insights.size >= this.maxInsights) {
      this._evictOldest();
    }

    const id = `INS-${String(this._nextId++).padStart(5, '0')}`;
    const stored = {
      ...insight,
      id,
      status: 'pending',
      mergeCount: 1,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };

    this.insights.set(id, stored);

    // MemoryGraph에도 기록
    if (this.graph && insight.actionable) {
      try {
        this.graph.create({
          type: 'fact',
          content: `[Insight:${insight.type}] ${insight.content?.slice(0, 200)}`,
          sourceChannel: insight.channel || '',
          importance: insight.confidence || 0.5,
          metadata: {
            source: 'observer',
            insightId: id,
            insightType: insight.type,
          },
        });
      } catch (graphErr) { log.warn('Insight graph save failed', { id, error: graphErr.message }); }
    }

    log.info('Insight created', { id, type: insight.type, channel: insight.channel, confidence: insight.confidence });
    return stored;
  }

  /**
   * Insight 상태 변경.
   */
  updateStatus(id, status) {
    const insight = this.insights.get(id);
    if (!insight) return null;
    insight.status = status;
    insight.lastUpdated = Date.now();
    return insight;
  }

  /**
   * Actionable + pending insights 조회.
   * ProactiveEngine이 처리할 대상.
   */
  getActionable(minConfidence = 0) {
    this._expireOld();
    return [...this.insights.values()]
      .filter(i => i.status === 'pending' && i.actionable && i.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 채널별 insight 조회.
   */
  getByChannel(channelId) {
    this._expireOld();
    return [...this.insights.values()].filter(i => i.channel === channelId);
  }

  /**
   * 전체 통계.
   */
  getStats() {
    this._expireOld();
    const byType = {};
    const byStatus = {};
    for (const i of this.insights.values()) {
      byType[i.type] = (byType[i.type] || 0) + 1;
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    }
    return { total: this.insights.size, byType, byStatus };
  }

  // ─── Internal ────────────────────────────────

  _findDuplicate(insight) {
    for (const existing of this.insights.values()) {
      if (existing.channel !== insight.channel) continue;
      if (existing.type !== insight.type) continue;
      if (existing.status === 'expired') continue;

      // 간단한 유사도: 첫 50자 일치
      const a = (existing.content || '').slice(0, 50).toLowerCase();
      const b = (insight.content || '').slice(0, 50).toLowerCase();
      if (a === b) return existing;
    }
    return null;
  }

  _expireOld() {
    const now = Date.now();
    const expired = [];
    for (const [id, insight] of this.insights) {
      if (now > insight.expiresAt && insight.status === 'pending') {
        insight.status = 'expired';
        expired.push(id);
      }
    }
    for (const id of expired) this.insights.delete(id);
  }

  _evictOldest() {
    // 가장 오래되고 confidence 낮은 것부터 제거
    const sorted = [...this.insights.entries()]
      .sort((a, b) => a[1].createdAt - b[1].createdAt);
    if (sorted.length > 0) {
      this.insights.delete(sorted[0][0]);
    }
  }
}

module.exports = { InsightStore };
