/**
 * manager.js — 4계층 메모리 매니저 (Phase 1: SQLite + Map).
 *
 * L1 Working Memory: Node.js Map + TTL (30분)
 * L2 Episodic Memory: SQLite
 * L3 Semantic Memory: SQLite FTS5
 * L4 Entity Memory: SQLite
 */
const { getDb } = require('../db/sqlite');
const { config } = require('../config');
const { contentHash } = require('../shared/utils');
const { createLogger } = require('../shared/logger');

const { summarizationQueue } = require('../shared/summarization-queue');
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
   * @param {string} conversationKey - 대화 키 ({type}:{uid}:{ch}:{thread})
   * @param {object} entry - { role, content, timestamp }
   */
  add(conversationKey, entry) {
    let bucket = this.store.get(conversationKey);
    if (!bucket) {
      bucket = { entries: [], timer: null, needsSummary: false };
      this.store.set(conversationKey, bucket);
    }

    // TTL 갱신
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => this.store.delete(conversationKey), this.ttlMs);

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

  get(conversationKey) {
    const bucket = this.store.get(conversationKey);
    return bucket ? bucket.entries : [];
  }

  clear(conversationKey) {
    const bucket = this.store.get(conversationKey);
    if (bucket?.timer) clearTimeout(bucket.timer);
    this.store.delete(conversationKey);
  }

  /** MD-5: 압축 후 메시지 교체용. */
  replace(conversationKey, newMessages) {
    let bucket = this.store.get(conversationKey);
    if (!bucket) {
      // R4-INFO-1 fix: needsSummary 초기화 — add()와 동일 패턴
      bucket = { entries: [], timer: null, needsSummary: false };
      this.store.set(conversationKey, bucket);
    }
    // BUG-1 fix: Only filter out null/undefined, preserve falsy values (0, false, empty string)
    bucket.entries = Array.isArray(newMessages)
      ? newMessages.filter(entry => entry !== null && entry !== undefined)
      : [];
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = setTimeout(() => this.store.delete(conversationKey), this.ttlMs);
  }

  /** NEW-20 fix: 전체 정리 — 프로세스 종료 시 모든 TTL 타이머 해제 */
  destroy() {
    for (const [, bucket] of this.store) {
      if (bucket.timer) clearTimeout(bucket.timer);
    }
    this.store.clear();
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
   * @param {string} conversationKey
   * @param {object} anthropicClient - Anthropic client 인스턴스
   * @param {string} model - 요약에 사용할 모델
   * @returns {boolean} 요약 실행 여부
   */
  async maybeSummarize(conversationKey, anthropicClient, model) {
    const bucket = this.store.get(conversationKey);
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

      // R2-PERF-4 fix: Route through SummarizationQueue to limit concurrent LLM calls
      const summaryModel = model || config.anthropic.defaultModel;
      const maxTokens = this.maxSummaryTokens;
      const response = await summarizationQueue.enqueue(() =>
        anthropicClient.messages.create({
          model: summaryModel,
          max_tokens: maxTokens,
          system: '이전 대화를 3-5문장으로 요약하세요. 핵심 결정사항, 논의된 주요 주제, 미해결 질문을 포함하세요. 요약문만 출력하세요.',
          messages: [{ role: 'user', content: conversationText }],
        })
      );

      // Queue was full → summarization dropped (non-critical, retry next turn)
      if (!response) return false;

      const summaryText = response.content[0]?.text || '';
      if (!summaryText) return false;

      // WorkingMemory를 [요약 + 최근 N턴]으로 교체
      // BUG-1 fix: role:'assistant'로 통일 — CompactionEngine(⑥.7)과 일관성 유지 + 연속 user turn 방지
      const recent = entries.slice(-this.keepRecent);
      bucket.entries = [
        { role: 'assistant', content: `[이전 대화 요약]\n${summaryText}`, timestamp: Date.now() },
        ...recent,
      ];

      log.info('P-1 Summarized', { entries: toSummarize.length, summaryLen: summaryText.length, conversationKey });
      return true;
    } catch (err) {
      log.warn('P-1 Summarization failed', { error: err.message, conversationKey });
      return false;
    }
  }
}

// ─── L2: Episodic Memory ───
// WARN-1 fix: contentHash는 utils.js에서 import (32자 통합)

const episodic = {
  /**
   * 에피소드 저장 (대화 메시지 1건).
   *
   * TODO v4.0: Convert to object parameter pattern:
   * save({ conversationKey, userId, channelId, threadTs, role, content, agentType, functionType })
   */
  save(conversationKey, userId, channelId, threadTs, role, content, agentType = '', functionType = '') {
    const db = getDb();
    const hash = contentHash(`${conversationKey}:${role}:${content}`);
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO episodic_memory
        (conversation_key, user_id, channel_id, thread_ts, role, content, content_hash, agent_type, function_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(conversationKey, userId, channelId, threadTs || null, role, content, hash, agentType, functionType);
  },

  /**
   * 현재 대화 히스토리 조회.
   */
  getHistory(conversationKey, limit = 30) {
    const db = getDb();
    return db.prepare(`
      SELECT role, content, created_at FROM episodic_memory
      WHERE conversation_key = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(conversationKey, limit).reverse();
  },

  /**
   * 경로 1: 유저 크로스채널 히스토리.
   */
  getUserCrossChannelHistory(userId, excludeChannelId, limit = 20) {
    const db = getDb();
    return db.prepare(`
      SELECT role, content, channel_id, created_at FROM episodic_memory
      WHERE user_id = ? AND channel_id != ?
      ORDER BY created_at DESC LIMIT ?
    `).all(userId, excludeChannelId, limit).reverse();
  },

  /**
   * 경로 3: 채널 히스토리 (유저 무관).
   */
  getChannelHistory(channelId, limit = 30) {
    const db = getDb();
    return db.prepare(`
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
  search(query, opts = {}) {
    const db = getDb();
    const limit = opts.limit || 20;
    try {
      return db.prepare(`
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
      return db.prepare(`
        SELECT *, 1.0 AS rank FROM episodic_memory
        WHERE ${likeClause}
        ORDER BY created_at DESC LIMIT ?
      `).all(...likeParams, limit);
    }
  },

  /**
   * R14-BUG-2: 유저 멘션 검색.
   * Morning Briefing의 "나를 멘션한 대화"에서 사용.
   */
  getMentions(userId, opts = {}) {
    const db = getDb();
    const limit = opts.limit || 10;
    const since = opts.since || new Date(Date.now() - 86400000).toISOString();
    return db.prepare(`
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
  save({ content, sourceType, sourceId, channelId, userId, tags, promotionReason, poolId, memoryType }) {
    const db = getDb();
    // 콘텐츠 상한 (기본 10KB) — DB 비대화 방지
    const maxLen = config.memory?.maxContentLength || 10240;
    const safeContent = (content || '').slice(0, maxLen);
    const hash = contentHash(safeContent);

    // memory_type 유효성 검사 (8가지 타입)
    const VALID_MEMORY_TYPES = ['Fact', 'Preference', 'Decision', 'Identity', 'Event', 'Observation', 'Goal', 'Todo'];
    const safeMemoryType = VALID_MEMORY_TYPES.includes(memoryType) ? memoryType : 'Fact';

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO semantic_memory
        (content, content_hash, source_type, source_id, channel_id, user_id, tags, promotion_reason, pool_id, memory_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // SEC: tags 입력 새니타이즈 (문자열만, 50자 제한)
    const safeTags = (tags || []).filter(t => typeof t === 'string').map(t => t.slice(0, 50));
    stmt.run(safeContent, hash, sourceType || 'conversation', sourceId || '', channelId || '', userId || '',
             JSON.stringify(safeTags), promotionReason || '', poolId || 'team', safeMemoryType);
    return hash;
  },

  /**
   * v3: Pool 필터 적용 FTS5 검색.
   * 에이전트의 접근 가능 풀만 검색.
   */
  searchWithPools(query, pools = ['team'], limit = 10, { memoryType } = {}) {
    // Strict type validation
    if (pools && !Array.isArray(pools)) {
      if (typeof pools === 'string') {
        console.warn('[memory] searchWithPools: pools should be array, got string. Auto-wrapping.');
        pools = [pools];
      } else {
        console.warn('[memory] searchWithPools: invalid pools type. Defaulting to [team].');
        pools = ['team'];
      }
    }
    if (!pools || pools.length === 0) pools = ['team'];
    pools = pools.filter(p => typeof p === 'string' && p.length > 0);
    if (pools.length === 0) pools = ['team'];
    if (pools.length > 10) pools = pools.slice(0, 10); // DOS 방지
    const db = getDb();
    const placeholders = pools.map(() => '?').join(',');

    // memoryType 필터 옵션
    if (memoryType) {
      return db.prepare(`
        SELECT sm.*, ABS(rank) AS score
        FROM semantic_fts
        JOIN semantic_memory sm ON semantic_fts.rowid = sm.id
        WHERE semantic_fts MATCH ?
          AND sm.archived = 0
          AND sm.pool_id IN (${placeholders})
          AND sm.memory_type = ?
        ORDER BY rank LIMIT ?
      `).all(query, ...pools, memoryType, limit);
    }

    // R17-BUG-2: FTS5 rank는 음수 (낮을수록 관련도 높음) → ABS로 양수 변환
    return db.prepare(`
      SELECT sm.*, ABS(rank) AS score
      FROM semantic_fts
      JOIN semantic_memory sm ON semantic_fts.rowid = sm.id
      WHERE semantic_fts MATCH ?
        AND sm.archived = 0
        AND sm.pool_id IN (${placeholders})
      ORDER BY rank LIMIT ?
    `).all(query, ...pools, limit);
  },

  /**
   * 경로 3: 채널 결정사항 조회.
   */
  getChannelDecisions(channelId, limit = 10) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM semantic_memory
      WHERE channel_id = ? AND source_type = 'decision' AND archived = 0
      ORDER BY created_at DESC LIMIT ?
    `).all(channelId, limit);
  },

  /**
   * Anti-Bloat: 채널/유저별 카운트 및 archived 처리.
   */
  enforceAntiBloat(channelId, userId) {
    const antiBloat = config.memory?.antiBloat || {};
    const channelLimit = antiBloat.channelLimit || 500;
    const userLimit = antiBloat.userLimit || 200;
    const db = getDb();

    // 채널 상한 체크
    if (channelId) {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM semantic_memory WHERE channel_id = ? AND archived = 0`
      ).get(channelId);
      const count = row?.cnt || 0;

      if (count > channelLimit) {
        const excess = count - channelLimit;
        db.prepare(`
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
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM semantic_memory WHERE user_id = ? AND archived = 0`
      ).get(userId);
      const count = row?.cnt || 0;

      if (count > userLimit) {
        const excess = count - userLimit;
        db.prepare(`
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
  autoArchive() {
    const db = getDb();
    // R3-BUG-1 fix: 타입 강제 — graph.autoArchive / search.getPopularMemories와 동일 패턴
    const days = Math.max(1, Math.floor(Number(config.memory?.antiBloat?.archiveDays) || 90));
    db.prepare(`
      UPDATE semantic_memory SET archived = 1
      WHERE archived = 0
        AND source_type != 'decision'
        AND last_accessed < datetime('now', '-' || ? || ' days')
    `).run(days);
  },

  /**
   * 검색 시 access_count, last_accessed 업데이트.
   */
  touchAccess(ids) {
    // R3-BUG-2 fix: null/undefined guard — graph.touch()와 동일 패턴
    if (!Array.isArray(ids) || ids.length === 0) return;
    const db = getDb();
    const stmt = db.prepare(`
      UPDATE semantic_memory SET access_count = access_count + 1, last_accessed = datetime('now')
      WHERE id = ?
    `);
    const batch = db.transaction(() => {
      for (const id of ids) stmt.run(id);
    });
    batch();
  },
};

// ─── L4: Entity Memory ───

const entity = {
  upsert(entityType, entityId, name, properties = {}) {
    const db = getDb();
    db.prepare(`
      INSERT INTO entities (entity_type, entity_id, name, properties, last_seen)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        name = COALESCE(NULLIF(excluded.name, ''), entities.name),
        properties = excluded.properties,
        last_seen = datetime('now')
    `).run(entityType, entityId, name || '', JSON.stringify(properties));
  },

  // NEW-01 fix: properties를 건드리지 않고 last_seen + name만 업데이트
  touchLastSeen(entityType, entityId, name) {
    const db = getDb();
    const existing = db.prepare(
      `SELECT 1 FROM entities WHERE entity_type = ? AND entity_id = ?`
    ).get(entityType, entityId);
    if (existing) {
      // 기존 엔티티: last_seen 갱신 + 이름이 비어있지 않으면 업데이트
      if (name) {
        db.prepare(`UPDATE entities SET last_seen = datetime('now'), name = COALESCE(NULLIF(?, ''), name) WHERE entity_type = ? AND entity_id = ?`).run(name, entityType, entityId);
      } else {
        db.prepare(`UPDATE entities SET last_seen = datetime('now') WHERE entity_type = ? AND entity_id = ?`).run(entityType, entityId);
      }
    } else {
      // 신규 엔티티: 기본 생성 (온보딩에서 채워짐)
      db.prepare(`INSERT INTO entities (entity_type, entity_id, name, properties, last_seen) VALUES (?, ?, ?, '{}', datetime('now'))`).run(entityType, entityId, name || '');
    }
  },

  get(entityType, entityId) {
    const db = getDb();
    const row = db.prepare(
      `SELECT * FROM entities WHERE entity_type = ? AND entity_id = ?`
    ).get(entityType, entityId);
    if (row) {
      try { row.properties = JSON.parse(row.properties || '{}'); }
      catch (e) {
        console.warn(`[memory] Corrupt JSON in entity ${entityType}/${entityId}: ${e.message}`);
        row.properties = {};
        row._propertiesParseError = true;
      }
    }
    return row;
  },

  /**
   * R14-BUG-3: 엔티티 목록 조회.
   * Morning Briefing에서 등록된 사용자 목록 조회에 사용.
   */
  list(entityType, limit = 100) {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM entities WHERE entity_type = ? ORDER BY last_seen DESC LIMIT ?`
    ).all(entityType, limit);
    for (const row of rows) {
      try { row.properties = JSON.parse(row.properties || '{}'); }
      catch { row.properties = {}; }
    }
    return rows;
  },

  addRelationship(srcType, srcId, tgtType, tgtId, relation, metadata = {}) {
    const db = getDb();
    db.prepare(`
      INSERT INTO entity_relationships (source_type, source_id, target_type, target_id, relation, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id, target_type, target_id, relation) DO UPDATE SET
        weight = entity_relationships.weight + 0.1,
        metadata = excluded.metadata
    `).run(srcType, srcId, tgtType, tgtId, relation, JSON.stringify(metadata));
  },

  getRelated(entityType, entityId, limit = 20) {
    const db = getDb();
    return db.prepare(`
      SELECT er.*, e.name as target_name
      FROM entity_relationships er
      LEFT JOIN entities e ON e.entity_type = er.target_type AND e.entity_id = er.target_id
      WHERE er.source_type = ? AND er.source_id = ?
      ORDER BY er.weight DESC LIMIT ?
    `).all(entityType, entityId, limit);
  },

  getTopicWeight(topicId) {
    const db = getDb();
    const row = db.prepare(`
      SELECT SUM(weight) as total_weight FROM entity_relationships
      WHERE (source_type = 'topic' AND source_id = ?)
         OR (target_type = 'topic' AND target_id = ?)
    `).get(topicId, topicId);
    return row?.total_weight || 0;
  },
};

// ─── 비용 추적 ───

const cost = {
  log(userId, model, inputTokens, outputTokens, sessionId = '') {
    const db = getDb();
    // SF-4: YAML config.cost.modelRates에서 단가 로드, 폴백 기본값
    const DEFAULT_RATES = {
      'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
      'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
    };
    const configRates = config.cost?.modelRates || {};
    const rate = configRates[model] || DEFAULT_RATES[model] || DEFAULT_RATES['claude-haiku-4-5-20251001'];
    const costUsd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;

    db.prepare(`
      INSERT INTO cost_log (user_id, model, input_tokens, output_tokens, cost_usd, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, model, inputTokens, outputTokens, costUsd, sessionId);

    return costUsd;
  },

  getMonthlyTotal(userId) {
    const db = getDb();
    const row = db.prepare(`
      SELECT SUM(cost_usd) as total FROM cost_log
      WHERE user_id = ? AND created_at >= datetime('now', 'start of month')
    `).get(userId);
    return row?.total || 0;
  },
};

// ─── 프로모션 로그 ───

const promotion = {
  log(sourceLayer, targetLayer, contentHash, reason) {
    const db = getDb();
    db.prepare(`
      INSERT INTO memory_promotions (source_layer, target_layer, content_hash, reason)
      VALUES (?, ?, ?, ?)
    `).run(sourceLayer, targetLayer, contentHash, reason);
  },
};

// STRUCT-1 fix: Prevent accidental property addition to singleton memory objects
Object.seal(semantic);
Object.seal(episodic);
Object.seal(entity);

module.exports = {
  WorkingMemory,
  episodic,
  semantic,
  entity,
  cost,
  promotion,
  contentHash,
};
