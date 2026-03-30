/**
 * memory-transaction.js — 메모리 레이어 원자적 트랜잭션.
 *
 * v3.9: PostgreSQL transaction() 래퍼로 L1(episodic) + L2(semantic) + L4(entity)
 * 메모리 작업을 단일 트랜잭션으로 묶는다.
 *
 * 문제: 기존에는 L1 add → L2 save → L4 update가 각각 독립 쿼리여서
 * 중간 실패 시 불일치 상태가 발생할 수 있었음.
 *
 * 해결: PG transaction()으로 all-or-nothing 보장.
 *
 * 사용 예:
 *   const tx = new MemoryTransaction(db);
 *   await tx.execute(async (t) => {
 *     await t.addEpisodic({ ... });
 *     await t.addSemantic({ ... });
 *     await t.updateEntity({ ... });
 *   });
 *   // 모두 성공 or 모두 롤백
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:transaction');

class MemoryTransaction {
  /**
   * @param {Object} db - PostgresAdapter 인스턴스 (transaction() 지원 필수)
   */
  constructor(db) {
    if (!db || typeof db.transaction !== 'function') {
      throw new Error('MemoryTransaction requires a PostgreSQL adapter with transaction() support');
    }
    this.db = db;
    this._stats = { total: 0, success: 0, failed: 0, rolledBack: 0 };
  }

  /**
   * 트랜잭션 실행 — 콜백에 MemoryTransactionContext 전달.
   *
   * @param {Function} fn - (ctx: MemoryTransactionContext) => Promise<void>
   * @returns {Promise<{ success: boolean, error?: string, duration: number }>}
   */
  async execute(fn) {
    this._stats.total++;
    const startTime = Date.now();

    try {
      await this.db.transaction(async (txProxy) => {
        const ctx = new MemoryTransactionContext(txProxy);
        await fn(ctx);
      });

      this._stats.success++;
      const duration = Date.now() - startTime;
      log.debug('Memory transaction committed', { duration });
      return { success: true, duration };
    } catch (err) {
      this._stats.failed++;
      this._stats.rolledBack++;
      const duration = Date.now() - startTime;
      log.error('Memory transaction rolled back', { error: err.message, duration });
      return { success: false, error: err.message, duration };
    }
  }

  /**
   * 편의 메서드: 단일 메모리 추가 + 프로모션 로그를 원자적으로.
   *
   * @param {Object} memory - { content, type, importance, sourceChannel, sourceUser, contentHash }
   * @param {Object} [promotion] - { sourceLayer, targetLayer, reason }
   * @returns {Promise<{ success: boolean, memoryId?: number }>}
   */
  async addWithPromotion(memory, promotion) {
    let memoryId = null;

    const result = await this.execute(async (ctx) => {
      memoryId = await ctx.addMemory(memory);

      if (promotion) {
        await ctx.logPromotion({
          sourceLayer: promotion.sourceLayer,
          targetLayer: promotion.targetLayer,
          contentHash: memory.contentHash,
          reason: promotion.reason,
        });
      }
    });

    return { ...result, memoryId };
  }

  /**
   * 편의 메서드: episodic → semantic 프로모션 원자 실행.
   *
   * @param {Object} episodic - L2 에피소딕 데이터
   * @param {Object} semantic - L3 시맨틱 데이터
   * @returns {Promise<{ success: boolean }>}
   */
  async promoteEpisodicToSemantic(episodic, semantic) {
    return this.execute(async (ctx) => {
      await ctx.addEpisodic(episodic);
      await ctx.addSemantic(semantic);
      await ctx.logPromotion({
        sourceLayer: 'L2_episodic',
        targetLayer: 'L3_semantic',
        contentHash: semantic.contentHash,
        reason: 'auto_promotion',
      });
    });
  }

  /** @returns {Object} 통계 */
  getStats() { return { ...this._stats }; }
}

/**
 * 트랜잭션 내부 컨텍스트 — PG TransactionProxy 위에 메모리 레이어 API 제공.
 */
class MemoryTransactionContext {
  constructor(txProxy) {
    this.tx = txProxy;
  }

  /**
   * L2 에피소딕 메모리 추가.
   */
  async addEpisodic({ conversationKey, userId, channelId, threadTs, role, content, contentHash, agentType, functionType, tokens, metadata }) {
    const result = await this.tx.run(
      `INSERT INTO episodic_memory
       (conversation_key, user_id, channel_id, thread_ts, role, content, content_hash, agent_type, function_type, tokens, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash) DO NOTHING`,
      [conversationKey || '', userId || '', channelId || '', threadTs || '', role || 'user',
       content, contentHash, agentType || '', functionType || '', tokens || 0,
       JSON.stringify(metadata || {})]
    );
    return result.lastInsertRowid;
  }

  /**
   * L3 시맨틱 메모리 추가.
   */
  async addSemantic({ content, contentHash, sourceType, sourceId, channelId, userId, tags, promotionReason, poolId, memoryType, importance, metadata }) {
    const result = await this.tx.run(
      `INSERT INTO semantic_memory
       (content, content_hash, source_type, source_id, channel_id, user_id, tags, promotion_reason, pool_id, memory_type, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash) DO NOTHING`,
      [content, contentHash, sourceType || 'conversation', sourceId || '', channelId || '',
       userId || '', JSON.stringify(tags || []), promotionReason || '', poolId || 'team',
       memoryType || 'Fact', JSON.stringify(metadata || {})]
    );
    return result.lastInsertRowid;
  }

  /**
   * L4 엔티티 업데이트 (UPSERT).
   */
  async updateEntity({ entityType, entityId, name, properties }) {
    await this.tx.run(
      `INSERT INTO entities (entity_type, entity_id, name, properties, last_seen)
       VALUES (?, ?, ?, ?, NOW())
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET name = EXCLUDED.name,
         properties = entities.properties || EXCLUDED.properties,
         last_seen = NOW()`,
      [entityType, entityId, name || '', JSON.stringify(properties || {})]
    );
  }

  /**
   * Memory Graph 노드 추가.
   */
  async addMemory({ type, content, contentHash, sourceChannel, sourceUser, importance, metadata }) {
    const result = await this.tx.run(
      `INSERT INTO memories (type, content, content_hash, source_channel, source_user, importance, base_importance, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_hash) DO NOTHING`,
      [type || 'fact', content, contentHash, sourceChannel || '', sourceUser || '',
       importance || 0.5, importance || 0.5, JSON.stringify(metadata || {})]
    );
    return result.lastInsertRowid;
  }

  /**
   * Memory Edge 추가.
   */
  async addEdge({ sourceId, targetId, relation, weight, metadata }) {
    await this.tx.run(
      `INSERT INTO memory_edges (source_id, target_id, relation, weight, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (source_id, target_id, relation) DO UPDATE SET weight = EXCLUDED.weight, updated_at = NOW()`,
      [sourceId, targetId, relation || 'related_to', weight || 1.0, JSON.stringify(metadata || {})]
    );
  }

  /**
   * 프로모션 로그 기록.
   */
  async logPromotion({ sourceLayer, targetLayer, contentHash, reason }) {
    await this.tx.run(
      `INSERT INTO memory_promotions (source_layer, target_layer, content_hash, reason)
       VALUES (?, ?, ?, ?)`,
      [sourceLayer, targetLayer, contentHash, reason || '']
    );
  }
}

module.exports = { MemoryTransaction, MemoryTransactionContext };
