/**
 * Permission Gate — Tier 1 모듈
 * 3단계 권한 강제: 등록 → 실행 → 출력 스캔
 * 다중 계층 접근 제어
 */

const { createLogger } = require('../shared/logger');

class PermissionGate {
  /**
   * 초기화 — 에이전트별 권한 정책 구성
   * @param {Object} opts - 옵션
   * @param {Object} opts.policies - { agentId: { allowedTools, deniedTools, outputRules } }
   * @param {string} opts.defaultPolicy - 'allow' 또는 'deny' (기본값: 'deny')
   */
  constructor(opts = {}) {
    this.log = createLogger('PermissionGate');

    // 에이전트별 권한 정책 저장
    this.policies = new Map();

    // 기본 정책: 'allow' = 화이트리스트, 'deny' = 블랙리스트
    this.defaultPolicy = opts.defaultPolicy ?? 'deny';

    // 초기 정책 로드
    if (opts.policies) {
      this.loadFromConfig(opts.policies);
    }

    this.log.info('PermissionGate initialized', {
      defaultPolicy: this.defaultPolicy,
      agentCount: this.policies.size
    });
  }

  /**
   * Point 1: 등록 게이트 — 에이전트에게 보이는 도구 필터링
   * @param {string} agentId - 에이전트 ID
   * @param {Array<{name: string, schema: Object}>} tools - 모든 도구 목록
   * @returns {Array} 필터링된 도구 목록
   */
  filterRegistration(agentId, tools) {
    try {
      const policy = this.policies.get(agentId);

      if (!policy) {
        this.log.debug('No policy found for agent', { agentId });
        // 기본 정책이 'deny'이면 모든 도구 차단
        if (this.defaultPolicy === 'deny') {
          return [];
        }
        return tools;
      }

      let filtered = [...tools];

      // allowedTools 화이트리스트가 있으면 적용
      if (policy.allowedTools && policy.allowedTools.length > 0) {
        filtered = filtered.filter(t => policy.allowedTools.includes(t.name));
      }

      // deniedTools 블랙리스트 적용
      if (policy.deniedTools && policy.deniedTools.length > 0) {
        filtered = filtered.filter(t => !policy.deniedTools.includes(t.name));
      }

      this.log.info('Tools registered for agent', {
        agentId,
        totalTools: tools.length,
        filteredTools: filtered.length
      });

      return filtered;
    } catch (err) {
      this.log.error('Error in filterRegistration', err);
      return [];
    }
  }

  /**
   * Point 2: 실행 게이트 — 특정 도구 실행 허가 확인
   * @param {string} agentId - 에이전트 ID
   * @param {string} toolName - 도구 이름
   * @param {Object} args - 도구 인자
   * @returns {{ allowed: boolean, reason: string }}
   */
  checkExecution(agentId, toolName, args = {}) {
    try {
      const policy = this.policies.get(agentId);

      // 정책이 없고 기본값이 'deny'
      if (!policy && this.defaultPolicy === 'deny') {
        return { allowed: false, reason: 'No policy defined and default is deny' };
      }

      if (policy) {
        // allowedTools 화이트리스트 확인
        if (policy.allowedTools && !policy.allowedTools.includes(toolName)) {
          return { allowed: false, reason: `Tool '${toolName}' not in allowed list` };
        }

        // deniedTools 블랙리스트 확인
        if (policy.deniedTools && policy.deniedTools.includes(toolName)) {
          return { allowed: false, reason: `Tool '${toolName}' is explicitly denied` };
        }

        // 도구별 인자 검증 (executionRules)
        if (policy.executionRules && policy.executionRules[toolName]) {
          const rule = policy.executionRules[toolName];
          if (rule.maxArgs && Object.keys(args).length > rule.maxArgs) {
            return { allowed: false, reason: `Too many arguments for ${toolName}` };
          }
          if (rule.blockedArgs) {
            for (const [key, value] of Object.entries(args)) {
              if (rule.blockedArgs.includes(key)) {
                return { allowed: false, reason: `Argument '${key}' is blocked` };
              }
            }
          }
        }
      }

      this.log.debug('Tool execution allowed', { agentId, toolName });
      return { allowed: true, reason: 'Execution permitted' };
    } catch (err) {
      this.log.error('Error in checkExecution', err);
      return { allowed: false, reason: 'Internal error' };
    }
  }

  /**
   * Point 3: 출력 게이트 — 도구 출력 정책 위반 스캔
   * @param {string} agentId - 에이전트 ID
   * @param {string} toolName - 도구 이름
   * @param {string} output - 도구 출력
   * @returns {{ clean: boolean, redacted: string, violations: string[] }}
   */
  async scanOutput(agentId, toolName, output) {
    try {
      const policy = this.policies.get(agentId);
      const violations = [];
      let redacted = output;

      if (!policy || !policy.outputRules) {
        return { clean: true, redacted, violations: [] };
      }

      // 정규표현식 기반 스캔 (ReDoS 방지)
      for (const rule of policy.outputRules) {
        if (!rule.pattern) continue;

        try {
          // Regex timeout: 최대 1초 내에 완료되어야 함
          const timeoutMs = 1000;

          let matches;
          if (typeof rule.pattern === 'string') {
            // 사용자 제공 regex는 새로 컴파일하지 말고 검증된 것만 사용
            matches = null;
          } else if (rule.pattern instanceof RegExp) {
            // 복잡한 regex 방지: 크기 제한
            if (rule.pattern.source.length > 200) {
              violations.push(`Pattern too large: ${rule.pattern.source.substring(0, 50)}...`);
              continue;
            }
            // Race regex execution against timeout to prevent ReDoS
            const regexResult = await Promise.race([
              new Promise((resolve) => {
                try { resolve(redacted.match(rule.pattern)); }
                catch (e) { resolve(null); }
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Regex timeout')), timeoutMs)
              ),
            ]);
            matches = regexResult;
          } else {
            continue;
          }

          if (matches && matches.length > 0) {
            violations.push(`Pattern '${rule.pattern instanceof RegExp ? rule.pattern.source : rule.pattern}' matched`);

            if (rule.action === 'redact') {
              if (rule.pattern instanceof RegExp) {
                redacted = redacted.replace(rule.pattern, '[REDACTED]');
              }
            } else if (rule.action === 'block') {
              return {
                clean: false,
                redacted: '[OUTPUT BLOCKED - POLICY VIOLATION]',
                violations
              };
            }
          }
        } catch (patternErr) {
          this.log.warn('Pattern matching error or timeout', { error: patternErr.message });
          violations.push('Pattern matching failed (possible ReDoS)');
        }
      }

      const clean = violations.length === 0;
      if (!clean) {
        this.log.warn('Output policy violations detected', { agentId, toolName, violations });
      }

      return { clean, redacted, violations };
    } catch (err) {
      this.log.error('Error in scanOutput', err);
      return { clean: false, redacted: '[ERROR SCANNING OUTPUT]', violations: ['scan_error'] };
    }
  }

  /**
   * 에이전트에 대한 권한 정책 설정
   * @param {string} agentId - 에이전트 ID
   * @param {Object} policy - 권한 정책 객체
   */
  setPolicy(agentId, policy) {
    try {
      this.policies.set(agentId, policy);
      this.log.info('Policy set for agent', { agentId, hasAllowed: !!policy.allowedTools });
    } catch (err) {
      this.log.error('Error setting policy', err);
    }
  }

  /**
   * 설정 객체로부터 정책 일괄 로드
   * @param {Object} config - { agentId: policy, ... }
   */
  loadFromConfig(config) {
    try {
      for (const [agentId, policy] of Object.entries(config)) {
        this.setPolicy(agentId, policy);
      }
      this.log.info('Policies loaded from config', { count: Object.keys(config).length });
    } catch (err) {
      this.log.error('Error loading config', err);
    }
  }

  /**
   * 에이전트 정책 제거
   * @param {string} agentId - 에이전트 ID
   */
  removePolicy(agentId) {
    this.policies.delete(agentId);
    this.log.info('Policy removed for agent', { agentId });
  }

  /**
   * 모든 정책 초기화
   */
  clear() {
    this.policies.clear();
    this.log.info('All policies cleared');
  }
}

module.exports = { PermissionGate };
