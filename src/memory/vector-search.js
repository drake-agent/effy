/**
 * vector-search.js — 벡터 유사도 검색 + RRF (Reciprocal Rank Fusion).
 *
 * 구현: LanceDB/Tantivy 패턴 기반으로 LanceDB 벡터 + Tantivy FTS를 RRF로 병합.
 * Effy 구현: SQLite FTS5 + in-process 코사인 유사도를 RRF로 병합.
 *
 * Phase 1: 간단한 TF-IDF 기반 벡터화 (외부 의존성 없음)
 * Phase 2: OpenAI/Anthropic embedding API 연동 (TODO)
 *
 * RRF 공식: score(d) = Σ 1 / (k + rank_i(d))  (k=60 default)
 */
const { getDb } = require('../db/sqlite');
const { sanitizeFtsQuery } = require('../shared/fts-sanitizer');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:vector-search');

// ─── TF-IDF 벡터화 (Phase 1: 외부 의존성 없는 경량 구현) ───

/**
 * 간단한 토큰화.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\w\sㄱ-ㅎㅏ-ㅣ가-힣]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

/**
 * TF (Term Frequency) 계산.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) {
    tf.set(token, (tf.get(token) || 0) + 1);
  }
  // 정규화
  const max = Math.max(...tf.values(), 1);
  for (const [k, v] of tf) {
    tf.set(k, v / max);
  }
  return tf;
}

/**
 * 코사인 유사도.
 * @param {Map<string, number>} vecA
 * @param {Map<string, number>} vecB
 * @returns {number} 0.0 ~ 1.0
 */
function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [key, valA] of vecA) {
    dotProduct += valA * (vecB.get(key) || 0);
    normA += valA * valA;
  }
  for (const [, valB] of vecB) {
    normB += valB * valB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dotProduct / denom;
}

// ─── Reciprocal Rank Fusion ───

/**
 * RRF (Reciprocal Rank Fusion) — 여러 랭킹 리스트를 하나로 병합.
 *
 * @param {Array<Array<{id: number, score: number}>>} rankedLists - 랭킹 리스트 배열
 * @param {number} [k=60] - RRF 파라미터 (높을수록 순위 차이 약화)
 * @returns {Array<{id: number, rrfScore: number, ranks: Object}>}
 */
function reciprocalRankFusion(rankedLists, k = 60) {
  const scores = new Map(); // id → { rrfScore, ranks }

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const list = rankedLists[listIdx];
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!scores.has(item.id)) {
        scores.set(item.id, { rrfScore: 0, ranks: {}, data: item });
      }
      const entry = scores.get(item.id);
      entry.rrfScore += 1 / (k + rank + 1);
      entry.ranks[`list_${listIdx}`] = rank + 1;
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .map(entry => ({
      ...entry.data,
      rrfScore: parseFloat(entry.rrfScore.toFixed(6)),
      ranks: entry.ranks,
    }));
}

// ─── HybridSearchEngine ───

class HybridSearchEngine {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.rrfK=60] - RRF 파라미터
   * @param {number} [opts.ftsWeight=0.5] - FTS 결과 가중치
   * @param {number} [opts.vectorWeight=0.5] - 벡터 결과 가중치
   */
  constructor(opts = {}) {
    this.rrfK = opts.rrfK ?? 60;
    this.ftsWeight = opts.ftsWeight ?? 0.5;
    this.vectorWeight = opts.vectorWeight ?? 0.5;
  }

  /**
   * 하이브리드 검색 (FTS5 + 벡터 유사도 + RRF).
   *
   * @param {string} query - 검색 쿼리
   * @param {Object} [opts]
   * @param {Array<string>} [opts.types] - 메모리 타입 필터
   * @param {string} [opts.sourceChannel] - 채널 필터
   * @param {string} [opts.sourceUser] - 유저 필터
   * @param {number} [opts.limit=10]
   * @param {number} [opts.minImportance=0]
   * @returns {{ results: Array, searchTime: number, method: string }}
   */
  search(query, opts = {}) {
    const { types, sourceChannel, sourceUser, limit = 10, minImportance = 0 } = opts;
    const startTime = Date.now();

    if (!query || query.trim().length === 0) {
      return { results: [], searchTime: 0, method: 'none' };
    }

    try {
      // 1. FTS5 검색
      const ftsResults = this._ftsSearch(query, { types, sourceChannel, sourceUser, limit: limit * 2, minImportance });

      // 2. 벡터 유사도 검색
      const vectorResults = this._vectorSearch(query, { types, sourceChannel, sourceUser, limit: limit * 2, minImportance });

      // 3. RRF 병합
      const ftsRanked = ftsResults.map((r, i) => ({ ...r, score: r.ftsScore || 0 }));
      const vectorRanked = vectorResults.map((r, i) => ({ ...r, score: r.similarity || 0 }));

      const merged = reciprocalRankFusion([ftsRanked, vectorRanked], this.rrfK);
      const results = merged.slice(0, limit);

      const searchTime = Date.now() - startTime;
      log.info('Hybrid search completed', {
        query: query.slice(0, 50),
        ftsHits: ftsResults.length,
        vectorHits: vectorResults.length,
        merged: results.length,
        searchTime,
      });

      return { results, searchTime, method: 'hybrid_rrf' };
    } catch (err) {
      log.error('Hybrid search failed', { error: err.message, query });
      return { results: [], searchTime: Date.now() - startTime, method: 'error' };
    }
  }

  /**
   * FTS5 검색 (기존 MemorySearch와 유사).
   * @private
   */
  _ftsSearch(query, { types, sourceChannel, sourceUser, limit, minImportance }) {
    const db = getDb();
    const { words, query: safeQuery } = sanitizeFtsQuery(query);
    if (words.length === 0) return [];

    let sql = `
      SELECT m.*, mf.rank as ftsScore
      FROM memories_fts mf
      INNER JOIN memories m ON m.id = mf.rowid
      WHERE memories_fts MATCH ?
        AND m.archived = 0
    `;
    const params = [safeQuery];

    if (types && types.length > 0) {
      sql += ` AND m.type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    if (sourceChannel) { sql += ' AND m.source_channel = ?'; params.push(sourceChannel); }
    if (sourceUser) { sql += ' AND m.source_user = ?'; params.push(sourceUser); }
    if (minImportance > 0) { sql += ' AND m.importance >= ?'; params.push(minImportance); }

    sql += ' ORDER BY mf.rank LIMIT ?';
    params.push(limit);

    try {
      return db.prepare(sql).all(...params).map(row => ({
        id: row.id,
        type: row.type,
        content: row.content,
        importance: row.importance,
        sourceChannel: row.source_channel,
        sourceUser: row.source_user,
        createdAt: row.created_at,
        ftsScore: Math.abs(row.ftsScore || 0),
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
      }));
    } catch (err) {
      log.debug('FTS search failed', { error: err.message });
      return [];
    }
  }

  /**
   * 벡터 유사도 검색 (TF-IDF 코사인).
   * @private
   */
  _vectorSearch(query, { types, sourceChannel, sourceUser, limit, minImportance }) {
    const db = getDb();
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const queryVec = termFrequency(queryTokens);

    // 후보 로드 (최근 + 중요도 높은 메모리)
    let sql = 'SELECT * FROM memories WHERE archived = 0';
    const params = [];

    if (types && types.length > 0) {
      sql += ` AND type IN (${types.map(() => '?').join(',')})`;
      params.push(...types);
    }
    if (sourceChannel) { sql += ' AND source_channel = ?'; params.push(sourceChannel); }
    if (sourceUser) { sql += ' AND source_user = ?'; params.push(sourceUser); }
    if (minImportance > 0) { sql += ' AND importance >= ?'; params.push(minImportance); }

    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(Math.min(limit * 10, 500)); // 최대 500개 후보

    try {
      const candidates = db.prepare(sql).all(...params);

      // 코사인 유사도 계산
      const scored = candidates.map(row => {
        const docTokens = tokenize(row.content);
        const docVec = termFrequency(docTokens);
        const similarity = cosineSimilarity(queryVec, docVec);

        return {
          id: row.id,
          type: row.type,
          content: row.content,
          importance: row.importance,
          sourceChannel: row.source_channel,
          sourceUser: row.source_user,
          createdAt: row.created_at,
          similarity: parseFloat(similarity.toFixed(4)),
          metadata: row.metadata ? JSON.parse(row.metadata) : {},
        };
      });

      // 유사도 내림차순 정렬
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, limit).filter(r => r.similarity > 0.05); // 최소 유사도 필터
    } catch (err) {
      log.debug('Vector search failed', { error: err.message });
      return [];
    }
  }
}

module.exports = { HybridSearchEngine, reciprocalRankFusion, cosineSimilarity, tokenize };
