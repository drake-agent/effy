/**
 * search-modes.js — 메타데이터 기반 메모리 검색 모드
 * Metadata-Based Memory Search Modes
 *
 * 벡터 임베딩 없이 SQLite 메타데이터로 직접 검색하는 3가지 모드.
 * 타입별, 최신순, 중요도순 검색.
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('memory/search-modes');

/**
 * 메모리 검색 모드 클래스
 * MemorySearchModes — 메타데이터 기반 쿼리
 */
class MemorySearchModes {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.defaultLimit=20] - 기본 결과 개수 제한
   */
  constructor(opts = {}) {
    this.defaultLimit = opts.defaultLimit ?? 20;
  }

  /**
   * 메모리 타입별 검색
   * @param {Object} db - better-sqlite3 인스턴스
   * @param {string} type - 'fact'|'preference'|'decision'|'identity'|'event'|'observation'|'goal'|'todo'
   * @param {Object} [opts]
   * @param {string} [opts.agentId] - 에이전트 ID로 필터링
   * @param {number} [opts.limit=20]
   * @param {number} [opts.offset=0]
   * @returns {Array<Object>}
   */
  searchByType(db, type, opts = {}) {
    try {
      const { agentId, limit = this.defaultLimit, offset = 0 } = opts;

      if (!type) {
        log.warn('searchByType: type is required');
        return [];
      }

      let query = `
        SELECT id, content, memory_type, created_at, access_count, edge_count
        FROM semantic_memory
        WHERE memory_type = ?
      `;
      const params = [type];

      if (agentId) {
        query += ' AND agent_id = ?';
        params.push(agentId);
      }

      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const stmt = db.prepare(query);
      const results = stmt.all(...params);

      log.debug('searchByType executed', {
        type,
        agentId,
        resultsCount: results?.length || 0,
      });

      return results || [];
    } catch (err) {
      log.error('searchByType failed', err);
      return [];
    }
  }

  /**
   * 최신순 검색
   * @param {Object} db
   * @param {Object} [opts]
   * @param {string} [opts.agentId]
   * @param {number} [opts.limit=20]
   * @param {number} [opts.afterTimestamp] - 이 시간 이후의 기록만
   * @param {number} [opts.beforeTimestamp] - 이 시간 이전의 기록만
   * @returns {Array<Object>}
   */
  searchByRecency(db, opts = {}) {
    try {
      const {
        agentId,
        limit = this.defaultLimit,
        afterTimestamp,
        beforeTimestamp,
      } = opts;

      let query = `
        SELECT id, content, memory_type, created_at, access_count, edge_count
        FROM semantic_memory
        WHERE 1=1
      `;
      const params = [];

      if (agentId) {
        query += ' AND agent_id = ?';
        params.push(agentId);
      }

      if (afterTimestamp) {
        query += ' AND created_at >= ?';
        params.push(afterTimestamp);
      }

      if (beforeTimestamp) {
        query += ' AND created_at <= ?';
        params.push(beforeTimestamp);
      }

      query += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const stmt = db.prepare(query);
      const results = stmt.all(...params);

      log.debug('searchByRecency executed', {
        agentId,
        resultsCount: results?.length || 0,
      });

      return results || [];
    } catch (err) {
      log.error('searchByRecency failed', err);
      return [];
    }
  }

  /**
   * 중요도순 검색
   * access_count * edge_count를 중요도 프록시로 사용.
   * @param {Object} db
   * @param {Object} [opts]
   * @param {string} [opts.agentId]
   * @param {number} [opts.limit=20]
   * @param {number} [opts.minImportance=0] - 최소 중요도 임계값
   * @returns {Array<Object>}
   */
  searchByImportance(db, opts = {}) {
    try {
      const {
        agentId,
        limit = this.defaultLimit,
        minImportance = 0,
      } = opts;

      let query = `
        SELECT
          id,
          content,
          memory_type,
          created_at,
          access_count,
          edge_count,
          (COALESCE(access_count, 0) * COALESCE(edge_count, 1)) as importance_score
        FROM semantic_memory
        WHERE 1=1
      `;
      const params = [];

      if (agentId) {
        query += ' AND agent_id = ?';
        params.push(agentId);
      }

      if (minImportance > 0) {
        query += ' AND (COALESCE(access_count, 0) * COALESCE(edge_count, 1)) >= ?';
        params.push(minImportance);
      }

      query += ' ORDER BY importance_score DESC LIMIT ?';
      params.push(limit);

      const stmt = db.prepare(query);
      const results = stmt.all(...params);

      log.debug('searchByImportance executed', {
        agentId,
        minImportance,
        resultsCount: results?.length || 0,
      });

      return results || [];
    } catch (err) {
      log.error('searchByImportance failed', err);
      return [];
    }
  }

  /**
   * 복합 검색: 여러 모드 결과를 병합하고 점수 산정
   * @param {Object} db
   * @param {Object} opts
   * @param {string} [opts.query] - 쿼리 텍스트 (콘텐츠 필터링)
   * @param {string} [opts.type] - 메모리 타입 필터
   * @param {string} [opts.agentId]
   * @param {string[]} [opts.modes=['typed', 'recent', 'important']] - 사용할 검색 모드
   * @param {Object} [opts.weights={ typed: 1.0, recent: 0.8, important: 1.2 }]
   * @returns {Array<Object>} 점수가 산정된 병합 결과
   */
  combinedSearch(db, opts = {}) {
    try {
      const {
        query,
        type,
        agentId,
        modes = ['typed', 'recent', 'important'],
        weights = { typed: 1.0, recent: 0.8, important: 1.2 },
      } = opts;

      const resultMap = new Map(); // id -> { result, score }

      // 타입별 검색
      if (modes.includes('typed') && type) {
        const typed = this.searchByType(db, type, { agentId, limit: 50 });
        typed.forEach((result, index) => {
          const id = result.id;
          const score = (50 - index) * weights.typed;
          if (!resultMap.has(id)) {
            resultMap.set(id, { result, score: 0 });
          }
          resultMap.get(id).score += score;
        });
      }

      // 최신순 검색
      if (modes.includes('recent')) {
        const recent = this.searchByRecency(db, { agentId, limit: 50 });
        recent.forEach((result, index) => {
          const id = result.id;
          const score = (50 - index) * weights.recent;
          if (!resultMap.has(id)) {
            resultMap.set(id, { result, score: 0 });
          }
          resultMap.get(id).score += score;
        });
      }

      // 중요도순 검색
      if (modes.includes('important')) {
        const important = this.searchByImportance(db, { agentId, limit: 50 });
        important.forEach((result, index) => {
          const id = result.id;
          const score = (50 - index) * weights.important;
          if (!resultMap.has(id)) {
            resultMap.set(id, { result, score: 0 });
          }
          resultMap.get(id).score += score;
        });
      }

      // 쿼리 기반 콘텐츠 필터링 (안전하게)
      let merged = Array.from(resultMap.values());
      if (query && typeof query === 'string') {
        // 쿼리 길이 제한 (injection 방지)
        const safeQuery = query.slice(0, 200).toLowerCase();
        // .includes()는 안전 (escape 불필요)
        merged = merged.filter(({ result }) =>
          typeof result.content === 'string' && result.content.toLowerCase().includes(safeQuery)
        );
      }

      // 점수로 정렬
      merged.sort((a, b) => b.score - a.score);

      log.debug('combinedSearch executed', {
        resultCount: merged.length,
        modesUsed: modes.length,
      });

      return merged.map(({ result, score }) => ({
        ...result,
        combinedScore: parseFloat(score.toFixed(2)),
      }));
    } catch (err) {
      log.error('combinedSearch failed', err);
      return [];
    }
  }
}

module.exports = { MemorySearchModes };
