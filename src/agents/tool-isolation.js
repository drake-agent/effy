/**
 * tool-isolation.js — 프로세스별 도구 격리 (SpaceBot 차용).
 *
 * Channel/Branch/Worker/Cortex 각 프로세스 타입에 다른 도구 세트를 부여.
 * SpaceBot에서 Channel은 도구를 직접 실행하지 않고 위임만 수행.
 *
 * 프로세스 타입별 도구 정책:
 * - channel: 통신 + 위임 도구만 (실행 도구 없음)
 * - branch: 검색 + 메모리 도구 (실행 도구 제한적)
 * - worker: 전체 도구 접근 (실행 + 파일 + 검색 + 메모리)
 * - cortex: 메모리 + 관찰 도구만
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('tool-isolation');

/**
 * 프로세스 타입별 도구 접근 정책.
 *
 * allow: 허용된 도구 이름 목록 (빈 배열 = 모든 도구 허용)
 * deny: 거부된 도구 이름 목록 (allow보다 우선)
 * description: 정책 설명
 */
const DEFAULT_POLICIES = {
  channel: {
    description: 'Channel은 위임만 수행 — 실행 도구 사용 불가',
    allow: [
      // 통신
      'send_slack_message', 'send_teams_message', 'reply_in_thread',
      // 위임
      'delegate_to_worker', 'spawn_branch',
      // 검색 (읽기 전용)
      'search_knowledge', 'search_memory', 'search_decisions',
      // 메모리 읽기
      'get_entity', 'get_channel_context',
      // 스킬
      'search_skills', 'list_skills',
    ],
    deny: [
      'shell_exec', 'file_write', 'file_read', 'http_request',
      'sql_query', 'create_task', 'create_incident',
    ],
  },

  branch: {
    description: 'Branch는 사고 + 검색 — 외부 부작용 제한',
    allow: [
      // 검색 (읽기 전용)
      'search_knowledge', 'search_memory', 'search_decisions', 'search_semantic',
      // 메모리 읽기/쓰기
      'save_knowledge', 'get_entity', 'get_channel_context',
      // 파일 읽기만
      'file_read', 'list_directory',
      // Worker 감사
      'inspect_worker',
    ],
    deny: [
      'shell_exec', 'file_write', 'http_request',
      'send_slack_message', 'send_teams_message',
      'create_incident',
    ],
  },

  worker: {
    description: 'Worker는 전체 도구 접근 (실행자)',
    allow: [], // 모든 도구 허용
    deny: [
      // Worker끼리 위임 불가 (무한 루프 방지)
      'delegate_to_worker', 'spawn_branch',
    ],
  },

  cortex: {
    description: 'Cortex는 관찰 + 메모리 관리만',
    allow: [
      'search_knowledge', 'search_memory', 'search_decisions',
      'save_knowledge', 'get_entity',
      'get_channel_context', 'list_skills',
    ],
    deny: [
      'shell_exec', 'file_write', 'file_read', 'http_request',
      'send_slack_message', 'send_teams_message',
      'delegate_to_worker', 'spawn_branch',
      'create_task', 'create_incident',
    ],
  },
};

class ToolIsolation {
  /**
   * @param {Object} [customPolicies] - 기본 정책 위에 오버라이드
   */
  constructor(customPolicies = {}) {
    this.policies = { ...DEFAULT_POLICIES };

    // 커스텀 정책 병합
    for (const [processType, policy] of Object.entries(customPolicies)) {
      if (this.policies[processType]) {
        this.policies[processType] = {
          ...this.policies[processType],
          ...policy,
          allow: policy.allow || this.policies[processType].allow,
          deny: policy.deny || this.policies[processType].deny,
        };
      } else {
        this.policies[processType] = policy;
      }
    }
  }

  /**
   * 도구 사용 허용 여부 확인.
   *
   * @param {string} processType - channel | branch | worker | cortex
   * @param {string} toolName - 도구 이름
   * @returns {{ allowed: boolean, reason: string }}
   */
  check(processType, toolName) {
    const policy = this.policies[processType];
    if (!policy) {
      // 알 수 없는 프로세스 타입 → 기본 거부 (fail-secure)
      log.warn('Unknown process type', { processType, toolName });
      return { allowed: false, reason: `Unknown process type: ${processType} (default deny)` };
    }

    // deny 목록 우선 확인
    if (policy.deny && policy.deny.includes(toolName)) {
      log.debug('Tool denied by policy', { processType, toolName });
      return {
        allowed: false,
        reason: `Tool '${toolName}' denied for process type '${processType}': ${policy.description}`,
      };
    }

    // allow 목록이 비어있으면 모든 도구 허용
    if (!policy.allow || policy.allow.length === 0) {
      return { allowed: true, reason: 'All tools allowed for this process type' };
    }

    // allow 목록에 있는지 확인
    if (policy.allow.includes(toolName)) {
      return { allowed: true, reason: 'Tool in allow list' };
    }

    log.debug('Tool not in allow list', { processType, toolName });
    return {
      allowed: false,
      reason: `Tool '${toolName}' not in allow list for '${processType}': ${policy.description}`,
    };
  }

  /**
   * 특정 프로세스 타입에 허용된 도구 목록 필터링.
   *
   * @param {string} processType
   * @param {Array<{name: string}>} allTools - 전체 도구 목록
   * @returns {Array<{name: string}>}
   */
  filterTools(processType, allTools) {
    return allTools.filter(tool => this.check(processType, tool.name).allowed);
  }

  /**
   * 프로세스 타입별 정책 요약.
   * @returns {Object}
   */
  getPolicySummary() {
    const summary = {};
    for (const [type, policy] of Object.entries(this.policies)) {
      summary[type] = {
        description: policy.description,
        allowCount: policy.allow?.length || 0,
        denyCount: policy.deny?.length || 0,
        mode: (!policy.allow || policy.allow.length === 0) ? 'allow-all-except-deny' : 'deny-all-except-allow',
      };
    }
    return summary;
  }
}

module.exports = { ToolIsolation, DEFAULT_POLICIES };
