/**
 * search.js — Hybrid Memory Search Engine (v4 Port).
 *
 * FTS5 keyword match + importance scoring re-ranking.
 * Phase 2: + vector embeddings (LanceDB or pgvector).
 *
 * v3.5 통합: memories_fts (그래프) + 기존 semantic_fts (풀 기반) 모두 검색 가능.
 *
 * CM-1 refactor: 공통 row mapper 추출, advancedSearch → search 위임.
 */
const { getDb } = require('../db');
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:search');

// CM-1: 공통 row mapper — 6개 메서드에서 반복되던 패턴 통합
function _mapRow(row) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    importance: parseFloat((row.importance || 0).toFixed(3)),
    sourceChannel: row.source_channel,
    sourceUser: row.source_user,
    createdAt: row.created_at,
    accessCount: row.access_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  };
}

// CM-2: 공통 필터 빌더 — search/advancedSearch에서 반복되던 WHERE 절 조립
function _appendFilters(sql, params, { types, sourceChannel, sourceUser, minImportance = 0, createdAfter, prefix = 'm.' } = {}) {
  if (types && types.length > 0) {
    const ph = types.map(() => '?').join(',');
    sql += ` AND ${prefix}type IN (${ph})`;
    params.push(...types);
  }
  if (sourceChannel) {
    sql += ` AND ${prefix}source_channel = ?`;
    params.push(sourceChannel);
  }
  if (sourceUser) {
    sql += ` AND ${prefix}source_user = ?`;
    params.push(sourceUser);
  }
  if (minImportance > 0) {
    sql += ` AND ${prefix}importance >= ?`;
    params.push(minImportance);
  }
  if (createdAfter) {
    sql += ` AND ${prefix}created_at >= ?`;
    params.push(createdAfter);
  }
  return sql;
}

class MemorySearch {
  /**
   * 하이브리드 검색 (FTS5 + importance re-ranking).
   *
   * @param {string} query - Search query
   * @param {Object} [opts]
   * @param {Array<string>} [opts.types] - Filter by memory types
   * @param {string} [opts.sourceChannel] - Filter by channel
   * @param {string} [opts.sourceUser] - Filter by user
   * @param {number} [opts.limit=10]
   * @param {number} [opts.minImportance=0]
   * @param {string} [opts.createdAfter] - datetime 이후 필터
   * @returns {Object} { results, searchTime }
   */
  async search(query, { types, sourceChannel, sourceUser, limit = 10, minImportance = 0, createdAfter } = {}) {
    const db = getDb();
    const startTime = Date.now();

    try {
      if (!query || query.trim().length === 0) {
        return { results: [], searchTime: 0 };
      }

      const { words, query: safeQuery } = sanitizeFtsQuery(query);
      if (words.length === 0) {
        log.warn('Query empty after sanitization', { originalQuery: query });
        return { results: [], searchTime: 0 };
      }

      // FTS5 검색 + importance re-ranking
      let sql = `
        SELECT m.*, mf.rank
        FROM memories_fts mf
        INNER JOIN memories m ON m.id = mf.rowid
        WHERE memories_fts MATCH ?
          AND m.archived = 0
      `;
      const params = [safeQuery];

      // CM-2: 공통 필터 빌더 사용
      sql = _appendFilters(sql, params, { types, sourceChannel, sourceUser, minImportance, createdAfter });

      // Re-rank: BM25 rank (negative, lower = better) + importance
      sql += ' ORDER BY (mf.rank * -0.5 + m.importance * 0.5) DESC LIMIT ?';
      params.push(limit);

      const rows = await db.prepare(sql).all(...params);
      const results = rows.map(_mapRow);

      const searchTime = Date.now() - startTime;
      log.info('Search completed', { query: safeQuery, results: results.length, searchTime });
      return { results, searchTime };
    } catch (err) {
      log.error('Search failed', { error: err.message, query });
      // 빈 FTS 테이블 등의 경우 빈 결과 반환 (throw하지 않음)
      return { results: [], searchTime: Date.now() - startTime };
    }
  }

  /**
   * 결정사항 전용 검색.
   * @param {string} query
   * @param {Object} [opts]
   * @param {string} [opts.channel]
   * @param {number} [opts.limit=10]
   * @returns {Array<Object>}
   */
  async searchDecisions(query, { channel, limit = 10 } = {}) {
    try {
      const { results } = await this.search(query, {
        types: ['decision'],
        sourceChannel: channel,
        limit,
        minImportance: 0.3,
      });
      return results;
    } catch (err) {
      log.error('Decision search failed', { error: err.message, query });
      return [];
    }
  }

  /**
   * 유저 관련 메모리 조회 (identity, preference, observation).
   * @param {string} userId
   * @param {Object} [opts]
   * @param {number} [opts.limit=20]
   * @returns {Array<Object>}
   */
  getUserMemories(userId, { limit = 20 } = {}) {
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE source_user = ?
          AND type IN ('identity', 'preference', 'observation')
          AND archived = 0
        ORDER BY importance DESC, created_at DESC
        LIMIT ?
      `).all(userId, limit);

      return rows.map(_mapRow);
    } catch (err) {
      log.error('Failed to get user memories', { error: err.message, userId });
      return [];
    }
  }

  /**
   * 채널 컨텍스트 조회 (결정사항 + 최근 사실).
   * @param {string} channelId
   * @param {Object} [opts]
   * @param {number} [opts.limit=15]
   * @returns {Array<Object>}
   */
  getChannelContext(channelId, { limit = 15 } = {}) {
    const db = getDb();
    try {
      // BUG-2 fix: SELECT * 로 변경 — _mapRow가 참조하는 모든 컬럼 포함
      const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE source_channel = ?
          AND type IN ('decision', 'fact')
          AND archived = 0
        ORDER BY
          CASE WHEN type = 'decision' THEN 0 ELSE 1 END,
          importance DESC,
          created_at DESC
        LIMIT ?
      `).all(channelId, limit);

      return rows.map(_mapRow);
    } catch (err) {
      log.error('Failed to get channel context', { error: err.message, channelId });
      return [];
    }
  }

  /**
   * 고급 검색: 복합 조건 AND 결합.
   * CM-3 refactor: search() 위임 가능한 경우 위임, query 없는 경우만 독자 실행.
   * @param {Object} criteria
   * @returns {Array<Object>}
   */
  async advancedSearch(criteria = {}) {
    const { query, types, sourceChannel, sourceUser, minImportance = 0, createdAfter, limit = 20 } = criteria;

    // query가 있으면 search()에 위임 — FTS re-ranking 일관성 보장
    if (query) {
      const { results } = this.search(query, { types, sourceChannel, sourceUser, minImportance, createdAfter, limit });
      return results;
    }

    // query 없는 순수 필터 검색
    const db = getDb();
    try {
      let sql = 'SELECT * FROM memories WHERE archived = 0';
      const params = [];

      sql = _appendFilters(sql, params, { types, sourceChannel, sourceUser, minImportance, createdAfter, prefix: '' });
      sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
      params.push(limit);

      const rows = await db.prepare(sql).all(...params);
      return rows.map(_mapRow);
    } catch (err) {
      log.error('Advanced search failed', { error: err.message });
      return [];
    }
  }

  /**
   * 인기 메모리 조회 (최근 N일).
   * @param {Object} [opts]
   * @param {number} [opts.days=7]
   * @param {number} [opts.limit=10]
   * @returns {Array<Object>}
   */
  getPopularMemories({ days = 7, limit = 10 } = {}) {
    // SEC-W-3 fix: SQL concat injection 방지 — autoArchive와 동일 패턴
    days = Math.max(1, Math.floor(Number(days) || 7));
    limit = Math.max(1, Math.floor(Number(limit) || 10));

    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT *
        FROM memories
        WHERE created_at >= datetime('now', '-' || ? || ' days')
          AND archived = 0
        ORDER BY (importance * 0.5 + CAST(access_count AS REAL) / 10 * 0.5) DESC
        LIMIT ?
      `).all(days, limit);

      return rows.map(_mapRow);
    } catch (err) {
      log.error('Failed to get popular memories', { error: err.message });
      return [];
    }
  }
}

module.exports = { MemorySearch };
