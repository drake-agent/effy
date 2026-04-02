/**
 * unified-query.js — 통합 정보 검색 API.
 *
 * 4개 메모리 레이어(L1~L4) + ContextHub + 팀 에이전트를
 * 단일 인터페이스로 검색하고 결과를 통합 정렬한다.
 *
 * 사용 예:
 *   const uq = new UnifiedMemoryQuery({ search, manager, chub, agentBus, teamRegistry });
 *   const results = await uq.query('마케팅팀 Q1 일정', {
 *     scope: ['memory', 'knowledge', 'agents'],
 *     channelId: 'C123',
 *     limit: 10,
 *   });
 *
 * 결과 형식:
 *   [{ content, source, sourceType, relevance, metadata }]
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:unified-query');

/**
 * @typedef {Object} QueryResult
 * @property {string} content - 검색 결과 내용
 * @property {string} source - 출처 식별자 (예: 'episodic', 'semantic:team', 'agent:ops', 'chub:doc-123')
 * @property {string} sourceType - 'memory'|'knowledge'|'agent'|'entity'
 * @property {number} relevance - 0.0~1.0 정규화된 관련도 점수
 * @property {Object} metadata - 추가 메타데이터 (날짜, 작성자, 채널 등)
 */

class UnifiedMemoryQuery {
  /**
   * @param {Object} deps - 의존성 주입
   * @param {Object} deps.search - MemorySearch 인스턴스 (FTS5 검색)
   * @param {Object} [deps.manager] - MemoryManager 인스턴스 (L2 episodic, L3 semantic, L4 entity)
   * @param {Object} [deps.chub] - ContextHub 어댑터
   * @param {Object} [deps.agentBus] - AgentBus 인스턴스 (에이전트 간 질문)
   * @param {Object} [deps.teamRegistry] - TeamRegistry 인스턴스 (에이전트 발견)
   */
  constructor(deps = {}) {
    this.search = deps.search || null;
    this.manager = deps.manager || null;
    this.chub = deps.chub || null;
    this.agentBus = deps.agentBus || null;
    this.teamRegistry = deps.teamRegistry || null;

    this._stats = {
      queries: 0,
      totalResults: 0,
      avgLatency: 0,
      sourceHits: { memory: 0, knowledge: 0, agent: 0, entity: 0 },
    };
  }

  /**
   * 통합 검색 실행.
   *
   * @param {string} query - 검색 쿼리
   * @param {Object} [opts]
   * @param {string[]} [opts.scope=['memory','knowledge','agents']] - 검색 범위
   * @param {string} [opts.channelId] - 채널 격리 (지정 시 해당 채널만)
   * @param {string} [opts.userId] - 유저 컨텍스트
   * @param {number} [opts.limit=10] - 최종 결과 수
   * @param {string[]} [opts.memoryPools] - semantic memory 접근 풀
   * @param {string} [opts.fromAgent] - 요청 에이전트 ID (agent scope 사용 시)
   * @param {number} [opts.askDepth=0] - 에이전트 ask 깊이
   * @returns {Promise<{ results: QueryResult[], searchTime: number, sources: Object }>}
   */
  async query(query, opts = {}) {
    const {
      scope = ['memory', 'knowledge', 'agents'],
      channelId,
      userId,
      limit = 10,
      memoryPools = ['team'],
      fromAgent = 'system',
      askDepth = 0,
    } = opts;

    const startTime = Date.now();
    this._stats.queries++;

    const allResults = [];
    const sources = {};

    // 병렬 실행 — 각 소스 독립적으로 검색
    const tasks = [];

    if (scope.includes('memory') && this.search) {
      tasks.push(
        this._searchMemory(query, { channelId, userId, memoryPools, limit })
          .then(results => { allResults.push(...results); sources.memory = results.length; })
          .catch(err => { log.warn('Memory search failed', { error: err.message }); sources.memory = 0; })
      );
    }

    if (scope.includes('knowledge') && this.chub) {
      tasks.push(
        this._searchKnowledge(query, { limit })
          .then(results => { allResults.push(...results); sources.knowledge = results.length; })
          .catch(err => { log.warn('Knowledge search failed', { error: err.message }); sources.knowledge = 0; })
      );
    }

    if (scope.includes('agents') && this.agentBus && this.teamRegistry) {
      tasks.push(
        this._askAgents(query, { fromAgent, askDepth, limit: 3 })
          .then(results => { allResults.push(...results); sources.agents = results.length; })
          .catch(err => { log.warn('Agent query failed', { error: err.message }); sources.agents = 0; })
      );
    }

    if (scope.includes('entity') && this.manager) {
      tasks.push(
        this._searchEntities(query, { limit: 5 })
          .then(results => { allResults.push(...results); sources.entity = results.length; })
          .catch(err => { log.warn('Entity search failed', { error: err.message }); sources.entity = 0; })
      );
    }

    await Promise.allSettled(tasks);

    // 중복 제거 + 관련도 정렬
    const deduplicated = this._deduplicateResults(allResults);
    const sorted = deduplicated
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, limit);

    const searchTime = Date.now() - startTime;

    // 통계 업데이트
    this._stats.totalResults += sorted.length;
    this._stats.avgLatency = Math.round(
      (this._stats.avgLatency * (this._stats.queries - 1) + searchTime) / this._stats.queries
    );
    for (const r of sorted) {
      if (this._stats.sourceHits[r.sourceType] !== undefined) {
        this._stats.sourceHits[r.sourceType]++;
      }
    }

    log.info('Unified query completed', {
      query: query.substring(0, 50),
      results: sorted.length,
      sources,
      searchTime,
    });

    return { results: sorted, searchTime, sources };
  }

  // ─── Private: 각 소스별 검색 ───

  /**
   * L2/L3 메모리 검색 — FTS5 + semantic pool
   * @private
   */
  async _searchMemory(query, { channelId, userId, memoryPools, limit }) {
    const results = [];

    // FTS5 하이브리드 검색 (memories_fts)
    try {
      const { results: ftsResults } = this.search.search(query, {
        sourceChannel: channelId,
        sourceUser: userId,
        limit,
      });

      for (const r of ftsResults) {
        results.push({
          content: r.content,
          source: `memory:${r.type}`,
          sourceType: 'memory',
          relevance: Math.min(1.0, r.importance * 0.6 + 0.4), // importance 기반 정규화
          metadata: {
            type: r.type,
            channel: r.sourceChannel,
            user: r.sourceUser,
            createdAt: r.createdAt,
          },
        });
      }
    } catch (err) {
      log.debug('FTS search fallback', { error: err.message });
    }

    // L3 semantic pool 검색 (별도 테이블)
    if (this.manager?.semantic?.searchWithPools) {
      try {
        const semanticResults = await this.manager.semantic.searchWithPools(query, memoryPools, limit);
        for (const r of (semanticResults || [])) {
          // FTS 결과와 중복 가능 — dedup에서 처리
          results.push({
            content: r.content,
            source: `semantic:${r.pool_id || 'team'}`,
            sourceType: 'memory',
            relevance: Math.min(1.0, (r.importance || 0.5) * 0.5 + 0.3),
            metadata: {
              pool: r.pool_id,
              type: r.type || r.memory_type,
              createdAt: r.created_at,
            },
          });
        }
      } catch (err) {
        log.debug('Semantic pool search failed', { error: err.message });
      }
    }

    return results;
  }

  /**
   * ContextHub 문서 검색
   * @private
   */
  async _searchKnowledge(query, { limit }) {
    const results = [];

    try {
      const docs = await this.chub.searchDocs(query, { limit });
      for (const doc of (docs || [])) {
        results.push({
          content: doc.snippet || doc.content || doc.title,
          source: `chub:${doc.id || doc.slug || 'unknown'}`,
          sourceType: 'knowledge',
          relevance: Math.min(1.0, (doc.score || 0.5) * 0.7 + 0.2),
          metadata: {
            title: doc.title,
            tags: doc.tags,
            url: doc.url,
          },
        });
      }
    } catch (err) {
      log.debug('ContextHub search failed', { error: err.message });
    }

    return results;
  }

  /**
   * 팀 에이전트에 직접 질문
   * @private
   */
  async _askAgents(query, { fromAgent, askDepth, limit }) {
    const results = [];

    if (!this.teamRegistry || !this.agentBus) return results;

    // 주제에 맞는 에이전트 자동 발견
    const candidates = this.teamRegistry.findByTopic(query);
    const topAgents = candidates
      .filter(c => c.agentId !== fromAgent) // 자기 자신 제외
      .slice(0, limit);

    if (topAgents.length === 0) return results;

    log.debug('Asking team agents', {
      query: query.substring(0, 50),
      agents: topAgents.map(a => a.agentId),
    });

    // 병렬 질문
    const askResults = await Promise.allSettled(
      topAgents.map(agent =>
        this.agentBus.ask(fromAgent, agent.agentId, query, {
          timeoutMs: 15000,
          depth: askDepth,
        })
      )
    );

    for (let i = 0; i < askResults.length; i++) {
      const r = askResults[i];
      if (r.status === 'fulfilled' && r.value.success && r.value.response) {
        const agent = topAgents[i];
        results.push({
          content: r.value.response,
          source: `agent:${agent.agentId}`,
          sourceType: 'agent',
          relevance: Math.min(1.0, (agent.score / 10) + 0.5), // topic score 기반
          metadata: {
            agentId: agent.agentId,
            matchedOn: agent.matchedOn,
          },
        });
      }
    }

    return results;
  }

  /**
   * L4 엔티티 검색
   * @private
   */
  async _searchEntities(query, { limit }) {
    const results = [];

    if (!this.manager?.entity) return results;

    try {
      // 엔티티 이름으로 직접 검색 시도
      const words = query.split(/\s+/).filter(w => w.length > 1);
      for (const word of words.slice(0, 3)) { // 상위 3단어만
        const entities = this.manager.entity.list
          ? this.manager.entity.list({ search: word, limit: 3 })
          : [];

        for (const entity of entities) {
          const props = typeof entity.properties === 'string'
            ? JSON.parse(entity.properties)
            : (entity.properties || {});

          results.push({
            content: `${entity.entity_type}: ${entity.name} — ${JSON.stringify(props).substring(0, 200)}`,
            source: `entity:${entity.entity_type}:${entity.entity_id}`,
            sourceType: 'entity',
            relevance: 0.6,
            metadata: {
              entityType: entity.entity_type,
              entityId: entity.entity_id,
              name: entity.name,
              lastSeen: entity.last_seen,
            },
          });
        }
      }
    } catch (err) {
      log.debug('Entity search failed', { error: err.message });
    }

    return results;
  }

  // ─── Utilities ───

  /**
   * 내용 유사도 기반 중복 제거.
   * @private
   */
  _deduplicateResults(results) {
    const seen = new Map(); // content prefix → best result

    for (const r of results) {
      // 앞 100자를 기준으로 중복 판단
      const key = (r.content || '').substring(0, 100).toLowerCase().trim();
      if (!key) continue;

      const existing = seen.get(key);
      if (!existing || r.relevance > existing.relevance) {
        seen.set(key, r);
      }
    }

    return Array.from(seen.values());
  }

  /**
   * @returns {Object} 통계
   */
  getStats() {
    return { ...this._stats };
  }
}

module.exports = { UnifiedMemoryQuery };
