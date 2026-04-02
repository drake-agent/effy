/**
 * graph.js — Typed Memory Graph (v4 Port).
 *
 * 8 Memory Types: fact, preference, decision, identity, event, observation, goal, todo
 * 5 Edge Types: related_to, updates, contradicts, caused_by, part_of
 *
 * Importance scoring:
 *   score = (accessFreq * 0.3) + (recency * 0.3) + (graphCentrality * 0.2) + (baseImportance * 0.2)
 *
 * v3.5 통합: 기존 semantic_memory 시스템과 공존.
 * memories 테이블은 그래프 전용, semantic_memory는 pool 기반 검색용.
 */
const { getDb } = require('../db');
const { contentHash } = require('../shared/utils');
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:graph');

const MEMORY_TYPES = ['fact', 'preference', 'decision', 'identity', 'event', 'observation', 'goal', 'todo'];
const EDGE_TYPES = ['related_to', 'updates', 'contradicts', 'caused_by', 'part_of'];

// R3-DUP-1 fix: 공통 row mapper — get(), getByType(), getLinked()에서 반복되던 패턴 통합
function _mapGraphRow(row) {
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : {} };
}

class MemoryGraph {
  constructor() {
    // DB는 이미 sqlite.js에서 초기화됨 — 테이블은 createTables()에서 생성
  }

  /**
   * 메모리 노드 생성.
   * @param {Object} opts
   * @param {string} opts.type - Memory type
   * @param {string} opts.content - Memory content
   * @param {string} [opts.sourceChannel] - Source channel ID
   * @param {string} [opts.sourceUser] - Source user ID
   * @param {number} [opts.importance=0.5] - Base importance (0-1)
   * @param {Object} [opts.metadata] - Additional metadata
   * @returns {number|null} Inserted memory ID
   */
  async create({ type, content, sourceChannel, sourceUser, importance = 0.5, metadata = {} }) {
    if (!MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}`);
    }

    const db = getDb();
    const hash = contentHash(content);

    try {
      const stmt = db.prepare(`
        INSERT INTO memories (
          type, content, content_hash, source_channel, source_user,
          importance, base_importance, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const result = await stmt.run(
        type, content, hash,
        sourceChannel || '', sourceUser || '',
        importance, importance,
        JSON.stringify(metadata)
      );

      const memoryId = result.lastInsertRowid;
      log.info('Memory created', { id: memoryId, type, sourceChannel });
      return memoryId;
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        log.debug('Memory already exists (duplicate hash)', { type, hash });
        const existing = await db.prepare('SELECT id FROM memories WHERE content_hash = ?').get(hash);
        return existing ? existing.id : null;
      }
      log.error('Failed to create memory', { error: err.message, type });
      throw err;
    }
  }

  /**
   * 모순 검출 + 메모리 생성.
   * 기존 동일 타입 메모리와 모순되는 경우 contradicts 엣지 자동 생성.
   * @param {Object} opts - create()와 동일 파라미터
   * @param {Object} [contradictionOpts]
   * @param {boolean} [contradictionOpts.archiveOld=false] - 구 메모리 아카이브 여부
   * @param {number} [contradictionOpts.similarityThreshold=0.7] - FTS 유사도 임계값
   * @returns {{ memoryId: number, contradictions: Array<{id: number, content: string}> }}
   */
  createWithContradictionCheck(opts, contradictionOpts = {}) {
    const { archiveOld = false, similarityThreshold = 0.7 } = contradictionOpts;
    const db = getDb();

    // 1. 동일 타입 + 동일 소스의 기존 메모리에서 유사 콘텐츠 검색 (사용자별 격리)
    const contradictions = [];
    const userClause = opts.sourceUser ? ' AND m.source_user = ?' : '';
    const userParams = opts.sourceUser ? [opts.sourceUser] : [];
    try {
      const { words, query: safeQuery } = sanitizeFtsQuery(opts.content);
      let existing = [];
      if (safeQuery) {
        existing = db.prepare(`
          SELECT m.id, m.content, m.importance, mf.rank
          FROM memories_fts mf
          INNER JOIN memories m ON m.id = mf.rowid
          WHERE memories_fts MATCH ?
            AND m.type = ?
            AND m.archived = 0${userClause}
          ORDER BY mf.rank
          LIMIT 5
        `).all(safeQuery, opts.type, ...userParams);
      } else {
        // FTS 쿼리 실패 시 기본 검색
        existing = db.prepare(`
          SELECT m.id, m.content, m.importance
          FROM memories m
          WHERE m.type = ? AND m.archived = 0${userClause}
          ORDER BY m.importance DESC
          LIMIT 5
        `).all(opts.type, ...userParams);
      }

      for (const row of existing) {
        // FTS rank가 충분히 높으면 (더 negative = 더 관련) 모순 후보
        if (row.rank === undefined || Math.abs(row.rank || 0) >= similarityThreshold) {
          contradictions.push({ id: row.id, content: row.content });
        }
      }
    } catch (err) {
      log.debug('Contradiction check skipped', { error: err.message });
    }

    // 2. 새 메모리 생성
    const memoryId = this.create(opts);

    // 3. 모순 엣지 생성
    if (memoryId && contradictions.length > 0) {
      for (const old of contradictions) {
        try {
          this.link(memoryId, old.id, 'contradicts', {
            reason: 'auto-detected',
            detectedAt: new Date().toISOString(),
          });

          if (archiveOld) {
            db.prepare('UPDATE memories SET archived = 1, importance = importance * 0.5 WHERE id = ?').run(old.id);
            log.info('Contradicted memory archived', { oldId: old.id, newId: memoryId });
          }
        } catch (linkErr) {
          log.warn('Failed to link contradiction', { error: linkErr.message });
        }
      }
      log.info('Contradictions detected', { newId: memoryId, count: contradictions.length });
    }

    return { memoryId, contradictions };
  }

  /**
   * 메모리 노드 조회.
   * @param {number} id
   * @returns {Object|null}
   */
  async get(id) {
    const db = getDb();
    try {
      const row = await db.prepare('SELECT * FROM memories WHERE id = ? AND archived = 0').get(id);
      if (!row) return null;
      return _mapGraphRow(row);
    } catch (err) {
      log.error('Failed to get memory', { error: err.message, id });
      throw err;
    }
  }

  /**
   * 타입별 메모리 조회.
   * @param {string} type
   * @param {Object} [opts]
   * @param {number} [opts.limit=50]
   * @param {boolean} [opts.archived=false]
   * @param {number} [opts.minImportance=0]
   * @returns {Array<Object>}
   */
  async getByType(type, { limit = 50, archived = false, minImportance = 0, sourceUser } = {}) {
    if (!MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}`);
    }

    const db = getDb();
    try {
      let query = 'SELECT * FROM memories WHERE type = ? AND archived = ?';
      const params = [type, archived ? 1 : 0];

      // 사용자별 격리: sourceUser가 지정되면 해당 유저의 메모리만 반환
      if (sourceUser) {
        query += ' AND source_user = ?';
        params.push(sourceUser);
      }

      if (minImportance > 0) {
        query += ' AND importance >= ?';
        params.push(minImportance);
      }

      query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
      params.push(limit);

      const rows = await db.prepare(query).all(...params);
      return rows.map(_mapGraphRow);
    } catch (err) {
      log.error('Failed to get memories by type', { error: err.message, type });
      throw err;
    }
  }

  /**
   * Edge 생성 (upsert — 중복 시 weight 증가).
   * @param {number} sourceId
   * @param {number} targetId
   * @param {string} relation
   * @param {Object} [metadata]
   */
  link(sourceId, targetId, relation, metadata = {}) {
    if (!EDGE_TYPES.includes(relation)) {
      throw new Error(`Invalid edge type: ${relation}`);
    }
    if (sourceId === targetId) {
      throw new Error('Cannot create self-loop');
    }

    const db = getDb();
    try {
      // MD-1 fix: ON CONFLICT 원자적 upsert — race condition 방지
      db.prepare(`
        INSERT INTO memory_edges (source_id, target_id, relation, metadata)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(source_id, target_id, relation)
        DO UPDATE SET weight = weight + 1, updated_at = datetime('now')
      `).run(sourceId, targetId, relation, JSON.stringify(metadata));
      log.debug('Edge upserted', { sourceId, targetId, relation });
    } catch (err) {
      log.error('Failed to create edge', { error: err.message, sourceId, targetId, relation });
      throw err;
    }
  }

  /**
   * 특정 노드의 연결된 메모리 조회.
   * @param {number} memoryId
   * @param {Object} [opts]
   * @param {string} [opts.relation]
   * @param {string} [opts.direction='both']
   * @param {number} [opts.limit=20]
   * @returns {Array<Object>}
   */
  async getLinked(memoryId, { relation, direction = 'both', limit = 20, sourceUser } = {}) {
    const db = getDb();
    try {
      let query;
      let params;

      // 사용자별 격리: sourceUser가 지정되면 해당 유저의 메모리만 반환
      const userClause = sourceUser ? ' AND m.source_user = ?' : '';
      const userParams = sourceUser ? [sourceUser] : [];

      if (direction === 'outgoing') {
        query = `
          SELECT m.*, me.relation, me.weight
          FROM memories m
          INNER JOIN memory_edges me ON me.source_id = ? AND m.id = me.target_id
          WHERE m.archived = 0${userClause}
        `;
        params = [memoryId, ...userParams];
      } else if (direction === 'incoming') {
        query = `
          SELECT m.*, me.relation, me.weight
          FROM memories m
          INNER JOIN memory_edges me ON me.target_id = ? AND m.id = me.source_id
          WHERE m.archived = 0${userClause}
        `;
        params = [memoryId, ...userParams];
      } else {
        // PERF-1: UNION ALL로 분리 — OR 조건의 인덱스 비효율 방지
        query = `
          SELECT m.*, me.relation, me.weight FROM memories m
          INNER JOIN memory_edges me ON me.source_id = ? AND m.id = me.target_id
          WHERE m.archived = 0${userClause}
          UNION ALL
          SELECT m.*, me.relation, me.weight FROM memories m
          INNER JOIN memory_edges me ON me.target_id = ? AND m.id = me.source_id
          WHERE m.archived = 0${userClause}
        `;
        params = [memoryId, ...userParams, memoryId, ...userParams];
      }

      // PERF-1: UNION ALL 결과를 서브쿼리로 래핑하여 필터/정렬 적용
      let outerSql = `SELECT * FROM (${query}) AS linked`;
      if (relation) {
        outerSql += ' WHERE linked.relation = ?';
        params.push(relation);
      }
      outerSql += ' ORDER BY linked.weight DESC LIMIT ?';
      params.push(limit);

      const rows = await db.prepare(outerSql).all(...params);
      return rows.map(_mapGraphRow);
    } catch (err) {
      log.error('Failed to get linked memories', { error: err.message, memoryId });
      throw err;
    }
  }

  /**
   * 중요도 점수 재계산.
   * score = (accessFreq * 0.3) + (recency * 0.3) + (graphCentrality * 0.2) + (baseImportance * 0.2)
   * @param {number} memoryId
   * @returns {number}
   */
  async recalculateImportance(memoryId) {
    const db = getDb();
    try {
      const memory = await this.get(memoryId);
      if (!memory) throw new Error(`Memory ${memoryId} not found`);

      // Access frequency (0-1, capped at 10)
      const accessFreq = Math.min(memory.access_count / 10, 1.0);

      // Recency (0-1, decay over 30 days)
      // NaN-1 fix: SQLite datetime 형식 'YYYY-MM-DD HH:MM:SS' → ISO 호환 변환
      const rawDate = memory.created_at || '';
      const isoDate = rawDate.includes('T') ? rawDate : rawDate.replace(' ', 'T') + 'Z';
      const createdAtMs = new Date(isoDate).getTime();
      const now = Date.now();
      const ageSeconds = (Number.isFinite(createdAtMs) ? (now - createdAtMs) : Infinity) / 1000;
      const recency = Number.isFinite(ageSeconds) ? Math.max(0, 1 - ageSeconds / (30 * 24 * 60 * 60)) : 0;

      // Graph centrality (edges normalized)
      const edgeCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM memory_edges WHERE source_id = ? OR target_id = ?'
      ).get(memoryId, memoryId);
      const graphCentrality = Math.min(edgeCount.cnt / 20, 1.0);

      const newImportance =
        (accessFreq * 0.3) +
        (recency * 0.3) +
        (graphCentrality * 0.2) +
        ((memory.base_importance || 0.5) * 0.2);

      db.prepare("UPDATE memories SET importance = ?, updated_at = datetime('now') WHERE id = ?")
        .run(newImportance, memoryId);

      log.debug('Importance recalculated', { memoryId, newImportance: parseFloat(newImportance.toFixed(3)) });
      return newImportance;
    } catch (err) {
      log.error('Failed to recalculate importance', { error: err.message, memoryId });
      throw err;
    }
  }

  /**
   * Access count + last_accessed 업데이트.
   * @param {Array<number>} ids
   */
  touch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const db = getDb();
    try {
      // MD-2 fix: transaction 래핑으로 batch UPDATE
      // BUG-101 fix: better-sqlite3 transaction은 동기 — async 콜백 불필요
      const stmt = db.prepare(
        "UPDATE memories SET access_count = access_count + 1, last_accessed = datetime('now') WHERE id = ?"
      );
      const touchAll = db.transaction((idList) => {
        for (const id of idList) stmt.run(id);
      });
      touchAll(ids);
    } catch (err) {
      log.error('Failed to touch memories', { error: err.message });
    }
  }

  /**
   * 아카이브 (소프트 삭제).
   * @param {number} id
   */
  async archive(id) {
    const db = getDb();
    try {
      await db.prepare("UPDATE memories SET archived = 1, updated_at = datetime('now') WHERE id = ?").run(id);
      log.info('Memory archived', { id });
    } catch (err) {
      log.error('Failed to archive memory', { error: err.message, id });
      throw err;
    }
  }

  /**
   * 오래된/접근 안 된 메모리 자동 아카이브.
   * decision 타입은 제외.
   * @param {Object} [opts]
   * @param {number} [opts.maxAgeDays=90]
   * @param {number} [opts.minAccessCount=0]
   * @returns {number} 아카이브된 수
   */
  async autoArchive({ maxAgeDays = 90, minAccessCount = 0 } = {}) {
    // SEC-W-1 fix: 타입 강제 — SQL injection 방지
    maxAgeDays = Math.max(1, Math.floor(Number(maxAgeDays) || 90));
    minAccessCount = Math.max(0, Math.floor(Number(minAccessCount) || 0));

    const db = getDb();
    try {
      const stmt = db.prepare(`
        UPDATE memories
        SET archived = 1, updated_at = datetime('now')
        WHERE type != 'decision'
          AND archived = 0
          AND created_at < datetime('now', '-' || ? || ' days')
          AND access_count <= ?
      `);
      const result = await stmt.run(maxAgeDays, minAccessCount);
      log.info('Auto-archive completed', { count: result.changes, maxAgeDays });
      return result.changes;
    } catch (err) {
      log.error('Failed to auto-archive', { error: err.message });
      throw err;
    }
  }

  /**
   * 모순 감지: 같은 타입 내에서 유사 content 탐지.
   * @param {string} type
   * @param {string} content
   * @returns {Array<Object>}
   */
  findPotentialContradictions(type, content, { sourceUser } = {}) {
    if (!MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}`);
    }

    const db = getDb();
    try {
      // HI-2 fix: FTS5로 1차 필터링 후 유사도 비교 — O(N) 전수 검색 방지
      let candidates;
      const { words, query: safeQuery } = sanitizeFtsQuery(content);

      // 사용자별 격리: sourceUser가 지정되면 해당 유저의 메모리만 검색
      const userClause = sourceUser ? ' AND m.source_user = ?' : '';
      const userParams = sourceUser ? [sourceUser] : [];

      if (safeQuery) {
        candidates = db.prepare(`
          SELECT m.id, m.content FROM memories m
          INNER JOIN memories_fts mf ON m.id = mf.rowid
          WHERE memories_fts MATCH ? AND m.type = ? AND m.archived = 0${userClause}
          ORDER BY m.importance DESC LIMIT 50
        `).all(safeQuery, type, ...userParams);
      } else {
        candidates = db.prepare(
          `SELECT id, content FROM memories WHERE type = ? AND archived = 0${userClause} ORDER BY importance DESC LIMIT 50`
        ).all(type, ...userParams);
      }

      const newWords = new Set(content.toLowerCase().split(/\s+/));
      const threshold = 0.5;
      const results = [];

      for (const candidate of candidates) {
        const candidateWords = new Set(candidate.content.toLowerCase().split(/\s+/));
        const overlap = new Set([...newWords].filter(w => candidateWords.has(w)));
        const similarity = overlap.size / Math.max(newWords.size, candidateWords.size);

        if (similarity >= threshold && candidate.content !== content) {
          results.push({
            id: candidate.id,
            content: candidate.content,
            similarity: parseFloat(similarity.toFixed(2)),
          });
        }
      }

      log.debug('Contradiction check', { type, candidates: candidates.length, found: results.length });
      return results;
    } catch (err) {
      log.error('Failed to find contradictions', { error: err.message });
      throw err;
    }
  }

  /**
   * 그래프 통계.
   * @returns {Object}
   */
  async getStats() {
    const db = getDb();
    try {
      const totalNodes = await db.prepare('SELECT COUNT(*) as cnt FROM memories WHERE archived = 0').get();
      const totalEdges = await db.prepare('SELECT COUNT(*) as cnt FROM memory_edges').get();

      const byType = {};
      for (const row of await db.prepare('SELECT type, COUNT(*) as cnt FROM memories WHERE archived = 0 GROUP BY type').all()) {
        byType[row.type] = row.cnt;
      }

      const byRelation = {};
      for (const row of await db.prepare('SELECT relation, COUNT(*) as cnt FROM memory_edges GROUP BY relation').all()) {
        byRelation[row.relation] = row.cnt;
      }

      return {
        totalNodes: totalNodes.cnt,
        totalEdges: totalEdges.cnt,
        byType,
        byRelation,
      };
    } catch (err) {
      log.error('Failed to get stats', { error: err.message });
      return { totalNodes: 0, totalEdges: 0, byType: {}, byRelation: {} };
    }
  }
}

module.exports = { MemoryGraph, MEMORY_TYPES, EDGE_TYPES };
