/**
 * manager.js — 4계층 메모리 매니저 (Phase 1: SQLite + Map).
 *
 * L1 Working Memory: Node.js Map + TTL (30분)
 * L2 Episodic Memory: SQLite
 * L3 Semantic Memory: SQLite FTS5
 * L4 Entity Memory: SQLite
 */
const { getDb, ftsSearch } = require('../db');
const { config } = require('../config');
const { contentHash } = require('../shared/utils');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:working');

// ─── L1: Working Memory (in-process Map + TTL) ───

class WorkingMemory {
  constructor(ttlMs = 30 * 60 * 1000, maxEntries = 50) {
    this.store = new Map();     // conversationKey → { entries: [], timer, needsSummary: false }
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;

    // P-1: 요약 설정 (YAML에서 로드)
    // R4-BUG-1 fix: || → ?? — 명시적 0 설정이 falsy로 무시되는 문제 방지
    const sumCfg = config.memory?.summarization || {};
    this.summarizationEnabled = sumCfg.enabled !== false;
    this.summarizeThreshold = sumCfg.threshold ?? 30;
    this.keepRecent = sumCfg.keepRecent ?? 10;
    this.maxSummaryTokens = sumCfg.maxSummaryTokens ?? 500;
  }

  /**
   * 작업 메모리에 메시지 추가.
   * @param {string} convKey - 대화 키 ({type}:{uid}:{ch}:{thread})
   * @param {object} entry - { role, content, timestamp }
   */
  add(convKey, entry) {
    let bucket = this.store.get(convKey);
    if (!bucket) {
      bucket = { entries: [], timer: null, needsSummary: false };
      this.store.set(convKey, bucket);
    }

    // TTL 갱신
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => this.store.delete(convKey), this.ttlMs);

    bucket.entries.push({ ...entry, timestamp: Date.now() });

    // P-1: 요약 필요 플래그 설정 (임계치 초과 시)
    if (this.summarizationEnabled && bucket.entries.length > this.summarizeThreshold) {
      bucket.needsSummary = true;
    }

    // 상한 초과 시 오래된 것 제거 (요약 실패 시 안전장치)
    if (bucket.entries.length > this.maxEntries) {
      bucket.entries = bucket.entries.slice(-this.maxEntries);
    }
  }

  get(convKey) {
    const bucket = this.store.get(convKey);
    return bucket ? bucket.entries : [];
  }

  clear(convKey) {
    const bucket = this.store.get(convKey);
    if (bucket?.timer) clearTimeout(bucket.timer);
    this.store.delete(convKey);
  }

  /** MD-5: 압축 후 메시지 교체용. */
  replace(convKey, newMessages) {
    let bucket = this.store.get(convKey);
    if (!bucket) {
      // R4-INFO-1 fix: needsSummary 초기화 — add()와 동일 패턴
      bucket = { entries: [], timer: null, needsSummary: false };
      this.store.set(convKey, bucket);
    }
    bucket.entries = Array.isArray(newMessages) ? [...newMessages] : [];
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => this.store.delete(convKey), this.ttlMs);
  }

  get size() {
    return this.store.size;
  }

  /**
   * P-1: 요약 필요 여부 확인 + 요약 실행.
   *
   * Gateway의 ⑥.5 단계에서 호출. Haiku로 이전 대화를 요약하고
   * WorkingMemory를 [요약 + 최근 N턴]으로 교체한다.
   *
   * @param {string} convKey
   * @param {object} anthropicClient - Anthropic client 인스턴스
   * @param {string} model - 요약에 사용할 모델
   * @returns {boolean} 요약 실행 여부
   */
  async maybeSummarize(convKey, anthropicClient, model) {
    const bucket = this.store.get(convKey);
    if (!bucket || !bucket.needsSummary) return false;

    // 플래그 즉시 해제 (중복 호출 방지)
    bucket.needsSummary = false;

    const entries = bucket.entries;
    const toSummarize = entries.slice(0, entries.length - this.keepRecent);
    if (toSummarize.length < 5) return false; // 최소 5턴 이상일 때만

    try {
      const conversationText = toSummarize
        .map(e => `[${e.role}] ${e.content}`)
        .join('\n')
        .slice(0, 6000); // 요약 입력 상한

      const response = await anthropicClient.messages.create({
        model: model || config.anthropic.defaultModel,
        max_tokens: this.maxSummaryTokens,
        system: '이전 대화를 3-5문장으로 요약하세요. 핵심 결정사항, 논의된 주요 주제, 미해결 질문을 포함하세요. 요약문만 출력하세요.',
        messages: [{ role: 'user', content: conversationText }],
      });

      const summaryText = response.content[0]?.text || '';
      if (!summaryText) return false;

      // WorkingMemory를 [요약 + 최근 N턴]으로 교체
      // BUG-1 fix: role:'assistant'로 통일 — CompactionEngine(⑥.7)과 일관성 유지 + 연속 user turn 방지
      const recent = entries.slice(-this.keepRecent);
      bucket.entries = [
        { role: 'assistant', content: `[이전 대화 요약]\n${summaryText}`, timestamp: Date.now() },
        ...recent,
      ];

      log.info('P-1 Summarized', { entries: toSummarize.length, summaryLen: summaryText.length, convKey });
      return true;
    } catch (err) {
      log.warn('P-1 Summarization failed', { error: err.message, convKey });
      return false;
    }
  }
}

// ─── L2: Episodic Memory ───
// WARN-1 fix: contentHash는 utils.js에서 import (32자 통합)

const episodic = {
  /**
   * 에피소드 저장 (대화 메시지 1건).
   */
  async save(convKey, userId, channelId, threadTs, role, content, agentType = '', functionType = '') {
    const db = getDb();
    const hash = contentHash(`${convKey}:${role}:${content}`);
    const stmt = db.prepare(`
      INSERT INTO episodic_memory
        (conversation_key, user_id, channel_id, thread_ts, role, content, content_hash, agent_type, function_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING
    `);
    await stmt.run(convKey, userId, channelId, threadTs || null, role, content, hash, agentType, functionType);
  },

  /**
   * 현재 대화 히스토리 조회.
   */
  async getHistory(convKey, limit = 30) {
    const db = getDb();
    return await db.prepare(`
      SELECT role, content, created_at FROM episodic_memory
      WHERE conversation_key = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(convKey, limit).reverse();
  },

  /**
   * 경로 1: 유저 크로스채널 히스토리.
   */
  async getUserCrossChannelHistory(userId, excludeChannelId, limit = 20) {
    const db = getDb();
    return await db.prepare(`
      SELECT role, content, channel_id, created_at FROM episodic_memory
      WHERE user_id = ? AND channel_id != ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, excludeChannelId, limit).reverse();
  },

  /**
   * 경로 3: 채널 히스토리 (유저 무관).
   */
  async getChannelHistory(channelId, limit = 30) {
    const db = getDb();
    return await db.prepare(`
      SELECT user_id, role, content, created_at FROM episodic_memory
      WHERE channel_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(channelId, limit).reverse();
  },

  /**
   * R14-BUG-1: FTS5 기반 에피소드 검색.
   * Smart Search의 Expert Finder, Duplicate Detector, File Finder에서 사용.
   *
   * @param {string} query - FTS5 검색 쿼리
   * @param {object} opts - { limit }
   * @returns {Array<{ user_id, role, content, channel_id, created_at, score }>}
   */
  async search(query, opts = {}) {
    const db = getDb();
    const limit = opts.limit || 20;
    try {
      return await db.prepare(`
        SELECT em.*, rank AS score
        FROM episodic_fts
        JOIN episodic_memory em ON episodic_fts.rowid = em.id
        WHERE episodic_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(query, limit);
    } catch {
      // episodic_fts 테이블이 없는 경우 (Phase 1 SQLite) → LIKE fallback
      const words = (query || '').split(/\s+/).filter(w => w.length > 1);
      if (words.length === 0) return [];
      const likeClause = words.map(() => `content LIKE ?`).join(' AND ');
      const likeParams = words.map(w => `%${w}%`);
      return await db.prepare(`
        SELECT *, 1.0 AS score FROM episodic_memory
        WHERE ${likeClause}
        ORDER BY created_at DESC LIMIT ?
      `).all(...likeParams, limit);
    }
  },

  /**
   * R14-BUG-2: 유저 멘션 검색.
   * Morning Briefing의 "나를 멘션한 대화"에서 사용.
   */
  async getMentions(userId, opts = {}) {
    const db = getDb();
    const limit = opts.limit || 10;
    const since = opts.since || new Date(Date.now() - 86400000).toISOString();
    return await db.prepare(`
      SELECT * FROM episodic_memory
      WHERE content LIKE ? AND created_at >= ?
      ORDER BY created_at DESC LIMIT ?
    `).all(`%<@${userId}>%`, since, limit);
  },
};

// ─── L3: Semantic Memory (FTS5 기반) ───

const semantic = {
  /**
   * 시맨틱 메모리 저장 (L3 승격 시).
   */
  async save({ content, sourceType, sourceId, channelId, userId, tags, promotionReason, poolId, memoryType }) {
    const db = getDb();
    // R2-AUDIT: userId 누락 시 경고 로그 — 글로벌 가시성 메모리 방지
    if (!userId) {
      log.warn('semantic.save() called without userId — memory will have global visibility', {
        sourceType, channelId, poolId,
      });
    }
    // 콘텐츠 상한 (기본 10KB) — DB 비대화 방지
    const maxLen = config.memory?.maxContentLength || 10240;
    const safeContent = (content || '').slice(0, maxLen);
    const hash = contentHash(safeContent);

    // memory_type 유효성 검사 (8가지 타입)
    const VALID_MEMORY_TYPES = ['Fact', 'Preference', 'Decision', 'Identity', 'Event', 'Observation', 'Goal', 'Todo'];
    const safeMemoryType = VALID_MEMORY_TYPES.includes(memoryType) ? memoryType : 'Fact';

    const stmt = db.prepare(`
      INSERT INTO semantic_memory
        (content, content_hash, source_type, source_id, channel_id, user_id, tags, promotion_reason, pool_id, memory_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING
    `);
    // SEC: tags 입력 새니타이즈 (문자열만, 50자 제한)
    const safeTags = (tags || []).filter(t => typeof t === 'string').map(t => t.slice(0, 50));
    await stmt.run(safeContent, hash, sourceType || 'conversation', sourceId || '', channelId || '', userId || '',
             JSON.stringify(safeTags), promotionReason || '', poolId || 'team', safeMemoryType);
    return hash;
  },

  /**
   * v3: Pool 필터 적용 FTS5 검색.
   * 에이전트의 접근 가능 풀만 검색.
   */
  async searchWithPools(query, pools = ['team'], limit = 10, { memoryType } = {}) {
    if (!pools || pools.length === 0) pools = ['team'];
    pools = pools.filter(p => typeof p === 'string' && p.length > 0);
    if (pools.length === 0) pools = ['team'];
    if (pools.length > 10) pools = pools.slice(0, 10); // DOS 방지

    return await ftsSearch('semantic_memory', query, { pools, memoryType, limit });
  },

  /**
   * 경로 3: 채널 결정사항 조회.
   */
  async getChannelDecisions(channelId, limit = 10) {
    const db = getDb();
    return await db.prepare(`
      SELECT * FROM semantic_memory
      WHERE channel_id = ? AND source_type = 'decision' AND archived = 0
      ORDER BY created_at DESC LIMIT ?
    `).all(channelId, limit);
  },

  /**
   * Anti-Bloat: 채널/유저별 카운트 및 archived 처리.
   */
  async enforceAntiBloat(channelId, userId) {
    // BUG-110 fix: ?? 연산자 사용 — 명시적 0 설정이 falsy로 무시되지 않도록
    const antiBloat = config.memory?.antiBloat ?? {};
    const channelLimit = antiBloat.channelLimit ?? 500;
    const userLimit = antiBloat.userLimit ?? 200;
    const db = getDb();

    // 채널 상한 체크
    if (channelId) {
      const row = await db.prepare(
        `SELECT COUNT(*) as cnt FROM semantic_memory WHERE channel_id = ? AND archived = 0`
      ).get(channelId);
      const count = row?.cnt || 0;

      if (count > channelLimit) {
        const excess = count - channelLimit;
        await db.prepare(`
          UPDATE semantic_memory SET archived = 1
          WHERE id IN (
            SELECT id FROM semantic_memory
            WHERE channel_id = ? AND archived = 0 AND source_type != 'decision'
            ORDER BY last_accessed ASC LIMIT ?
          )
        `).run(channelId, excess);
      }
    }

    // 유저 상한 체크
    if (userId) {
      const row = await db.prepare(
        `SELECT COUNT(*) as cnt FROM semantic_memory WHERE user_id = ? AND archived = 0`
      ).get(userId);
      const count = row?.cnt || 0;

      if (count > userLimit) {
        const excess = count - userLimit;
        await db.prepare(`
          UPDATE semantic_memory SET archived = 1
          WHERE id IN (
            SELECT id FROM semantic_memory
            WHERE user_id = ? AND archived = 0 AND source_type != 'decision'
            ORDER BY last_accessed ASC LIMIT ?
          )
        `).run(userId, excess);
      }
    }
  },

  /**
   * N일 미참조 auto-archive (결정사항 제외). config.memory.antiBloat.archiveDays 참조.
   */
  async autoArchive() {
    const db = getDb();
    // R3-BUG-1 fix: 타입 강제 — graph.autoArchive / search.getPopularMemories와 동일 패턴
    const days = Math.max(1, Math.floor(Number(config.memory?.antiBloat?.archiveDays) || 90));
    await db.prepare(`
      UPDATE semantic_memory SET archived = 1
      WHERE archived = 0
        AND source_type != 'decision'
        AND last_accessed < datetime('now', '-' || ? || ' days')
    `).run(days);
  },

  /**
   * 검색 시 access_count, last_accessed 업데이트.
   */
  async touchAccess(ids) {
    // R3-BUG-2 fix: null/undefined guard — graph.touch()와 동일 패턴
    if (!Array.isArray(ids) || ids.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE semantic_memory SET access_count = access_count + 1, last_accessed = datetime('now')
      WHERE id = ?
    `);
    // BUG-103 fix: better-sqlite3 transaction은 동기 — async 콜백 + 미await 제거
    const batch = db.transaction((idList) => {
      for (const id of idList) stmt.run(id);
    });
    batch(ids);
  },
};

// ─── L4: Entity Memory ───

const entity = {
  async upsert(entityType, entityId, name, properties = {}) {
    const db = getDb();
    await db.prepare(`
      INSERT INTO entities (entity_type, entity_id, name, properties, last_seen)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), entities.name),
        properties = excluded.properties,
        last_seen = datetime('now')
    `).run(entityType, entityId, name || '', JSON.stringify(properties));
  },

  async get(entityType, entityId) {
    const db = getDb();
    const row = await db.prepare(
      `SELECT * FROM entities WHERE entity_type = ? AND entity_id = ?`
    ).get(entityType, entityId);
    if (row) {
      try { row.properties = JSON.parse(row.properties || '{}'); }
      catch { row.properties = {}; }
    }
    return row;
  },

  /**
   * R14-BUG-3: 엔티티 목록 조회.
   * Morning Briefing에서 등록된 사용자 목록 조회에 사용.
   */
  async list(entityType, limit = 100) {
    const db = getDb();
    const rows = await db.prepare(
      `SELECT * FROM entities WHERE entity_type = ? ORDER BY last_seen DESC LIMIT ?`
    ).all(entityType, limit);
    for (const row of rows) {
      try { row.properties = JSON.parse(row.properties || '{}'); }
      catch { row.properties = {}; }
    }
    return rows;
  },

  async addRelationship(srcType, srcId, tgtType, tgtId, relation, metadata = {}) {
    const db = getDb();
    await db.prepare(`
      INSERT INTO entity_relationships (source_type, source_id, target_type, target_id, relation, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id, target_type, target_id, relation) DO UPDATE SET
        weight = entity_relationships.weight + 0.1,
        metadata = excluded.metadata
    `).run(srcType, srcId, tgtType, tgtId, relation, JSON.stringify(metadata));
  },

  async getRelated(entityType, entityId, limit = 20) {
    const db = getDb();
    return await db.prepare(`
      SELECT er.*, e.name as target_name
      FROM entity_relationships er
      LEFT JOIN entities e ON e.entity_type = er.target_type AND e.entity_id = er.target_id
      WHERE er.source_type = ? AND er.source_id = ?
      ORDER BY er.weight DESC LIMIT ?
    `).all(entityType, entityId, limit);
  },

  async getTopicWeight(topicId) {
    const db = getDb();
    const row = await db.prepare(`
      SELECT SUM(weight) as total_weight FROM entity_relationships
      WHERE (source_type = 'topic' AND source_id = ?)
         OR (target_type = 'topic' AND target_id = ?)
    `).get(topicId, topicId);
    return row?.total_weight || 0;
  },
};

// ─── 비용 추적 ───

const cost = {
  async log(userId, model, inputTokens, outputTokens, sessionId = '') {
    const db = getDb();
    // SF-4: YAML config.cost.modelRates에서 단가 로드, 폴백 기본값
    const DEFAULT_RATES = {
      'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
      'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
    };
    const configRates = config.cost?.modelRates || {};
    const rate = configRates[model] || DEFAULT_RATES[model] || DEFAULT_RATES['claude-haiku-4-5-20251001'];
    const costUsd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;

    await db.prepare(`
      INSERT INTO cost_log (user_id, model, input_tokens, output_tokens, cost_usd, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, model, inputTokens, outputTokens, costUsd, sessionId);

    return costUsd;
  },

  async getMonthlyTotal(userId) {
    const db = getDb();
    const row = await db.prepare(`
      SELECT SUM(cost_usd) as total FROM cost_log
      WHERE user_id = ? AND created_at >= datetime('now', 'start of month')
    `).get(userId);
    return row?.total || 0;
  },
};

// ─── 프로모션 로그 ───

const promotion = {
  async log(sourceLayer, targetLayer, contentHash, reason) {
    const db = getDb();
    await db.prepare(`
      INSERT INTO memory_promotions (source_layer, target_layer, content_hash, reason)
      VALUES (?, ?, ?, ?)
    `).run(sourceLayer, targetLayer, contentHash, reason);
  },
};

module.exports = {
  WorkingMemory,
  episodic,
  semantic,
  entity,
  cost,
  promotion,
  contentHash,
};
