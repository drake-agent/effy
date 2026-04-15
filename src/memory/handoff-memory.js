/**
 * handoff-memory.js — A2A Handoff Memory (P3 — coordinator memory).
 *
 * 에이전트 간 위임(AgentBus.ask)이 일어나면 다음 두 곳에 흔적 남김:
 *   1. semantic_memory (source_type='handoff', memory_type='Event', pool_id='team')
 *   2. entity_relationships (agent:X → agent:Y, relation='handed_off')
 *
 * 마이그레이션 없음 — 기존 테이블의 free-form 컬럼 활용.
 *
 * 사용처:
 *   - AgentBus.ask() — 위임 시작 시 record() 호출
 *   - DelegationTracer.completeTrace() — chain 요약 persist
 *   - Gateway/AgentLoader — buildSystemPrompt()에 recent handoff 주입
 */
const { semantic, entity } = require('./manager');
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:handoff');

function _formatHandoff({ fromAgent, toAgent, query, threadId }) {
  const head = `[handoff] agent:${fromAgent} → agent:${toAgent}`;
  const q = (query || '').slice(0, 200);
  const thread = threadId ? ` | thread: ${threadId}` : '';
  return `${head} | query: "${q}"${thread}`;
}

class HandoffMemory {
  /**
   * 위임 시작 시 호출. 실패해도 위임을 막지 않음 (best-effort).
   * @returns {Promise<{hash: string, startedAt: number}|null>}
   */
  async record({ fromAgent, toAgent, query, threadId, requestId, userId, channelId, depth, contextPacket }) {
    if (!fromAgent || !toAgent) return null;

    const tags = ['handoff', `from:${fromAgent}`, `to:${toAgent}`];
    if (threadId) tags.push(`thread:${threadId}`);
    if (requestId) tags.push(`req:${requestId}`);
    if (userId) tags.push(`user:${userId}`);

    const content = _formatHandoff({ fromAgent, toAgent, query, threadId });

    let hash = null;
    try {
      hash = await semantic.save({
        content,
        sourceType: 'handoff',
        sourceId: requestId || `handoff:${Date.now()}`,
        channelId: channelId || '',
        userId: userId || '',
        tags,
        promotionReason: 'a2a-delegation',
        poolId: 'team',
        memoryType: 'Event',
      });
    } catch (semErr) {
      log.debug('semantic.save for handoff failed', { error: semErr.message });
    }

    try {
      await entity.addRelationship('agent', fromAgent, 'agent', toAgent, 'handed_off', {
        requestId: requestId || '',
        threadId: threadId || '',
        userId: userId || '',
        depth: depth || 0,
        at: new Date().toISOString(),
        contextPreview: (contextPacket || '').slice(0, 200),
      });
    } catch (relErr) {
      log.debug('entity.addRelationship for handoff failed', { error: relErr.message });
    }

    log.info('Handoff recorded', { from: fromAgent, to: toAgent, threadId, requestId, depth: depth || 0 });
    return { hash, startedAt: Date.now() };
  }

  /**
   * 특정 thread + agent로 향한 최근 handoff 조회.
   */
  async getRecentForThread(threadId, toAgent, limit = 3) {
    if (!threadId || !toAgent) return [];
    try {
      const { getDb } = require('../db');
      const db = getDb();
      const rows = await db.prepare(`
        SELECT content, created_at, tags FROM semantic_memory
        WHERE source_type = 'handoff' AND archived = 0
          AND tags::text LIKE ? AND tags::text LIKE ?
        ORDER BY created_at DESC LIMIT ?
      `).all(`%"thread:${threadId}"%`, `%"to:${toAgent}"%`, limit);
      return rows || [];
    } catch (err) {
      log.debug('getRecentForThread failed', { error: err.message });
      return [];
    }
  }

  /**
   * 특정 user의 최근 N분 내 handoff (cross-thread fallback).
   */
  async getRecentForUser(userId, withinMinutes = 30, limit = 5) {
    if (!userId) return [];
    try {
      const { getDb } = require('../db');
      const db = getDb();
      const rows = await db.prepare(`
        SELECT content, created_at FROM semantic_memory
        WHERE source_type = 'handoff' AND archived = 0
          AND user_id = ?
          AND created_at > NOW() - INTERVAL '${Math.floor(withinMinutes)} minutes'
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, limit);
      return rows || [];
    } catch (err) {
      log.debug('getRecentForUser failed', { error: err.message });
      return [];
    }
  }

  async getStats() {
    try {
      const { getDb } = require('../db');
      const db = getDb();
      const row = await db.prepare(`
        SELECT COUNT(*) as total, COUNT(DISTINCT user_id) as users
        FROM semantic_memory WHERE source_type = 'handoff' AND archived = 0
      `).get();
      return {
        totalHandoffs: Number(row?.total) || 0,
        distinctUsers: Number(row?.users) || 0,
      };
    } catch {
      return { totalHandoffs: 0, distinctUsers: 0 };
    }
  }
}

// Singleton (lazy)
let _instance = null;
function getHandoffMemory() {
  if (!_instance) _instance = new HandoffMemory();
  return _instance;
}

module.exports = { HandoffMemory, getHandoffMemory };
