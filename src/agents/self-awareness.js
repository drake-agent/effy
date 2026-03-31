/**
 * self-awareness.js — 에이전트 자기 인식 + 상태 자체 설명 생성.
 * 에이전트의 현재 상태, 능력, 활동을 자연어로 설명.
 * 에이전트 자기 인식 패턴.
 */

const { createLogger } = require('../shared/logger');
const { config } = require('../config');

const log = createLogger('agent:self-awareness');

class SelfAwareness {
  /**
   * Self-awareness 시스템 초기화.
   * @param {Object} [opts={}]
   * @param {Object} [opts.dbAdapter] - DB 어댑터 (기본: getAdapter() 호출)
   */
  constructor(opts = {}) {
    this._dbAdapter = opts.dbAdapter || null;
  }

  /**
   * DB 어댑터 획득 (lazy-load).
   * @private
   * @returns {Object} DB 어댑터
   */
  _getAdapter() {
    if (this._dbAdapter) return this._dbAdapter;

    try {
      const { getAdapter } = require('../db/adapter');
      return getAdapter();
    } catch (e) {
      log.debug('DB adapter not available', { error: e.message });
      return null;
    }
  }

  /**
   * 에이전트의 현재 상태를 자연어로 설명.
   * @param {string} agentId - 에이전트 ID
   * @returns {Promise<string>} 자연어 설명
   */
  async generateSelfDescription(agentId) {
    try {
      const sections = [];

      // 1. 활성 채널
      const channels = await this._getActiveChannels(agentId);
      if (channels.length > 0) {
        sections.push(`I am currently monitoring ${channels.length} channel(s): ${channels.join(', ')}.`);
      }

      // 2. 메모리 통계
      const memoryStats = await this._getMemoryStats(agentId);
      sections.push(
        `My memory contains ${memoryStats.totalMemories} memories across ${memoryStats.knowledgeAreas} domains. ` +
        `Recent decisions: ${memoryStats.recentDecisions}. ` +
        `Primary expertise: ${memoryStats.topDomains.join(', ')}.`
      );

      // 3. 도구 사용 패턴
      const toolPatterns = await this._getToolPatterns(agentId);
      sections.push(
        `I frequently use: ${toolPatterns.topTools.join(', ')}. ` +
        `Total tool invocations: ${toolPatterns.totalInvocations} (avg ${toolPatterns.avgLatencyMs.toFixed(0)}ms per call).`
      );

      // 4. 현재 워크로드
      const workload = await this._getActiveWorkload(agentId);
      sections.push(
        `Currently handling ${workload.activeSessions} active sessions and ${workload.pendingTasks} pending tasks. ` +
        `Capacity utilization: ${workload.utilizationPercent}%.`
      );

      // 5. 능력 요약
      const capabilities = this.getCapabilities('agent'); // 또는 agent 타입에 맞춰 결정
      sections.push(`My capabilities include: ${capabilities.map(c => c.name).join(', ')}.`);

      // 6. 건강 상태
      const health = await this._getHealthStatus(agentId);
      sections.push(
        `Health status: LLM latency ${health.llmLatencyMs}ms, memory usage ${health.memoryUsagePercent}%, ` +
        `error rate ${health.errorRatePercent}%.`
      );

      return sections.join(' ');
    } catch (err) {
      log.error('Error generating self-description', { agentId, error: err.message });
      return `Agent ${agentId}: Unable to generate self-description at this time.`;
    }
  }

  /**
   * 에이전트 타입의 능력 목록 반환.
   * @param {string} agentType - 에이전트 타입 (예: 'agent', 'analyzer', 'observer')
   * @returns {Array<{ name: string, description: string }>}
   */
  getCapabilities(agentType = 'agent') {
    // 에이전트 정의에서 능력 추출 (config.agents.list 참조)
    const agentDefs = config.agents?.list || [];
    const agentDef = agentDefs.find(a => a.type === agentType);

    if (!agentDef) {
      return this._getDefaultCapabilities();
    }

    const capabilities = agentDef.capabilities || [];
    return capabilities.map(cap => ({
      name: typeof cap === 'string' ? cap : cap.name,
      description: typeof cap === 'object' ? cap.description : ''
    }));
  }

  /**
   * 기본 능력 목록 (config 없을 시).
   * @private
   * @returns {Array<{ name: string, description: string }>}
   */
  _getDefaultCapabilities() {
    return [
      { name: 'message_processing', description: 'Process incoming messages and requests' },
      { name: 'knowledge_recall', description: 'Recall stored knowledge and memories' },
      { name: 'tool_invocation', description: 'Invoke tools to execute tasks' },
      { name: 'decision_making', description: 'Make autonomous decisions within scope' },
      { name: 'error_handling', description: 'Handle errors and recover gracefully' },
      { name: 'self_monitoring', description: 'Monitor own performance and health' }
    ];
  }

  /**
   * 메모리를 분석하여 지식 영역 식별.
   * @param {string} agentId - 에이전트 ID
   * @returns {Promise<Array<{ domain: string, count: number }>}
   */
  async getKnowledgeDomains(agentId) {
    try {
      const db = this._getAdapter();
      if (!db) return [];

      // 메모리 데이블에서 domains 또는 tags 기반 집계
      // 가정: memories 테이블에 domain 또는 type 컬럼 존재
      const rows = await db.all(
        `SELECT domain, COUNT(*) as count FROM memories WHERE agent_id = ? GROUP BY domain ORDER BY count DESC LIMIT 10`,
        [agentId]
      ).catch(() => []);

      return rows.map(r => ({
        domain: r.domain || 'general',
        count: r.count
      }));
    } catch (err) {
      log.warn('Error fetching knowledge domains', { agentId, error: err.message });
      return [];
    }
  }

  /**
   * 최근 활동 요약.
   * @param {string} agentId - 에이전트 ID
   * @param {number} [hours=24] - 과거 몇 시간
   * @returns {Promise<{ messageCount: number, toolInvocations: number, decisions: number }>}
   */
  async getActivitySummary(agentId, hours = 24) {
    try {
      const db = this._getAdapter();
      if (!db) {
        return { messageCount: 0, toolInvocations: 0, decisions: 0 };
      }

      const sinceTime = Date.now() - hours * 3600 * 1000;

      // 메시지 수
      const msgRow = await db.get(
        `SELECT COUNT(*) as count FROM messages WHERE agent_id = ? AND created_at > ?`,
        [agentId, sinceTime]
      ).catch(() => ({ count: 0 }));

      // 도구 호출 수
      const toolRow = await db.get(
        `SELECT COUNT(*) as count FROM tool_calls WHERE agent_id = ? AND created_at > ?`,
        [agentId, sinceTime]
      ).catch(() => ({ count: 0 }));

      // 결정 수
      const decisionRow = await db.get(
        `SELECT COUNT(*) as count FROM decisions WHERE agent_id = ? AND created_at > ?`,
        [agentId, sinceTime]
      ).catch(() => ({ count: 0 }));

      return {
        messageCount: msgRow?.count || 0,
        toolInvocations: toolRow?.count || 0,
        decisions: decisionRow?.count || 0
      };
    } catch (err) {
      log.warn('Error fetching activity summary', { agentId, error: err.message });
      return { messageCount: 0, toolInvocations: 0, decisions: 0 };
    }
  }

  /**
   * Self-awareness를 시스템 프롬프트 섹션으로 포맷.
   * @param {string} agentId - 에이전트 ID
   * @returns {Promise<string>} ## SelfAwareness 형식의 텍스트
   */
  async toPromptSection(agentId) {
    const description = await this.generateSelfDescription(agentId);
    return `## Self-Awareness\n\n${description}`;
  }

  /**
   * 활성 채널 목록 (관찰 중인 채널).
   * @private
   */
  async _getActiveChannels(agentId) {
    try {
      const db = this._getAdapter();
      if (!db) return [];

      const rows = await db.all(
        `SELECT DISTINCT channel FROM subscriptions WHERE agent_id = ? AND active = 1 LIMIT 5`,
        [agentId]
      ).catch(() => []);

      return rows.map(r => r.channel || 'unknown');
    } catch (e) {
      log.debug('getActiveChannels failed', { error: e.message });
      return [];
    }
  }

  /**
   * 메모리 통계.
   * @private
   */
  async _getMemoryStats(agentId) {
    try {
      const db = this._getAdapter();
      if (!db) {
        return {
          totalMemories: 0,
          knowledgeAreas: 0,
          recentDecisions: 0,
          topDomains: []
        };
      }

      // 메모리 총 개수
      const countRow = await db.get(
        `SELECT COUNT(*) as count FROM memories WHERE agent_id = ?`,
        [agentId]
      ).catch(() => ({ count: 0 }));

      // 지식 영역 수
      const domainsRow = await db.get(
        `SELECT COUNT(DISTINCT domain) as count FROM memories WHERE agent_id = ?`,
        [agentId]
      ).catch(() => ({ count: 0 }));

      // 최근 결정
      const recentRow = await db.get(
        `SELECT COUNT(*) as count FROM decisions WHERE agent_id = ? AND created_at > ?`,
        [agentId, Date.now() - 7 * 24 * 3600 * 1000]
      ).catch(() => ({ count: 0 }));

      // 상위 도메인
      const domains = await this.getKnowledgeDomains(agentId);
      const topDomains = domains.slice(0, 3).map(d => d.domain);

      return {
        totalMemories: countRow?.count || 0,
        knowledgeAreas: domainsRow?.count || 0,
        recentDecisions: recentRow?.count || 0,
        topDomains: topDomains.length > 0 ? topDomains : ['general']
      };
    } catch (err) {
      log.warn('Error computing memory stats', { agentId, error: err.message });
      return {
        totalMemories: 0,
        knowledgeAreas: 0,
        recentDecisions: 0,
        topDomains: ['general']
      };
    }
  }

  /**
   * 도구 사용 패턴.
   * @private
   */
  async _getToolPatterns(agentId) {
    try {
      const db = this._getAdapter();
      if (!db) {
        return {
          topTools: ['tool_invocation'],
          totalInvocations: 0,
          avgLatencyMs: 0
        };
      }

      // 상위 도구
      const toolRows = await db.all(
        `SELECT tool_name, COUNT(*) as count FROM tool_calls WHERE agent_id = ? GROUP BY tool_name ORDER BY count DESC LIMIT 3`,
        [agentId]
      ).catch(() => []);

      const topTools = toolRows.map(r => r.tool_name || 'unknown').filter(t => t);

      // 도구 호출 수
      const countRow = await db.get(
        `SELECT COUNT(*) as count FROM tool_calls WHERE agent_id = ?`,
        [agentId]
      ).catch(() => ({ count: 0 }));

      // 평균 지연
      const latencyRow = await db.get(
        `SELECT AVG(latency_ms) as avg FROM tool_calls WHERE agent_id = ?`,
        [agentId]
      ).catch(() => ({ avg: 0 }));

      return {
        topTools: topTools.length > 0 ? topTools : ['tool_invocation'],
        totalInvocations: countRow?.count || 0,
        avgLatencyMs: latencyRow?.avg || 0
      };
    } catch (err) {
      log.warn('Error computing tool patterns', { agentId, error: err.message });
      return {
        topTools: ['tool_invocation'],
        totalInvocations: 0,
        avgLatencyMs: 0
      };
    }
  }

  /**
   * 활성 워크로드.
   * @private
   */
  async _getActiveWorkload(agentId) {
    try {
      const db = this._getAdapter();
      if (!db) {
        return {
          activeSessions: 0,
          pendingTasks: 0,
          utilizationPercent: 0
        };
      }

      // 활성 세션
      const sessionRow = await db.get(
        `SELECT COUNT(*) as count FROM sessions WHERE agent_id = ? AND status = 'active'`,
        [agentId]
      ).catch(() => ({ count: 0 }));

      // 보류 중인 작업
      const taskRow = await db.get(
        `SELECT COUNT(*) as count FROM tasks WHERE agent_id = ? AND status = 'pending'`,
        [agentId]
      ).catch(() => ({ count: 0 }));

      const activeSessions = sessionRow?.count || 0;
      const pendingTasks = taskRow?.count || 0;
      const maxCapacity = config.gateway?.maxConcurrency?.perUser || 10;
      const utilizationPercent = Math.min(100, Math.round(((activeSessions + pendingTasks) / maxCapacity) * 100));

      return {
        activeSessions,
        pendingTasks,
        utilizationPercent
      };
    } catch (err) {
      log.warn('Error computing workload', { agentId, error: err.message });
      return {
        activeSessions: 0,
        pendingTasks: 0,
        utilizationPercent: 0
      };
    }
  }

  /**
   * 건강 상태.
   * @private
   */
  async _getHealthStatus(agentId) {
    try {
      const db = this._getAdapter();

      // LLM 지연 시간 (최근 10개 호출의 평균)
      let llmLatencyMs = 100; // 기본값
      if (db) {
        const latencyRow = await db.get(
          `SELECT AVG(latency_ms) as avg FROM llm_calls WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10`,
          [agentId]
        ).catch(() => null);
        if (latencyRow?.avg) llmLatencyMs = Math.round(latencyRow.avg);
      }

      // 메모리 사용률 (프로세스 기준)
      const memUsage = process.memoryUsage();
      const memoryUsagePercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);

      // 에러율 (최근 24시간)
      let errorRatePercent = 0;
      if (db) {
        const errorRow = await db.get(
          `SELECT COUNT(*) as count FROM errors WHERE agent_id = ? AND created_at > ?`,
          [agentId, Date.now() - 24 * 3600 * 1000]
        ).catch(() => ({ count: 0 }));
        const totalRow = await db.get(
          `SELECT COUNT(*) as count FROM logs WHERE agent_id = ? AND created_at > ?`,
          [agentId, Date.now() - 24 * 3600 * 1000]
        ).catch(() => ({ count: 1 }));
        if (totalRow?.count > 0) {
          errorRatePercent = Math.round((errorRow?.count || 0) / totalRow.count * 100);
        }
      }

      return {
        llmLatencyMs,
        memoryUsagePercent,
        errorRatePercent
      };
    } catch (err) {
      log.warn('Error computing health status', { agentId, error: err.message });
      return {
        llmLatencyMs: 0,
        memoryUsagePercent: 0,
        errorRatePercent: 0
      };
    }
  }
}

module.exports = { SelfAwareness };
