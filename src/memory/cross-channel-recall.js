/**
 * cross-channel-recall.js — 크로스-채널 리콜 (SpaceBot 차용).
 *
 * 다른 채널에서 다른 유저가 논의한 내용을 참조.
 * 기존 context.js의 getUserCrossChannelHistory()는 같은 유저만.
 * 이 모듈은 모든 채널의 결정사항/이벤트/사실을 검색 가능.
 */
const { getDb } = require('../db/sqlite');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:cross-channel');

class CrossChannelRecall {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxResults=20]
   * @param {number} [opts.maxChannels=5]
   */
  constructor(opts = {}) {
    this.maxResults = opts.maxResults || 20;
    this.maxChannels = opts.maxChannels || 5;
  }

  /**
   * 전체 채널의 최근 결정사항 검색.
   * @param {Object} [opts]
   * @param {string} [opts.excludeChannel] - 현재 채널 제외
   * @param {number} [opts.limit=10]
   * @param {string} [opts.since] - datetime 이후
   * @returns {Array}
   */
  getRecentDecisions({ excludeChannel, limit = 10, since } = {}) {
    const db = getDb();
    try {
      let sql = `
        SELECT m.*, e.source_id, e.target_id, e.relation
        FROM memories m
        LEFT JOIN memory_edges e ON e.source_id = m.id
        WHERE m.type = 'decision' AND m.archived = 0
      `;
      const params = [];

      if (excludeChannel) {
        sql += ' AND m.source_channel != ?';
        params.push(excludeChannel);
      }
      if (since) {
        sql += ' AND m.created_at >= ?';
        params.push(since);
      }

      sql += ' ORDER BY m.importance DESC, m.created_at DESC LIMIT ?';
      params.push(limit);

      return db.prepare(sql).all(...params).map(row => ({
        id: row.id,
        type: row.type,
        content: row.content,
        channel: row.source_channel,
        user: row.source_user,
        importance: row.importance,
        createdAt: row.created_at,
      }));
    } catch (err) {
      log.error('Cross-channel decision recall failed', { error: err.message });
      return [];
    }
  }

  /**
   * 키워드 기반 크로스-채널 검색.
   * @param {string} query
   * @param {Object} [opts]
   * @param {string} [opts.excludeChannel]
   * @param {string[]} [opts.types=['fact','decision','event','observation']]
   * @param {number} [opts.limit=10]
   * @returns {Array}
   */
  search(query, { excludeChannel, types = ['fact', 'decision', 'event', 'observation'], limit = 10 } = {}) {
    const db = getDb();
    try {
      const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
      const { words, query: safeQuery } = sanitizeFtsQuery(query);
      if (words.length === 0) return [];

      const typePlaceholders = types.map(() => '?').join(',');
      let sql = `
        SELECT m.*, mf.rank
        FROM memories_fts mf
        INNER JOIN memories m ON m.id = mf.rowid
        WHERE memories_fts MATCH ?
          AND m.archived = 0
          AND m.type IN (${typePlaceholders})
      `;
      const params = [safeQuery, ...types];

      if (excludeChannel) {
        sql += ' AND m.source_channel != ?';
        params.push(excludeChannel);
      }

      sql += ' ORDER BY (mf.rank * -0.4 + m.importance * 0.6) DESC LIMIT ?';
      params.push(limit);

      return db.prepare(sql).all(...params).map(row => ({
        id: row.id,
        type: row.type,
        content: row.content,
        channel: row.source_channel,
        user: row.source_user,
        importance: row.importance,
        createdAt: row.created_at,
        relevance: Math.abs(row.rank || 0),
      }));
    } catch (err) {
      log.error('Cross-channel search failed', { error: err.message, query });
      return [];
    }
  }

  /**
   * 채널별 활동 요약 (Cortex용).
   * @param {number} [hoursBack=24]
   * @returns {Array<{ channel: string, memoryCount: number, topTypes: Object, recentDecisions: Array }>}
   */
  getChannelActivity(hoursBack = 24) {
    const db = getDb();
    try {
      const since = new Date(Date.now() - hoursBack * 3600000).toISOString();
      const rows = db.prepare(`
        SELECT source_channel, type, COUNT(*) as cnt
        FROM memories
        WHERE created_at >= ? AND archived = 0 AND source_channel != ''
        GROUP BY source_channel, type
        ORDER BY source_channel, cnt DESC
      `).all(since);

      const channels = {};
      for (const row of rows) {
        if (!channels[row.source_channel]) {
          channels[row.source_channel] = { channel: row.source_channel, memoryCount: 0, topTypes: {} };
        }
        channels[row.source_channel].memoryCount += row.cnt;
        channels[row.source_channel].topTypes[row.type] = row.cnt;
      }

      return Object.values(channels)
        .sort((a, b) => b.memoryCount - a.memoryCount)
        .slice(0, this.maxChannels);
    } catch (err) {
      log.error('Channel activity query failed', { error: err.message });
      return [];
    }
  }
}

module.exports = { CrossChannelRecall };
