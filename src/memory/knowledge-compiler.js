/**
 * knowledge-compiler.js — Topic Article Compiler.
 *
 * Karpathy KB 패턴 적용: 원자적 메모리 조각(L3 semantic)을
 * 주제별 종합 문서(Article)로 컴파일하는 백그라운드 엔진.
 *
 * 파이프라인:
 * 1. L4 entity에서 weight ≥ threshold인 hot topic 수집
 * 2. 각 topic에 대해 L3에서 관련 메모리 FTS5 검색
 * 3. 기존 article 유무 확인 → 신규 생성 or 업데이트
 * 4. Haiku로 종합 article 생성/갱신
 * 5. L3 저장 (memoryType: 'Article', sourceType: 'compiled_article')
 *
 * 타이머 기반 주기적 실행 — Cortex에서 start()로 활성화.
 */
const { config } = require('../config');
const { semantic, entity } = require('./manager');
const { createLogger } = require('../shared/logger');

const log = createLogger('knowledge-compiler');

// Lazy-load anthropic client (avoid circular deps)
let _anthropicClient = null;
function _getClient() {
  if (_anthropicClient) return _anthropicClient;
  try {
    const { client } = require('../shared/anthropic');
    _anthropicClient = client;
    return client;
  } catch { return null; }
}

class KnowledgeCompiler {
  /**
   * @param {Object} opts
   * @param {Object} [opts.config] - compiler 설정
   */
  constructor(opts = {}) {
    const compilerConfig = opts.config || config.knowledgeCompiler || {};

    this.enabled = compilerConfig.enabled !== false;
    this.intervalMs = compilerConfig.intervalMs || 21600000;           // 6 hours
    this.topicWeightThreshold = compilerConfig.topicWeightThreshold || 3.0;
    this.minMemoriesForArticle = compilerConfig.minMemoriesForArticle || 5;
    this.maxArticlesPerRun = compilerConfig.maxArticlesPerRun || 5;
    this.maxArticleLength = compilerConfig.maxArticleLength || 5000;
    this.model = compilerConfig.model || 'claude-haiku-4-5-20251001';

    /** @type {string[]} - Knowledge gap detection에서 우선 컴파일할 topic */
    this._priorityTopics = [];

    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
    this._running = false;
  }

  /**
   * 컴파일러 시작 — 주기적 실행 활성화.
   */
  start() {
    if (!this.enabled || this._running) return;
    this._running = true;

    log.info('Knowledge Compiler started', {
      interval: `${this.intervalMs / 3600000}h`,
      topicThreshold: this.topicWeightThreshold,
      maxPerRun: this.maxArticlesPerRun,
    });

    this._timer = setInterval(() => this.compile().catch(err =>
      log.error('Knowledge compilation failed', { error: err.message })
    ), this.intervalMs);

    // First run after 30s
    setTimeout(() => this.compile().catch(() => {}), 30000);
  }

  /**
   * 컴파일러 중지.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    log.info('Knowledge Compiler stopped');
  }

  /**
   * Knowledge gap에서 우선 컴파일할 topic 설정.
   * @param {string[]} topics
   */
  setPriorityTopics(topics) {
    this._priorityTopics = topics || [];
  }

  /**
   * 메인 컴파일 사이클.
   * @returns {Promise<{ compiled: number, updated: number, skipped: number }>}
   */
  async compile() {
    const client = _getClient();
    if (!client) {
      log.warn('Anthropic client not available, skipping compilation');
      return { compiled: 0, updated: 0, skipped: 0 };
    }

    let compiled = 0, updated = 0, skipped = 0;

    try {
      // Step 1: Collect hot topics from L4 entity
      const hotTopics = await this._getHotTopics();
      if (hotTopics.length === 0) {
        log.debug('No hot topics found for compilation');
        return { compiled: 0, updated: 0, skipped: 0 };
      }

      // Prioritize gap topics first
      const orderedTopics = this._orderByPriority(hotTopics);

      // Step 2-5: Compile each topic (up to maxArticlesPerRun)
      for (const topic of orderedTopics.slice(0, this.maxArticlesPerRun)) {
        try {
          const result = await this._compileTopic(topic, client);
          if (result === 'compiled') compiled++;
          else if (result === 'updated') updated++;
          else skipped++;
        } catch (err) {
          log.warn('Topic compilation failed', { topic: topic.name, error: err.message });
          skipped++;
        }
      }

      log.info('Knowledge compilation complete', { compiled, updated, skipped, topicsChecked: orderedTopics.length });
    } catch (err) {
      log.error('Compilation cycle error', { error: err.message });
    }

    return { compiled, updated, skipped };
  }

  /**
   * L4에서 weight ≥ threshold인 topic 수집.
   * @private
   * @returns {Promise<Array<{ name: string, weight: number }>>}
   */
  async _getHotTopics() {
    try {
      const topics = await entity.list('topic', 100);
      if (!topics || !Array.isArray(topics)) return [];

      const weighted = [];
      for (const t of topics) {
        const weight = await entity.getTopicWeight(t.entity_id);
        if (weight >= this.topicWeightThreshold) {
          weighted.push({ name: t.entity_id, displayName: t.name, weight });
        }
      }

      return weighted.sort((a, b) => b.weight - a.weight);
    } catch (err) {
      log.warn('Failed to get hot topics', { error: err.message });
      return [];
    }
  }

  /**
   * Priority topics (gap detection)을 앞으로 정렬.
   * @private
   */
  _orderByPriority(topics) {
    const prioritySet = new Set(this._priorityTopics);
    return [...topics].sort((a, b) => {
      const aPriority = prioritySet.has(a.name) ? 1 : 0;
      const bPriority = prioritySet.has(b.name) ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return b.weight - a.weight;
    });
  }

  /**
   * 단일 topic 컴파일.
   * @private
   * @returns {Promise<'compiled'|'updated'|'skipped'>}
   */
  async _compileTopic(topic, client) {
    // Step 2: Search related memories in L3
    const memories = await semantic.searchWithPools(topic.name, ['team', 'shared', 'reflection'], 30);
    if (!memories || memories.length < this.minMemoriesForArticle) {
      return 'skipped';
    }

    // Step 3: Check for existing article
    const existingArticle = await this._findExistingArticle(topic.name);

    if (existingArticle) {
      // Find memories newer than article
      const articleDate = new Date(existingArticle.created_at || existingArticle.last_accessed || 0);
      const newMemories = memories.filter(m => {
        const memDate = new Date(m.created_at || 0);
        return memDate > articleDate;
      });

      if (newMemories.length < 2) {
        return 'skipped'; // Not enough new info to justify update
      }

      // Step 5: Update existing article
      const updatedContent = await this._updateArticle(existingArticle, newMemories, topic, client);
      if (updatedContent) {
        await this._saveArticle(topic, updatedContent, 'update');
        return 'updated';
      }
      return 'skipped';
    }

    // Step 4: Generate new article
    const articleContent = await this._generateArticle(memories, topic, client);
    if (articleContent) {
      await this._saveArticle(topic, articleContent, 'new');
      // Step 7: Link article to topic entity
      try {
        await entity.addRelationship('topic', topic.name, 'topic', topic.name, 'has_article', {
          compiledAt: new Date().toISOString(),
        });
      } catch { /* best-effort */ }
      return 'compiled';
    }

    return 'skipped';
  }

  /**
   * L3에서 기존 article 검색.
   * @private
   */
  async _findExistingArticle(topicName) {
    try {
      const { getDb } = require('../db');
      const db = getDb();
      const row = await db.prepare(
        `SELECT * FROM semantic_memory
         WHERE memory_type = 'Article' AND source_type = 'compiled_article'
           AND tags LIKE ? AND archived = 0
         ORDER BY created_at DESC LIMIT 1`
      ).get(`%${topicName}%`);
      return row || null;
    } catch {
      return null;
    }
  }

  /**
   * 새 article 생성 (Haiku).
   * @private
   */
  async _generateArticle(memories, topic, client) {
    const memoryText = memories
      .map((m, i) => `[${i + 1}] (${m.source_type || 'unknown'}) ${m.content}`)
      .join('\n')
      .slice(0, 8000);

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 2000,
        system: [
          '당신은 팀의 지식 관리자입니다.',
          '주어진 메모리 조각들을 종합하여 하나의 완성된 지식 문서(article)를 작성하세요.',
          '',
          '규칙:',
          '- 한국어로 작성',
          '- 제목을 먼저, 그 다음 핵심 요약 (2-3문장)',
          '- 세부 내용을 섹션별로 정리',
          '- 결정사항은 명확히 표시',
          '- 미해결 사항이 있으면 별도 섹션으로',
          '- 최대 5000자',
          '- 마크다운 형식 사용하지 마세요. 순수 텍스트로 작성하세요.',
        ].join('\n'),
        messages: [{
          role: 'user',
          content: `"${topic.displayName || topic.name}" 주제에 대한 다음 ${memories.length}개의 메모리를 종합 문서로 컴파일하세요:\n\n${memoryText}`,
        }],
      });

      const text = response.content?.[0]?.text || '';
      return text.slice(0, this.maxArticleLength) || null;
    } catch (err) {
      log.warn('Article generation failed', { topic: topic.name, error: err.message });
      return null;
    }
  }

  /**
   * 기존 article 업데이트 (Haiku).
   * @private
   */
  async _updateArticle(existing, newMemories, topic, client) {
    const newText = newMemories
      .map((m, i) => `[NEW ${i + 1}] ${m.content}`)
      .join('\n')
      .slice(0, 4000);

    const existingContent = (existing.content || '').slice(0, 4000);

    try {
      const response = await client.messages.create({
        model: this.model,
        max_tokens: 2000,
        system: [
          '당신은 팀의 지식 관리자입니다.',
          '기존 문서에 새로운 정보를 통합하여 업데이트하세요.',
          '',
          '규칙:',
          '- 기존 구조를 유지하면서 새 정보 추가',
          '- 모순되는 정보가 있으면 최신 정보 우선',
          '- 불필요한 중복 제거',
          '- 최대 5000자',
          '- 마크다운 형식 사용하지 마세요. 순수 텍스트로 작성하세요.',
        ].join('\n'),
        messages: [{
          role: 'user',
          content: `기존 문서:\n${existingContent}\n\n새로운 정보 (${newMemories.length}건):\n${newText}\n\n위 새 정보를 기존 문서에 통합하여 업데이트된 전체 문서를 작성하세요.`,
        }],
      });

      const text = response.content?.[0]?.text || '';
      return text.slice(0, this.maxArticleLength) || null;
    } catch (err) {
      log.warn('Article update failed', { topic: topic.name, error: err.message });
      return null;
    }
  }

  /**
   * Article을 L3 semantic에 저장.
   * @private
   */
  async _saveArticle(topic, content, mode) {
    try {
      await semantic.save({
        content,
        sourceType: 'compiled_article',
        channelId: 'system',
        userId: 'knowledge-compiler',
        tags: [topic.name, topic.displayName || topic.name].filter(Boolean),
        promotionReason: `Knowledge Compiler: ${mode} article for topic "${topic.displayName || topic.name}"`,
        poolId: 'team',
        memoryType: 'Article',
      });
      log.info(`Article ${mode}`, { topic: topic.name, contentLength: content.length });
    } catch (err) {
      log.error('Failed to save article', { topic: topic.name, error: err.message });
    }
  }

  /**
   * 현재 상태 조회 (Dashboard용).
   */
  getStatus() {
    return {
      enabled: this.enabled,
      running: this._running,
      intervalMs: this.intervalMs,
      priorityTopics: this._priorityTopics.length,
    };
  }
}

module.exports = { KnowledgeCompiler };
