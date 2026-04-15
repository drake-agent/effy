/**
 * capability-registry.js — Agent Capability Registry (L4 extension).
 *
 * Coordinator Memory Layer P2: Effy의 라우팅을 static config에서
 * data-driven으로 발전시키기 위한 agent + capability 엔티티 관리.
 *
 * 저장: 기존 L4 entities + entity_relationships 테이블 재활용.
 *   - entity_type='agent'        — 각 에이전트
 *   - entity_type='capability'   — 각 역량 (slug)
 *   - relation='has_capability'  — agent → capability
 *   - relation='active_in'       — agent → channel
 *   - relation='last_routed_to'  — user → agent (30분 TTL)
 *   - relation='handled'         — agent → topic (post-step 누적)
 *
 * 마이그레이션 없음 — entities/entity_relationships의 TEXT 컬럼 활용.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('memory:capability-registry');

// ─── Agent ID → Default Capabilities (config에 명시 안 된 경우 폴백) ───
const DEFAULT_CAPABILITIES = {
  general:   ['triage', 'conversation', 'coordination'],
  code:      ['code-review', 'architecture', 'debugging'],
  ops:       ['incident-response', 'task-management', 'postmortem'],
  knowledge: ['retrieval', 'cross-channel-analysis', 'summarization'],
  strategy:  ['planning', 'okr', 'decision-making'],
};

class CapabilityRegistry {
  /**
   * @param {Object} opts
   * @param {Object} opts.entity - entity API from manager.js
   * @param {Object} [opts.logger] - logger
   */
  constructor({ entity, logger }) {
    if (!entity) throw new Error('CapabilityRegistry requires entity API');
    this.entity = entity;
    this.log = logger || log;
    this._bootstrapped = false;
  }

  /**
   * 부팅 1회: agentList + bindings → entity 업서트.
   * @param {Array} agentList - config.agents.list
   * @param {Array} bindings - config.bindings
   */
  async bootstrap(agentList = [], bindings = []) {
    if (this._bootstrapped) return this.getStats();
    let agentsCount = 0, capsCount = 0, activeInCount = 0;

    try {
      for (const agentDef of agentList) {
        if (!agentDef || !agentDef.id) continue;
        const agentId = String(agentDef.id).toLowerCase();

        // Agent entity
        await this.entity.upsert('agent', agentId, agentId, {
          modelRange: agentDef.model?.range || [],
          accessiblePools: agentDef.memory?.shared_read || ['team'],
          writablePools: agentDef.memory?.shared_write || ['team'],
          description: agentDef.description || '',
          source: 'config',
        });
        agentsCount++;

        // Capabilities (config에 없으면 DEFAULT_CAPABILITIES 사용)
        const caps = Array.isArray(agentDef.capabilities) && agentDef.capabilities.length > 0
          ? agentDef.capabilities
          : (DEFAULT_CAPABILITIES[agentId] || []);

        for (const cap of caps) {
          const capId = String(cap).toLowerCase().replace(/[^a-z0-9-]/g, '-');
          if (!capId) continue;
          await this.entity.upsert('capability', capId, cap, { source: 'config' });
          await this.entity.addRelationship('agent', agentId, 'capability', capId, 'has_capability', {
            source: 'config',
          });
          capsCount++;
        }
      }

      // Bindings → active_in edges
      for (const b of bindings) {
        if (!b || !b.agentId) continue;
        const agentId = String(b.agentId).toLowerCase();
        const match = b.match || {};
        if (match.channelId) {
          await this.entity.addRelationship('agent', agentId, 'channel', match.channelId, 'active_in', {
            binding: match,
            source: 'config',
          });
          activeInCount++;
        }
      }

      this._bootstrapped = true;
      this.log.info('CapabilityRegistry bootstrapped', { agents: agentsCount, capabilities: capsCount, activeInEdges: activeInCount });
    } catch (err) {
      this.log.error('CapabilityRegistry bootstrap error', { error: err.message });
    }

    return { agents: agentsCount, capabilities: capsCount, activeInEdges: activeInCount };
  }

  /**
   * 메시지 라우팅 기록 (매 메시지 fire-and-forget).
   */
  async recordRouting(userId, agentId, channelId) {
    if (!userId || !agentId) return;
    try {
      await this.entity.addRelationship('user', userId, 'agent', String(agentId).toLowerCase(), 'last_routed_to', {
        timestamp: Date.now(),
        channelId: channelId || '',
      });
    } catch (err) {
      this.log.debug('recordRouting failed', { error: err.message });
    }
  }

  /**
   * 에이전트가 토픽을 처리했을 때 (post-step 호출).
   */
  async recordTopicHandled(agentId, topicId) {
    if (!agentId || !topicId) return;
    try {
      await this.entity.addRelationship('agent', String(agentId).toLowerCase(), 'topic', topicId, 'handled', {
        timestamp: Date.now(),
      });
    } catch (err) {
      this.log.debug('recordTopicHandled failed', { error: err.message });
    }
  }

  /**
   * 채널에 active한 agent 목록.
   * @returns {Array<{agentId, weight}>}
   */
  async getAgentsForChannel(channelId) {
    if (!channelId) return [];
    try {
      // entity_relationships는 source→target 방향만 조회 가능
      // agent → channel active_in이므로 직접 쿼리 필요
      const { getDb } = require('../db');
      const db = getDb();
      const rows = await db.prepare(`
        SELECT source_id AS agent_id, weight
        FROM entity_relationships
        WHERE source_type = 'agent' AND target_type = 'channel'
          AND target_id = ? AND relation = 'active_in'
        ORDER BY weight DESC LIMIT 5
      `).all(channelId);
      return (rows || []).map(r => ({ agentId: r.agent_id, weight: Number(r.weight) || 1 }));
    } catch (err) {
      this.log.debug('getAgentsForChannel failed', { error: err.message });
      return [];
    }
  }

  /**
   * 사용자의 최근 라우팅 agent (30분 이내).
   */
  async getRecentAgentForUser(userId, withinMinutes = 30) {
    if (!userId) return null;
    try {
      const related = await this.entity.getRelated('user', userId, 10);
      const cutoff = Date.now() - withinMinutes * 60 * 1000;
      const routed = (related || [])
        .filter(r => r.relation === 'last_routed_to' && r.target_type === 'agent')
        .filter(r => {
          const ts = r.metadata?.timestamp || 0;
          return ts >= cutoff;
        })
        .sort((a, b) => (b.metadata?.timestamp || 0) - (a.metadata?.timestamp || 0));
      return routed.length > 0 ? routed[0].target_id : null;
    } catch (err) {
      this.log.debug('getRecentAgentForUser failed', { error: err.message });
      return null;
    }
  }

  /**
   * 에이전트의 역량 목록.
   */
  async getAgentCapabilities(agentId) {
    if (!agentId) return [];
    try {
      const related = await this.entity.getRelated('agent', String(agentId).toLowerCase(), 50);
      return (related || [])
        .filter(r => r.relation === 'has_capability' && r.target_type === 'capability')
        .map(r => r.target_id);
    } catch (err) {
      this.log.debug('getAgentCapabilities failed', { error: err.message });
      return [];
    }
  }

  /**
   * Dashboard 통계.
   */
  async getStats() {
    try {
      const agents = await this.entity.list('agent', 100);
      const caps = await this.entity.list('capability', 200);
      return {
        agents: (agents || []).length,
        capabilities: (caps || []).length,
        bootstrapped: this._bootstrapped,
      };
    } catch {
      return { agents: 0, capabilities: 0, bootstrapped: this._bootstrapped };
    }
  }
}

module.exports = { CapabilityRegistry, DEFAULT_CAPABILITIES };
