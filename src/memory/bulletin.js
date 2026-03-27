/**
 * Memory Bulletin — LLM이 큐레이팅하는 메모리 브리핑 시스템.
 * 주기적으로 전체 메모리를 LLM으로 요약한
 * 500단어 브리핑을 모든 채널의 시스템 프롬프트에 주입.
 *
 * Memory Bulletin - LLM-curated memory briefing system.
 * Periodically summarizes all memory via LLM
 * into a 500-word briefing injected into all channels' system prompts.
 */

const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');
const { config } = require('../config');
const { getAdapter } = require('../db/adapter');

class MemoryBulletin extends EventEmitter {
  /**
   * 초기화 — LLM 기반 메모리 브리핑 시스템 구성
   * Initialize - LLM-based memory briefing system configuration
   *
   * v3.9: 채널별 격리 — _bulletins 키를 channelId:agentId로 변경.
   * v3.9: PostgreSQL 영속화 — bulletins 테이블에 저장/복원.
   *
   * @param {Object} opts - 옵션 / Options
   * @param {Function} opts.createMessage - LLM 호출 함수 (Anthropic createMessage) / LLM call function
   * @param {number} [opts.refreshIntervalMs] - 갱신 간격 (기본값 3600000ms = 60분) / Refresh interval (default 60min)
   * @param {number} [opts.staleThresholdMultiplier] - 보관함 사용 불가 임계값 (기본값 2x refreshInterval) / Staleness threshold multiplier
   * @param {string} [opts.model] - LLM 모델 (기본값 'claude-haiku-4-5-20251001') / LLM model
   * @param {Object} [opts.db] - PostgreSQL adapter (선택, 영속화용)
   */
  constructor(opts = {}) {
    super();
    this.log = createLogger('MemoryBulletin');

    this.createMessage = opts.createMessage;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 3600000; // 60분
    this.staleThresholdMultiplier = opts.staleThresholdMultiplier ?? 2;
    this.model = opts.model ?? 'claude-haiku-4-5-20251001';
    this.outcomeTracker = opts.outcomeTracker || null;
    this.db = opts.db || null;

    /**
     * v3.9: 키 형식 = "channelId:agentId" (채널별 격리)
     * @type {Map<string, { content: string, tokens: number, generatedAt: number }>}
     */
    this._bulletins = new Map();
    /** @type {Map<string, number>} */
    this._timestamps = new Map();
    /** @type {Map<string, boolean>} */
    this._stale = new Map();
    this._timer = null;
    this._running = false;
    this._compactionEngine = null;

    this.log.info('MemoryBulletin initialized', {
      refreshIntervalMs: this.refreshIntervalMs,
      staleThresholdMultiplier: this.staleThresholdMultiplier,
      model: this.model,
      pgEnabled: !!this.db,
    });
  }

  /** DB adapter 설정 (지연 주입). */
  setDb(db) { this.db = db; }

  /**
   * v3.9: 복합 키 생성 — channelId:agentId
   * @private
   */
  _key(agentId, channelId = '_global') {
    return `${channelId}:${agentId}`;
  }

  /**
   * Register event listener on CompactionEngine's 'compaction:complete' event
   * Triggers bulletin refresh when compaction finishes
   * @param {Object} compactionEngine - CompactionEngine instance with EventEmitter
   */
  listenToCompaction(compactionEngine) {
    try {
      if (!compactionEngine) {
        this.log.warn('listenToCompaction called with null compactionEngine');
        return;
      }

      this._compactionEngine = compactionEngine;

      if (typeof compactionEngine.on === 'function') {
        compactionEngine.on('compaction:complete', (stats) => {
          this._onCompactionComplete(stats);
        });
        this.log.info('CompactionEngine event listener registered');
      } else {
        this.log.warn('compactionEngine does not have event emitter methods');
      }
    } catch (err) {
      this.log.error('Error registering compaction listener', { error: err.message });
    }
  }

  /**
   * Handle compaction completion event — triggers bulletin refresh within 5 seconds
   * @private
   * @param {Object} stats - Compaction statistics from event
   */
  _onCompactionComplete(stats) {
    try {
      this.log.info('Compaction complete, scheduling bulletin refresh', {
        tier: stats.tier,
        removedTurns: stats.removedTurns,
      });

      // Schedule refresh in 5 seconds to allow memory graph to stabilize
      setTimeout(() => {
        this.refreshBulletin();
      }, 5000);
    } catch (err) {
      this.log.error('Error handling compaction completion', { error: err.message });
    }
  }

  /**
   * Refresh bulletin for all registered agents
   * Internal method called by event handlers
   */
  async refreshBulletin() {
    try {
      // v3.9: composite keys are "channelId:agentId"
      const refreshed = new Set();
      for (const key of this._bulletins.keys()) {
        const sepIdx = key.indexOf(':');
        const channelId = key.substring(0, sepIdx);
        const agentId = key.substring(sepIdx + 1);
        const refreshKey = `${channelId}:${agentId}`;
        if (!refreshed.has(refreshKey)) {
          refreshed.add(refreshKey);
          await this.generateBriefing(agentId, channelId);
        }
      }
      this.log.debug('Bulletin refresh completed', { count: refreshed.size });
    } catch (err) {
      this.log.error('Error refreshing bulletin', { error: err.message });
    }
  }

  /**
   * 에이전트의 현재 브리핑 조회 (영점 비용 읽기)
   * Get agent's current briefing (zero-cost read)
   *
   * v3.9: channelId 파라미터 추가 — 채널별 격리된 bulletin 조회.
   * 채널별 bulletin이 없으면 _global 폴백.
   *
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} [channelId='_global'] - 채널 ID (채널별 격리)
   * @returns {Object} { content: string, generatedAt: number, stale: boolean, tokens: number }
   */
  get(agentId, channelId = '_global') {
    try {
      const key = this._key(agentId, channelId);
      let bulletin = this._bulletins.get(key);

      // 채널별 bulletin이 없으면 _global 폴백
      if (!bulletin && channelId !== '_global') {
        const globalKey = this._key(agentId, '_global');
        bulletin = this._bulletins.get(globalKey);
        if (bulletin) {
          const elapsed = Date.now() - (this._timestamps.get(globalKey) || 0);
          const staleThreshold = this.refreshIntervalMs * this.staleThresholdMultiplier;
          return {
            content: bulletin.content,
            generatedAt: this._timestamps.get(globalKey),
            stale: this._stale.get(globalKey) || elapsed > staleThreshold,
            tokens: bulletin.tokens || 0,
          };
        }
      }

      if (!bulletin) {
        return { content: '', generatedAt: null, stale: true, tokens: 0 };
      }

      const elapsed = Date.now() - (this._timestamps.get(key) || 0);
      const staleThreshold = this.refreshIntervalMs * this.staleThresholdMultiplier;
      const stale = this._stale.get(key) || elapsed > staleThreshold;

      return {
        content: bulletin.content,
        generatedAt: this._timestamps.get(key),
        stale,
        tokens: bulletin.tokens || 0
      };
    } catch (err) {
      this.log.error('Error getting bulletin', err);
      return { content: '', generatedAt: null, stale: true, tokens: 0 };
    }
  }

  /**
   * 메모리에서 최근 기억 조회 (LLM 입력 준비)
   * Fetch recent memories from database (prepare LLM input)
   *
   * v3.9: channelId 파라미터 추가 — 채널별 scoped 쿼리.
   * v3.9: 스키마 정합성 수정 — entity_memory/decision_memory → entities/memories.
   *
   * @private
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} [channelId] - 채널 ID (지정 시 해당 채널만 조회)
   * @returns {Promise<Object>} { episodic, semantic, entities, decisions }
   */
  async _fetchRecentMemories(agentId, channelId) {
    try {
      const db = this.db || getAdapter();

      // 채널 필터 조건 생성
      const channelFilter = channelId && channelId !== '_global'
        ? { clause: 'AND channel_id = ?', params: [channelId] }
        : { clause: '', params: [] };

      // L2 에피소드 메모리: 최근 20개 대화 메시지
      const episodic = await db.all(
        `SELECT role, content, created_at FROM episodic_memory
         WHERE 1=1 ${channelFilter.clause}
         ORDER BY created_at DESC LIMIT 20`,
        [...channelFilter.params]
      );

      // L3 의미론적 메모리: 최근 10개 핵심 요약
      const semantic = await db.all(
        `SELECT content, importance, memory_type, created_at FROM semantic_memory
         WHERE archived = false
         ORDER BY importance DESC, created_at DESC LIMIT 10`,
        []
      );

      // L4 엔티티 메모리: entities 테이블에서 최근 15개
      const entities = await db.all(
        `SELECT entity_type, name AS entity_value, properties, last_seen AS created_at
         FROM entities
         ORDER BY last_seen DESC LIMIT 15`,
        []
      );

      // 결정 메모리: memories 테이블의 decision 타입
      const decisions = await db.all(
        `SELECT content, metadata AS context, created_at AS made_at FROM memories
         WHERE type = 'decision' AND archived = false
         ORDER BY created_at DESC LIMIT 5`,
        []
      );

      return { episodic, semantic, entities, decisions };
    } catch (err) {
      this.log.error('Error fetching recent memories', err);
      return { episodic: [], semantic: [], entities: [], decisions: [] };
    }
  }

  /**
   * LLM을 사용하여 메모리 브리핑 생성 (최대 500단어)
   * Generate memory briefing via LLM (max 500 words)
   *
   * v3.9: channelId 파라미터 추가.
   *
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} [channelId='_global'] - 채널 ID
   * @returns {Promise<string>} 생성된 브리핑 / Generated briefing
   */
  async generateBriefing(agentId, channelId = '_global') {
    try {
      // 최근 메모리 조회 (채널 scoped) / Fetch recent memories (channel scoped)
      const memories = await this._fetchRecentMemories(agentId, channelId);

      // 메모리를 텍스트 형식으로 포맷 / Format memories as text
      const memoryText = this._formatMemoriesForLLM(memories);

      // Get outcome summary if available
      let outcomeSummary = '';
      if (this.outcomeTracker) {
        outcomeSummary = this.outcomeTracker.generateOutcomeSummary(agentId);
      }

      if (!this.createMessage) {
        this.log.warn('No createMessage function provided, cannot generate briefing');
        return '';
      }

      // Build briefing prompt with outcome context
      let briefingPrompt = `You are a memory curator for an AI agent. Analyze the following memories and outcomes to generate a concise 500-word briefing that summarizes:
1. Recent conversations and key topics discussed
2. Important entities, people, or concepts mentioned
3. Critical decisions made or tasks completed
4. Patterns, preferences, or important context about the user
5. Outstanding questions or follow-ups needed
6. Recent execution performance and reliability patterns

Format the briefing as clear paragraphs suitable for injection into a system prompt.

RECENT MEMORIES:
${memoryText}`;

      if (outcomeSummary) {
        briefingPrompt += `\n\nRECENT EXECUTION OUTCOMES:\n${outcomeSummary}`;
      }

      briefingPrompt += '\n\nBRIEFING (approx 500 words):';

      // LLM 호출: 500단어 브리핑 생성 / Call LLM: generate 500-word briefing
      const response = await this.createMessage({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: briefingPrompt
          }
        ]
      });

      // 응답에서 텍스트 추출 / Extract text from response
      let briefingContent = '';
      if (response.content && Array.isArray(response.content)) {
        briefingContent = response.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n');
      }

      const tokenCount = response.usage?.output_tokens || 0;

      this._swap(agentId, briefingContent, tokenCount, channelId);
      this.emit('bulletin:refreshed', { agentId, channelId, tokens: tokenCount, timestamp: Date.now() });

      this.log.info('Briefing generated', {
        agentId,
        contentLength: briefingContent.length,
        tokens: tokenCount
      });

      return briefingContent;
    } catch (err) {
      this.log.error('Error generating briefing', err);
      return '';
    }
  }

  /**
   * Apply exponential time decay and outcome-weighted importance to memories
   * Newer memories and important outcomes receive higher weights
   * @private
   * @param {Array<Object>} memories - Array of memory objects
   * @returns {Array<Object>} Weighted and sorted memories
   */
  _applyDecayWeighting(memories) {
    try {
      const now = Date.now();
      const decayHalfLifeMs = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

      // Get outcome weights if available
      let weights = { successWeight: 1.0, errorWeight: 1.5, retryWeight: 1.2 };
      if (this.outcomeTracker) {
        weights = this.outcomeTracker.getOutcomeWeights();
      }

      // Apply decay to each memory
      const weighted = memories.map(memory => {
        let weight = 1.0;

        // Time decay: exponential decay based on age
        if (memory.created_at || memory.timestamp) {
          const age = now - (new Date(memory.created_at || memory.timestamp).getTime());
          const decayFactor = Math.exp(-age / decayHalfLifeMs);
          weight *= decayFactor;
        }

        // Outcome-weighted importance
        if (memory.type === 'error' || memory.importance > 0.7) {
          weight *= weights.errorWeight;
        } else if (memory.importance > 0.5) {
          weight *= weights.retryWeight;
        } else {
          weight *= weights.successWeight;
        }

        return {
          ...memory,
          _weight: weight,
        };
      });

      // Sort by weight (descending)
      return weighted.sort((a, b) => (b._weight || 0) - (a._weight || 0));
    } catch (err) {
      this.log.error('Error applying decay weighting', { error: err.message });
      return memories;
    }
  }

  /**
   * 메모리를 LLM 입력용 텍스트로 포맷
   * Format memories as text for LLM input
   *
   * @private
   * @param {Object} memories - 메모리 객체 / Memories object
   * @returns {string}
   */
  _formatMemoriesForLLM(memories) {
    const lines = [];

    if (memories.episodic && memories.episodic.length > 0) {
      lines.push('## Recent Conversations:');
      for (const msg of memories.episodic) {
        lines.push(`[${msg.role}] ${(msg.content || '').substring(0, 200)}`);
      }
      lines.push('');
    }

    if (memories.semantic && memories.semantic.length > 0) {
      lines.push('## Key Semantic Memories:');
      for (const mem of memories.semantic) {
        lines.push(`- ${mem.content} (importance: ${mem.importance})`);
      }
      lines.push('');
    }

    if (memories.entities && memories.entities.length > 0) {
      lines.push('## Important Entities:');
      for (const ent of memories.entities) {
        lines.push(`- [${ent.entity_type}] ${ent.entity_value} (frequency: ${ent.frequency})`);
      }
      lines.push('');
    }

    if (memories.decisions && memories.decisions.length > 0) {
      lines.push('## Recent Decisions:');
      for (const dec of memories.decisions) {
        lines.push(`- ${dec.content}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 브리핑을 시스템 프롬프트에 주입
   * Inject briefing into system prompt
   *
   * v3.9: channelId 파라미터 추가.
   *
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} systemPrompt - 기존 시스템 프롬프트 / Existing system prompt
   * @param {string} [channelId='_global'] - 채널 ID
   * @returns {string} 브리핑이 추가된 프롬프트 / Prompt with briefing appended
   */
  injectIntoPrompt(agentId, systemPrompt, channelId = '_global') {
    try {
      const bulletin = this.get(agentId, channelId);

      if (!bulletin.content) {
        return systemPrompt;
      }

      const separator = '\n\n---\n\n';
      const briefingSection = `## MEMORY BRIEFING\nThe following is a curated summary of relevant memories and context:\n\n${bulletin.content}`;

      return systemPrompt + separator + briefingSection;
    } catch (err) {
      this.log.error('Error injecting briefing into prompt', err);
      return systemPrompt;
    }
  }

  /**
   * 주기적 갱신 시작
   * Start periodic refresh timer
   *
   * @param {string[]} agentIds - 갱신할 에이전트 ID 배열 / Agent IDs to refresh
   */
  start(agentIds = []) {
    try {
      if (this._running) {
        this.log.warn('Auto-refresh already running');
        return;
      }

      if (this._timer) {
        clearInterval(this._timer);
      }

      this._running = true;
      this.log.info('Starting auto-refresh', {
        agentCount: agentIds.length,
        intervalMs: this.refreshIntervalMs
      });

      // 주기적 갱신 타이머 / Periodic refresh timer
      this._timer = setInterval(async () => {
        for (const agentId of agentIds) {
          try {
            await this.generateBriefing(agentId);
          } catch (err) {
            this.log.error('Error in auto-refresh cycle', err);
          }
        }
      }, this.refreshIntervalMs);

      // 초기 갱신 (비동기) / Initial refresh (async, fire-and-forget)
      for (const agentId of agentIds) {
        this.generateBriefing(agentId).catch(err =>
          this.log.error('Error in initial refresh', err)
        );
      }
    } catch (err) {
      this.log.error('Error starting auto-refresh', err);
    }
  }

  /**
   * 주기적 갱신 중지
   * Stop periodic refresh timer
   */
  stop() {
    try {
      if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
      }
      this._running = false;
      this.log.info('Auto-refresh stopped');
    } catch (err) {
      this.log.error('Error stopping auto-refresh', err);
    }
  }

  /**
   * 브리핑 원자적 교체 (스냅샷 동결) + PG 영속화.
   * Atomic bulletin swap (snapshot freeze) + PG persistence.
   *
   * @private
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} content - 새 브리핑 콘텐츠 / New briefing content
   * @param {number} tokens - 토큰 수 / Token count
   * @param {string} [channelId='_global'] - 채널 ID
   */
  _swap(agentId, content, tokens = 0, channelId = '_global') {
    try {
      const key = this._key(agentId, channelId);
      const bulletin = Object.freeze({
        content,
        tokens,
        length: content.length,
        version: 1
      });

      this._bulletins.set(key, bulletin);
      this._timestamps.set(key, Date.now());
      this._stale.set(key, false);

      // PG 영속화 (비동기, 실패해도 무시)
      this._persistToDb(agentId, channelId, content, tokens).catch(() => {});

      this.log.debug('Bulletin swapped', {
        agentId,
        channelId,
        contentLength: content.length,
        tokens
      });
    } catch (err) {
      this.log.error('Error swapping bulletin', err);
    }
  }

  /**
   * PostgreSQL에 bulletin 저장 (UPSERT).
   * @private
   */
  async _persistToDb(agentId, channelId, content, tokens) {
    if (!this.db) return;
    try {
      await this.db.run(
        `INSERT INTO bulletins (agent_id, channel_id, content, tokens, generated_at)
         VALUES (?, ?, ?, ?, NOW())
         ON CONFLICT (agent_id, channel_id)
         DO UPDATE SET content = EXCLUDED.content, tokens = EXCLUDED.tokens, generated_at = NOW()`,
        [agentId, channelId, content, tokens]
      );
    } catch (err) {
      this.log.debug('Bulletin PG persist failed (non-critical)', { error: err.message });
    }
  }

  /**
   * PostgreSQL에서 bulletin 복원 (프로세스 재시작 시).
   * @param {string} [agentId] - 특정 에이전트만 복원. 생략 시 전체.
   */
  async restoreFromDb(agentId) {
    if (!this.db) return;
    try {
      const filter = agentId ? 'WHERE agent_id = ?' : '';
      const params = agentId ? [agentId] : [];
      const rows = await this.db.all(
        `SELECT agent_id, channel_id, content, tokens, generated_at FROM bulletins ${filter}`,
        params
      );
      for (const row of rows) {
        const key = this._key(row.agent_id, row.channel_id);
        this._bulletins.set(key, Object.freeze({
          content: row.content,
          tokens: row.tokens,
          length: row.content.length,
          version: 1,
        }));
        this._timestamps.set(key, new Date(row.generated_at).getTime());
        this._stale.set(key, false);
      }
      this.log.info('Bulletins restored from PG', { count: rows.length });
    } catch (err) {
      this.log.warn('Bulletin PG restore failed', { error: err.message });
    }
  }

  /**
   * 특정 에이전트의 캐시 비우기
   * Clear cache for specific agent (all channels)
   *
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} [channelId] - 특정 채널만 삭제. 생략 시 해당 에이전트 전체.
   */
  clear(agentId, channelId) {
    try {
      if (channelId) {
        const key = this._key(agentId, channelId);
        this._bulletins.delete(key);
        this._timestamps.delete(key);
        this._stale.delete(key);
      } else {
        // 해당 에이전트의 모든 채널 bulletin 삭제
        for (const key of [...this._bulletins.keys()]) {
          if (key.endsWith(`:${agentId}`)) {
            this._bulletins.delete(key);
            this._timestamps.delete(key);
            this._stale.delete(key);
          }
        }
      }
      this.log.debug('Bulletin cleared', { agentId, channelId });
    } catch (err) {
      this.log.error('Error clearing bulletin', err);
    }
  }

  /**
   * 모든 캐시 비우기
   * Clear all bulletins
   */
  clearAll() {
    try {
      this._bulletins.clear();
      this._timestamps.clear();
      this._stale.clear();
      this.log.info('All bulletins cleared');
    } catch (err) {
      this.log.error('Error clearing all bulletins', err);
    }
  }

  /**
   * 캐시 통계 조회
   * Get cache statistics
   *
   * @returns {Object} 통계 / Statistics
   */
  stats() {
    try {
      const staleCount = Array.from(this._timestamps.entries()).filter(
        ([agentId, ts]) => {
          const elapsed = Date.now() - ts;
          const threshold = this.refreshIntervalMs * this.staleThresholdMultiplier;
          return elapsed > threshold || this._stale.get(agentId);
        }
      ).length;

      const totalTokens = Array.from(this._bulletins.values())
        .reduce((sum, b) => sum + (b.tokens || 0), 0);

      return {
        totalBulletins: this._bulletins.size,
        staleCount,
        totalTokens,
        refreshIntervalMs: this.refreshIntervalMs,
        isRunning: this._running
      };
    } catch (err) {
      this.log.error('Error computing stats', err);
      return {
        totalBulletins: 0,
        staleCount: 0,
        totalTokens: 0,
        refreshIntervalMs: this.refreshIntervalMs,
        isRunning: false
      };
    }
  }
}

module.exports = { MemoryBulletin };
