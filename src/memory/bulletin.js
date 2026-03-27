/**
 * Memory Bulletin — LLM이 큐레이팅하는 메모리 브리핑 시스템.
 * SpaceBot Cortex 패턴: 주기적으로 전체 메모리를 LLM으로 요약한
 * 500단어 브리핑을 모든 채널의 시스템 프롬프트에 주입.
 *
 * Memory Bulletin - LLM-curated memory briefing system.
 * SpaceBot Cortex pattern: periodically summarizes all memory via LLM
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
   * @param {Object} opts - 옵션 / Options
   * @param {Function} opts.createMessage - LLM 호출 함수 (Anthropic createMessage) / LLM call function
   * @param {number} [opts.refreshIntervalMs] - 갱신 간격 (기본값 3600000ms = 60분) / Refresh interval (default 60min)
   * @param {number} [opts.staleThresholdMultiplier] - 보관함 사용 불가 임계값 (기본값 2x refreshInterval) / Staleness threshold multiplier
   * @param {string} [opts.model] - LLM 모델 (기본값 'claude-haiku-4-5-20251001') / LLM model
   */
  constructor(opts = {}) {
    super();
    this.log = createLogger('MemoryBulletin');

    this.createMessage = opts.createMessage;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 3600000; // 60분
    this.staleThresholdMultiplier = opts.staleThresholdMultiplier ?? 2;
    this.model = opts.model ?? 'claude-haiku-4-5-20251001';

    /** @type {Map<string, { content: string, tokens: number, generatedAt: number }>} */
    this._bulletins = new Map();
    /** @type {Map<string, number>} */
    this._timestamps = new Map();
    /** @type {Map<string, boolean>} */
    this._stale = new Map();
    this._timer = null;
    this._running = false;

    this.log.info('MemoryBulletin initialized', {
      refreshIntervalMs: this.refreshIntervalMs,
      staleThresholdMultiplier: this.staleThresholdMultiplier,
      model: this.model
    });
  }

  /**
   * 에이전트의 현재 브리핑 조회 (영점 비용 읽기)
   * Get agent's current briefing (zero-cost read)
   *
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @returns {Object} { content: string, generatedAt: number, stale: boolean, tokens: number }
   */
  get(agentId) {
    try {
      const bulletin = this._bulletins.get(agentId);

      if (!bulletin) {
        return {
          content: '',
          generatedAt: null,
          stale: true,
          tokens: 0
        };
      }

      // 보관함 나이 계산 / Calculate bulletin age
      const elapsed = Date.now() - (this._timestamps.get(agentId) || 0);
      const staleThreshold = this.refreshIntervalMs * this.staleThresholdMultiplier;
      const stale = this._stale.get(agentId) || elapsed > staleThreshold;

      return {
        content: Object.freeze(bulletin.content),
        generatedAt: this._timestamps.get(agentId),
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
   * @private
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @returns {Promise<Object>} { episodic, semantic, entities, decisions }
   */
  async _fetchRecentMemories(agentId) {
    try {
      const db = getAdapter();

      // 에피소드 메모리: 최근 20개 대화 메시지
      // Episodic: last 20 conversation messages
      const episodic = await db.all(
        `SELECT role, content, created_at FROM episodic_memory
         WHERE agent_type = 'agent' LIMIT 20`,
        []
      );

      // 의미론적 메모리: 최근 10개 핵심 요약
      // Semantic: last 10 key summaries
      const semantic = await db.all(
        `SELECT content, importance, created_at FROM semantic_memory
         ORDER BY created_at DESC LIMIT 10`,
        []
      );

      // 엔티티 메모리: 최근 활동 엔티티 15개
      // Entities: 15 most recent active entities
      const entities = await db.all(
        `SELECT entity_type, entity_value, frequency, created_at
         FROM entity_memory
         ORDER BY frequency DESC, created_at DESC LIMIT 15`,
        []
      );

      // 결정 메모리: 최근 의사결정 5개
      // Decisions: last 5 decisions made
      const decisions = await db.all(
        `SELECT content, context, made_at FROM decision_memory
         ORDER BY made_at DESC LIMIT 5`,
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
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @returns {Promise<string>} 생성된 브리핑 / Generated briefing
   */
  async generateBriefing(agentId) {
    try {
      // 최근 메모리 조회 / Fetch recent memories
      const memories = await this._fetchRecentMemories(agentId);

      // 메모리를 텍스트 형식으로 포맷 / Format memories as text
      const memoryText = this._formatMemoriesForLLM(memories);

      if (!this.createMessage) {
        this.log.warn('No createMessage function provided, cannot generate briefing');
        return '';
      }

      // LLM 호출: 500단어 브리핑 생성 / Call LLM: generate 500-word briefing
      const response = await this.createMessage({
        model: this.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `You are a memory curator for an AI agent. Analyze the following memories and generate a concise 500-word briefing that summarizes:
1. Recent conversations and key topics discussed
2. Important entities, people, or concepts mentioned
3. Critical decisions made or tasks completed
4. Patterns, preferences, or important context about the user
5. Outstanding questions or follow-ups needed

Format the briefing as clear paragraphs suitable for injection into a system prompt.

RECENT MEMORIES:
${memoryText}

BRIEFING (approx 500 words):`
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

      this._swap(agentId, briefingContent, tokenCount);
      this.emit('bulletin:refreshed', { agentId, tokens: tokenCount, timestamp: Date.now() });

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
        lines.push(`[${msg.role}] ${msg.content.substring(0, 200)}`);
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
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} systemPrompt - 기존 시스템 프롬프트 / Existing system prompt
   * @returns {string} 브리핑이 추가된 프롬프트 / Prompt with briefing appended
   */
  injectIntoPrompt(agentId, systemPrompt) {
    try {
      const bulletin = this.get(agentId);

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
   * 브리핑 원자적 교체 (스냅샷 동결)
   * Atomic bulletin swap (snapshot freeze)
   *
   * @private
   * @param {string} agentId - 에이전트 ID / Agent ID
   * @param {string} content - 새 브리핑 콘텐츠 / New briefing content
   * @param {number} tokens - 토큰 수 / Token count
   */
  _swap(agentId, content, tokens = 0) {
    try {
      const bulletin = Object.freeze({
        content,
        tokens,
        length: content.length,
        version: 1
      });

      this._bulletins.set(agentId, bulletin);
      this._timestamps.set(agentId, Date.now());
      this._stale.set(agentId, false);

      this.log.debug('Bulletin swapped', {
        agentId,
        contentLength: content.length,
        tokens
      });
    } catch (err) {
      this.log.error('Error swapping bulletin', err);
    }
  }

  /**
   * 특정 에이전트의 캐시 비우기
   * Clear cache for specific agent
   *
   * @param {string} agentId - 에이전트 ID / Agent ID
   */
  clear(agentId) {
    try {
      this._bulletins.delete(agentId);
      this._timestamps.delete(agentId);
      this._stale.delete(agentId);
      this.log.debug('Bulletin cleared', { agentId });
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
