/**
 * tiered-memory.js — Tiered Memory Manager (Module 42)
 *
 * 이중 계층 메모리 시스템 (SpaceBot-inspired)
 * - Working 계층: 핫, 3일 TTL, 64 상한, 1.5배 검색 부스트
 * - Graph 계층: 웜, 30일 보관, 감쇠
 * - PERMANENT_TYPES: 절대로 강등하지 않음
 */

const { createLogger } = require('../shared/logger');
const { getDb } = require('../db/sqlite');

const log = createLogger('memory:tiered');

const MEMORY_TIERS = { WORKING: 'working', GRAPH: 'graph' };
const PERMANENT_TYPES = ['identity', 'preference'];

class TieredMemoryManager {
  /**
   * 초기화 — 이중 계층 메모리 매니저 구성
   *
   * @param {Object} opts - 옵션
   * @param {Object} opts.db - better-sqlite3 인스턴스
   * @param {number} [opts.workingTTLMs=259200000] - Working 계층 TTL (기본값: 3일)
   * @param {number} [opts.workingMaxCount=64] - Working 계층 LRU 상한
   * @param {number} [opts.graphRetentionDays=30] - Graph 계층 보관 기간
   * @param {number} [opts.searchBoost=1.5] - Working 계층 검색 점수 배율
   */
  constructor(opts = {}) {
    this.db = opts.db;
    this.workingTTLMs = opts.workingTTLMs || 259200000; // 3일
    this.workingMaxCount = opts.workingMaxCount || 64;
    this.graphRetentionDays = opts.graphRetentionDays || 30;
    this.searchBoost = opts.searchBoost || 1.5;

    log.info('TieredMemoryManager initialized', {
      workingTTLMs: this.workingTTLMs,
      workingMaxCount: this.workingMaxCount,
      graphRetentionDays: this.graphRetentionDays,
      searchBoost: this.searchBoost
    });
  }

  /**
   * DB 스키마 마이그레이션
   * 기존 memories 테이블에 tier, last_accessed 컬럼 추가
   */
  init() {
    try {
      const db = this.db || getDb();

      // ALTER TABLE with safe try/catch 패턴
      db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          content_hash TEXT UNIQUE,
          source_channel TEXT DEFAULT '',
          source_user TEXT DEFAULT '',
          agent_id TEXT DEFAULT '',
          importance REAL DEFAULT 0.5,
          base_importance REAL DEFAULT 0.5,
          access_frequency INTEGER DEFAULT 0,
          access_count INTEGER DEFAULT 0,
          metadata TEXT DEFAULT '{}',
          created_at TEXT DEFAULT (datetime('now')),
          tier TEXT DEFAULT 'graph',
          last_accessed TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(tier);
        CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);
      `);

      // 안전한 ALTER TABLE 시도 (이미 컬럼이 있을 수 있음)
      try {
        db.exec('ALTER TABLE memories ADD COLUMN tier TEXT DEFAULT "graph"');
      } catch (err) {
        if (!err.message.includes('duplicate column')) {
          throw err;
        }
      }

      try {
        db.exec('ALTER TABLE memories ADD COLUMN last_accessed TEXT DEFAULT (datetime("now"))');
      } catch (err) {
        if (!err.message.includes('duplicate column')) {
          throw err;
        }
      }

      log.info('Tiered memory schema initialized');
    } catch (err) {
      log.error('Failed to initialize tiered memory schema', err);
      throw err;
    }
  }

  /**
   * 메모리 저장 (Working 계층에 삽입, LRU 초과 시 자동 강등)
   *
   * @param {Object} memory - 메모리 객체
   * @param {string} memory.type - 메모리 타입
   * @param {string} memory.content - 메모리 콘텐츠
   * @param {string} memory.channelId - 채널 ID
   * @param {string} memory.agentId - 에이전트 ID
   * @param {number} [memory.importance=0.5] - 중요도 (0-1)
   * @param {Object} [memory.metadata={}] - 추가 메타데이터
   * @returns {{ id: number, tier: string }} 메모리 ID와 계층
   */
  save(memory) {
    try {
      const db = this.db || getDb();

      const contentHash = this._hashContent(memory.content);
      const tier = PERMANENT_TYPES.includes(memory.type) ? 'working' : 'graph';
      const metadata = JSON.stringify(memory.metadata || {});

      const stmt = db.prepare(`
        INSERT INTO memories (
          type, content, content_hash, source_channel, agent_id,
          importance, base_importance, metadata, tier, last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);

      const result = stmt.run(
        memory.type,
        memory.content,
        contentHash,
        memory.channelId || '',
        memory.agentId || '',
        memory.importance || 0.5,
        memory.importance || 0.5,
        metadata,
        tier
      );

      const memoryId = result.lastInsertRowid;

      // LRU 강제 실행 (working 계층이 maxCount 초과 시)
      this._enforceLRU(memory.agentId);

      log.debug('Memory saved', {
        id: memoryId,
        tier,
        type: memory.type,
        agentId: memory.agentId
      });

      return { id: memoryId, tier };
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        log.debug('Memory already exists (duplicate hash)', { type: memory.type });
        const db = this.db || getDb();
        const existing = db.prepare('SELECT id, tier FROM memories WHERE content_hash = ?').get(contentHash);
        return existing ? { id: existing.id, tier: existing.tier } : { id: null, tier: null };
      }
      log.error('Failed to save memory', err);
      throw err;
    }
  }

  /**
   * 메모리 검색 (Working first → Graph, 부스트 적용)
   *
   * @param {string} query - 검색 쿼리
   * @param {Object} opts - 옵션
   * @param {string} [opts.channelId] - 채널 필터
   * @param {string} [opts.agentId] - 에이전트 필터
   * @param {number} [opts.limit=10] - 결과 상한
   * @param {Array<string>} [opts.types] - 타입 필터
   * @returns {Array<Object>} 검색 결과 (score 포함)
   */
  search(query, opts = {}) {
    try {
      const db = this.db || getDb();
      const limit = opts.limit || 10;
      const channelId = opts.channelId;
      const agentId = opts.agentId;
      const types = opts.types || [];

      // DOS protection: limit query length
      if (query && query.length > 1000) {
        log.warn('search query too long, truncating', { queryLength: query.length });
        query = query.substring(0, 1000);
      }

      const results = [];

      // ─── Working 계층 검색 ───
      let workingQuery = `
        SELECT id, type, content, importance, tier, access_count
        FROM memories
        WHERE tier = ? AND (content LIKE ?)
      `;
      const workingParams = ['working', `%${query}%`];

      if (channelId) {
        workingQuery += ' AND source_channel = ?';
        workingParams.push(channelId);
      }
      if (agentId) {
        workingQuery += ' AND agent_id = ?';
        workingParams.push(agentId);
      }
      if (types.length > 0) {
        workingQuery += ` AND type IN (${types.map(() => '?').join(',')})`;
        workingParams.push(...types);
      }

      workingQuery += ' ORDER BY importance DESC LIMIT ?';
      workingParams.push(limit);

      const workingResults = db.prepare(workingQuery).all(...workingParams);

      // Working 결과에 부스트 적용
      for (const row of workingResults) {
        results.push({
          ...row,
          tier: 'working',
          score: (row.importance * this.searchBoost),
          boosted: true
        });
      }

      // ─── Graph 계층 검색 (Working에서 부족하면) ───
      if (results.length < limit) {
        let graphQuery = `
          SELECT id, type, content, importance, tier, access_count
          FROM memories
          WHERE tier = ? AND (content LIKE ?)
        `;
        const graphParams = ['graph', `%${query}%`];

        if (channelId) {
          graphQuery += ' AND source_channel = ?';
          graphParams.push(channelId);
        }
        if (agentId) {
          graphQuery += ' AND agent_id = ?';
          graphParams.push(agentId);
        }
        if (types.length > 0) {
          graphQuery += ` AND type IN (${types.map(() => '?').join(',')})`;
          graphParams.push(...types);
        }

        const remaining = limit - results.length;
        graphQuery += ' ORDER BY importance DESC LIMIT ?';
        graphParams.push(remaining);

        const graphResults = db.prepare(graphQuery).all(...graphParams);

        for (const row of graphResults) {
          results.push({
            ...row,
            tier: 'graph',
            score: row.importance,
            boosted: false
          });
        }
      }

      // 점수 기준 정렬 및 상한
      results.sort((a, b) => b.score - a.score);
      return results.slice(0, limit);
    } catch (err) {
      log.error('Failed to search memory', err);
      return [];
    }
  }

  /**
   * 메모리 접근 기록 (last_accessed 갱신 → TTL 리셋)
   *
   * @param {number} memoryId - 메모리 ID
   */
  touch(memoryId) {
    try {
      const db = this.db || getDb();

      db.prepare(`
        UPDATE memories
        SET last_accessed = datetime('now'), access_count = access_count + 1
        WHERE id = ?
      `).run(memoryId);

      log.debug('Memory touched', { memoryId });
    } catch (err) {
      log.error('Failed to touch memory', err);
    }
  }

  /**
   * Working → Graph 강등 (TTL 만료 또는 LRU 초과)
   *
   * @returns {{ demoted: number, reason: string }} 강등된 메모리 수
   */
  demote() {
    try {
      const db = this.db || getDb();

      // TTL 만료된 메모리 강등
      const ttlCutoff = new Date(Date.now() - this.workingTTLMs).toISOString();

      const demoteResult = db.prepare(`
        UPDATE memories
        SET tier = ?
        WHERE tier = ? AND last_accessed < ? AND type NOT IN (${PERMANENT_TYPES.map(() => '?').join(',')})
      `).run('graph', 'working', ttlCutoff, ...PERMANENT_TYPES);

      log.info('Memories demoted (TTL)', {
        demoted: demoteResult.changes,
        ttlCutoff
      });

      return {
        demoted: demoteResult.changes,
        reason: 'TTL expiration'
      };
    } catch (err) {
      log.error('Failed to demote memories', err);
      return { demoted: 0, reason: 'error' };
    }
  }

  /**
   * Graph 계층 정리 (retentionDays 초과)
   *
   * @returns {{ purged: number }} 삭제된 메모리 수
   */
  purgeExpired() {
    try {
      const db = this.db || getDb();

      const cutoff = new Date(
        Date.now() - this.graphRetentionDays * 86400000
      ).toISOString();

      const result = db.prepare(`
        DELETE FROM memories
        WHERE tier = ? AND created_at < ?
      `).run('graph', cutoff);

      log.info('Graph tier purged', {
        purged: result.changes,
        retentionDays: this.graphRetentionDays
      });

      return { purged: result.changes };
    } catch (err) {
      log.error('Failed to purge expired memories', err);
      return { purged: 0 };
    }
  }

  /**
   * 계층별 메모리 수 통계
   *
   * @returns {{ working: number, graph: number, permanent: number }} 통계
   */
  stats() {
    try {
      const db = this.db || getDb();

      const workingCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE tier = ?'
      ).get('working');

      const graphCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM memories WHERE tier = ?'
      ).get('graph');

      const permanentCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM memories WHERE type IN (${PERMANENT_TYPES.map(() => '?').join(',')})`
      ).get(...PERMANENT_TYPES);

      return {
        working: workingCount?.cnt || 0,
        graph: graphCount?.cnt || 0,
        permanent: permanentCount?.cnt || 0
      };
    } catch (err) {
      log.error('Failed to get stats', err);
      return { working: 0, graph: 0, permanent: 0 };
    }
  }

  /**
   * Working 계층 LRU 강제 강등 (maxCount 초과 시)
   *
   * @private
   * @param {string} agentId - 에이전트 ID
   */
  _enforceLRU(agentId) {
    try {
      const db = this.db || getDb();

      if (!agentId) return;

      // Working 계층에서 해당 에이전트의 메모리 수 확인
      const countResult = db.prepare(`
        SELECT COUNT(*) as cnt FROM memories
        WHERE tier = ? AND agent_id = ? AND type NOT IN (${PERMANENT_TYPES.map(() => '?').join(',')})
      `).get('working', agentId, ...PERMANENT_TYPES);

      const count = countResult?.cnt || 0;

      if (count > this.workingMaxCount) {
        // 초과분 강등 (LRU: last_accessed 기준)
        const excessCount = count - this.workingMaxCount;

        db.prepare(`
          UPDATE memories
          SET tier = ?
          WHERE id IN (
            SELECT id FROM memories
            WHERE tier = ? AND agent_id = ? AND type NOT IN (${PERMANENT_TYPES.map(() => '?').join(',')})
            ORDER BY last_accessed ASC
            LIMIT ?
          )
        `).run('graph', 'working', agentId, ...PERMANENT_TYPES, excessCount);

        log.debug('LRU enforcement executed', {
          agentId,
          demoted: excessCount,
          newCount: count - excessCount
        });
      }
    } catch (err) {
      log.error('Failed to enforce LRU', err);
    }
  }

  /**
   * 콘텐츠 해시 계산 (간단한 SHA-256 유사 처리)
   * @private
   * @param {string} content - 콘텐츠
   * @returns {string} 해시
   */
  _hashContent(content) {
    // 간단한 구현: 실제로는 crypto.createHash('sha256') 사용 가능
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }
}

module.exports = { TieredMemoryManager, MEMORY_TIERS, PERMANENT_TYPES };
