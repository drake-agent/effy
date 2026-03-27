/**
 * core/agent-scope.js — 멀티-에이전트 격리 (Multi-Agent Isolation)
 *
 * 공유 인프라에서 에이전트 수준 격리 보장:
 * - 스코프된 DB 쿼리 (WHERE agent_id = ? 자동 주입)
 * - 메모리 namespace 분리
 * - 리소스 접근 제어 (memory|channel|config|secret)
 * - 권한 검증
 *
 * 사용:
 *   const scope = new AgentScope();
 *   scope.register('analyst', { name: 'Data Analyst', model: 'opus' });
 *   const scopedDb = scope.scopeDb('analyst', db);
 */
const { createLogger } = require('../shared/logger');
const log = createLogger('core:agent-scope');

class AgentScope {
  constructor(opts = {}) {
    /**
     * @type {Map<string, {
     *   config: Object,
     *   dbPrefix: string,
     *   memoryNamespace: string,
     *   permissions: Set<string>
     * }>}
     */
    this.agents = new Map();
  }

  /**
   * 에이전트 격리 스코프로 등록
   *
   * @param {string} agentId - e.g., 'analyst', 'researcher'
   * @param {Object} config - { name, model, permissions: ['memory', 'channel'], ... }
   */
  register(agentId, config = {}) {
    if (!agentId) {
      throw new Error('agentId is required');
    }

    const dbPrefix = config.dbPrefix || `agent_${agentId}`;
    const memoryNamespace = config.memoryNamespace || `mem_${agentId}`;
    const permissions = new Set(config.permissions || ['memory', 'channel', 'config']);

    this.agents.set(agentId, {
      config: {
        name: config.name || agentId,
        model: config.model || 'claude-opus',
        ...config,
      },
      dbPrefix,
      memoryNamespace,
      permissions,
    });

    log.info('Agent registered with isolation scope', {
      agentId,
      name: config.name,
      memoryNamespace,
    });
  }

  /**
   * 스코프된 데이터베이스 래퍼 반환
   * 모든 쿼리에 WHERE agent_id = ? 자동 주입
   *
   * @param {string} agentId
   * @param {Object} db - better-sqlite3 instance
   * @returns {Object} - 프록시된 DB (prepare, exec, etc.)
   */
  scopeDb(agentId, db) {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent '${agentId}' not registered`);
    }

    const agentInfo = this.agents.get(agentId);

    // 프록시된 DB 반환
    return {
      /**
       * SQL 쿼리 준비 및 실행 (agent_id 주입)
       */
      prepare: (sql) => {
        // SELECT/UPDATE/DELETE에 WHERE agent_id = ? 자동 추가
        let scopedSql = sql;

        // 매우 기본적인 변환 (production에서는 더 정교한 파싱 필요)
        if (sql.match(/^\s*SELECT/i) && !sql.match(/WHERE\s+agent_id/i)) {
          if (sql.match(/WHERE/i)) {
            scopedSql = sql.replace(/WHERE/i, 'WHERE agent_id = ? AND');
          } else {
            scopedSql = sql + ' WHERE agent_id = ?';
          }
        } else if (sql.match(/^\s*UPDATE/i) && !sql.match(/WHERE\s+agent_id/i)) {
          if (sql.match(/WHERE/i)) {
            scopedSql = sql.replace(/WHERE/i, 'WHERE agent_id = ? AND');
          } else {
            scopedSql = sql + ' WHERE agent_id = ?';
          }
        } else if (sql.match(/^\s*DELETE/i) && !sql.match(/WHERE\s+agent_id/i)) {
          if (sql.match(/WHERE/i)) {
            scopedSql = sql.replace(/WHERE/i, 'WHERE agent_id = ? AND');
          } else {
            scopedSql = sql + ' WHERE agent_id = ?';
          }
        }

        // 원본 prepare 반환하되, 첫 파라미터에 agentId 주입
        const stmt = db.prepare(scopedSql);
        return {
          run: (...args) => {
            // SELECT 제외 (SELECT는 params 추가, 나머지는 앞에 주입)
            if (sql.match(/^\s*SELECT/i)) {
              return stmt.run(...args);
            }
            return stmt.run(agentId, ...args);
          },
          all: (...args) => {
            if (sql.match(/^\s*SELECT/i)) {
              return stmt.all(agentId, ...args);
            }
            return stmt.all(...args);
          },
          get: (...args) => {
            if (sql.match(/^\s*SELECT/i)) {
              return stmt.get(agentId, ...args);
            }
            return stmt.get(...args);
          },
        };
      },

      exec: (sql) => db.exec(sql),
    };
  }

  /**
   * 에이전트 메모리 namespace 반환
   *
   * @param {string} agentId
   * @returns {string} - e.g., 'mem_analyst'
   */
  getMemoryNamespace(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent '${agentId}' not registered`);
    }
    return agent.memoryNamespace;
  }

  /**
   * 에이전트의 리소스 접근 권한 검증
   *
   * @param {string} agentId
   * @param {string} resourceType - 'memory'|'channel'|'config'|'secret'
   * @param {string} [resourceId] - 리소스 ID (생략 시 타입별 허용 여부만 확인)
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkAccess(agentId, resourceType, resourceId = null) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { allowed: false, reason: `Agent '${agentId}' not registered` };
    }

    // 권한 확인
    if (!agent.permissions.has(resourceType)) {
      return {
        allowed: false,
        reason: `Agent '${agentId}' does not have '${resourceType}' permission`,
      };
    }

    // secret 리소스는 추가 검증 (예: 프리미엄 에이전트만)
    if (resourceType === 'secret') {
      const isPremium = agent.config.tier === 'premium' || agent.config.tier === 'enterprise';
      if (!isPremium) {
        return {
          allowed: false,
          reason: `Agent '${agentId}' (tier: ${agent.config.tier}) cannot access secrets`,
        };
      }
    }

    log.debug('Access check passed', { agentId, resourceType, resourceId });
    return { allowed: true, reason: 'access granted' };
  }

  /**
   * 등록된 모든 에이전트 나열
   *
   * @returns {Array<{ id: string, name: string, model: string }>}
   */
  listAgents() {
    const list = [];
    for (const [agentId, agent] of this.agents) {
      list.push({
        id: agentId,
        name: agent.config.name,
        model: agent.config.model,
        namespace: agent.memoryNamespace,
      });
    }
    return list;
  }

  /**
   * 에이전트 config 조회
   *
   * @param {string} agentId
   * @returns {Object|null}
   */
  getConfig(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      log.warn('Agent config requested for unregistered agent', { agentId });
      return null;
    }
    return agent.config;
  }

  /**
   * 에이전트 권한 확인 (단순)
   *
   * @param {string} agentId
   * @param {string} permission
   * @returns {boolean}
   */
  hasPermission(agentId, permission) {
    const agent = this.agents.get(agentId);
    return agent ? agent.permissions.has(permission) : false;
  }

  /**
   * 모든 에이전트 격리 정보 조회 (디버깅용)
   *
   * @returns {Object}
   */
  getIsolationInfo() {
    const info = {};
    for (const [agentId, agent] of this.agents) {
      info[agentId] = {
        namespace: agent.memoryNamespace,
        dbPrefix: agent.dbPrefix,
        permissions: Array.from(agent.permissions),
      };
    }
    return info;
  }
}

module.exports = { AgentScope };
