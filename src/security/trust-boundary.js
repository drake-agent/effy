/**
 * trust-boundary.js — Trust boundary enforcement (v4.0 Security).
 *
 * 에이전트 간 통신 및 도구 호출의 신뢰 경계를 검증.
 *
 * Trust levels:
 *   - internal: 같은 프로세스 내 통신 (최고 신뢰)
 *   - authenticated: 신원 확인된 통신 (JWT/API key)
 *   - external: 미확인 통신 (최저 신뢰)
 *
 * Export: TrustBoundary class
 */
const { createLogger } = require('../shared/logger');
const { hasPermission, getEffectiveRole } = require('./rbac');

const log = createLogger('security:trust-boundary');

// ─── Trust Levels (높은 숫자 = 높은 신뢰) ───
const TRUST_LEVELS = {
  external: 0,
  authenticated: 1,
  internal: 2,
};

class TrustBoundary {
  constructor(options = {}) {
    // 에이전트 간 통신 허용 규칙
    // { fromAgent: string, toAgent: string } 쌍의 배열
    this._communicationRules = options.communicationRules || [];
    // M-03: Trusted registry — maps agentId to trust level (server-side source of truth)
    // e.g. { "general": "internal", "code": "internal", "external-bot": "authenticated" }
    this._trustedRegistry = options.trustedRegistry || null;

    // 도구별 최소 신뢰 수준
    // { toolName: trustLevel }
    this._toolTrustRequirements = options.toolTrustRequirements || {};

    // 기본 신뢰 수준 요구
    this._defaultToolTrust = options.defaultToolTrust || 'authenticated';
  }

  /**
   * 에이전트 간 통신 검증.
   *
   * @param {object} fromAgent - 발신 에이전트 { id, trustLevel }
   * @param {object} toAgent - 수신 에이전트 { id, trustLevel }
   * @param {object} message - 메시지 객체
   * @returns {{ allowed: boolean, reason: string }}
   */
  validateAgentCommunication(fromAgent, toAgent, message) {
    if (!fromAgent || !fromAgent.id) {
      return { allowed: false, reason: 'Invalid sender: missing agent ID.' };
    }

    if (!toAgent || !toAgent.id) {
      return { allowed: false, reason: 'Invalid receiver: missing agent ID.' };
    }

    // Same agent — always allowed
    if (fromAgent.id === toAgent.id) {
      return { allowed: true, reason: 'Same agent communication.' };
    }

    // M-03: Don't trust self-declared trustLevel. Cross-reference against registry if available.
    // If no trusted registry exists, default unrecognized agents to 'external' to fail-safe.
    let fromTrust = 'external'; // default untrusted
    if (this._trustedRegistry && this._trustedRegistry[fromAgent.id]) {
      fromTrust = this._trustedRegistry[fromAgent.id];
    } else if (!this._trustedRegistry) {
      // WARNING: No trusted registry configured. Falling back to self-declared trustLevel.
      // Configure a trustedRegistry in options to enforce trust levels server-side.
      fromTrust = fromAgent.trustLevel || 'external';
    }
    // Check communication rules FIRST (applies to all trust levels)
    if (this._communicationRules.length > 0) {
      const ruleMatch = this._communicationRules.find(rule =>
        (rule.fromAgent === fromAgent.id || rule.fromAgent === '*') &&
        (rule.toAgent === toAgent.id || rule.toAgent === '*')
      );

      if (!ruleMatch) {
        log.warn('Agent communication blocked by rules', {
          from: fromAgent.id,
          to: toAgent.id,
        });
        return {
          allowed: false,
          reason: `No communication rule found for ${fromAgent.id} -> ${toAgent.id}.`,
        };
      }
    }

    // THEN check trust level
    if (fromTrust === 'internal') {
      return { allowed: true, reason: 'Internal trust level allows all communication.' };
    }

    // External agents can only communicate with internal/authenticated agents
    if (fromTrust === 'external') {
      let toTrust = 'external';
      if (this._trustedRegistry && this._trustedRegistry[toAgent.id]) {
        toTrust = this._trustedRegistry[toAgent.id];
      } else if (!this._trustedRegistry) {
        toTrust = toAgent.trustLevel || 'external';
      }
      if (toTrust === 'external') {
        log.warn('External-to-external communication blocked', {
          from: fromAgent.id,
          to: toAgent.id,
        });
        return {
          allowed: false,
          reason: 'External agents cannot communicate with other external agents.',
        };
      }
    }

    return { allowed: true, reason: 'Communication permitted.' };
  }

  /**
   * 도구 호출 검증.
   *
   * RBAC 권한 + 신뢰 수준 모두 확인.
   *
   * @param {string} agentId - 호출 에이전트 ID
   * @param {string} toolName - 도구 이름
   * @param {object} args - 도구 인자
   * @param {object} options
   * @param {object} options.user - req.user 객체 (RBAC 확인용)
   * @param {string} options.trustLevel - 에이전트 신뢰 수준
   * @returns {{ allowed: boolean, reason: string }}
   */
  validateToolCall(agentId, toolName, args, options = {}) {
    const { user = null, trustLevel = 'external' } = options;

    if (!agentId || !toolName) {
      return { allowed: false, reason: 'Missing agentId or toolName.' };
    }

    // 1. RBAC 권한 확인 — execute_tools
    if (user && !hasPermission(user, 'execute_tools')) {
      log.warn('Tool call denied by RBAC', { agentId, toolName });
      return { allowed: false, reason: 'Insufficient permissions (execute_tools required).' };
    }

    // 2. Agent scope 확인 — agent 역할은 own scope only
    if (user) {
      const effectiveRole = getEffectiveRole(user);
      if (effectiveRole === 'agent' && user.id !== agentId) {
        log.warn('Agent role scope violation', {
          userId: user.id,
          agentId,
          toolName,
        });
        return {
          allowed: false,
          reason: 'Agent role can only execute tools in own scope.',
        };
      }
    }

    // 3. 신뢰 수준 확인
    const requiredTrust = this._toolTrustRequirements[toolName] || this._defaultToolTrust;
    const requiredLevel = TRUST_LEVELS[requiredTrust] || 0;
    const actualLevel = TRUST_LEVELS[trustLevel] || 0;

    if (actualLevel < requiredLevel) {
      log.warn('Tool call denied by trust level', {
        agentId,
        toolName,
        required: requiredTrust,
        actual: trustLevel,
      });
      return {
        allowed: false,
        reason: `Trust level '${trustLevel}' insufficient. Tool '${toolName}' requires '${requiredTrust}'.`,
      };
    }

    return { allowed: true, reason: 'Tool call permitted.' };
  }

  /**
   * 에이전트의 신뢰 수준 결정.
   * @param {object} agent - { id, authMethod, internal }
   * @returns {string} trust level
   */
  determineTrustLevel(agent) {
    if (!agent) return 'external';
    if (agent.internal === true) return 'internal';
    if (agent.authMethod === 'jwt' || agent.authMethod === 'api-key' || agent.authMethod === 'internal') {
      return 'authenticated';
    }
    return 'external';
  }

  /**
   * 통신 규칙 추가.
   * @param {string} fromAgent
   * @param {string} toAgent
   */
  addCommunicationRule(fromAgent, toAgent) {
    this._communicationRules.push({ fromAgent, toAgent });
  }

  /**
   * 도구 신뢰 요구 수준 설정.
   * @param {string} toolName
   * @param {string} trustLevel
   */
  setToolTrustRequirement(toolName, trustLevel) {
    if (TRUST_LEVELS[trustLevel] === undefined) {
      throw new Error(`Invalid trust level: ${trustLevel}`);
    }
    this._toolTrustRequirements[toolName] = trustLevel;
  }
}

module.exports = {
  TrustBoundary,
  TRUST_LEVELS,
};
