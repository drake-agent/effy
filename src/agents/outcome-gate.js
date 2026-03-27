/**
 * outcome-gate.js — Outcome 검증 게이트 (SpaceBot 차용).
 *
 * LLM이 텍스트만 생성하고 종료하는 것을 방지.
 * 실제 도구 호출 또는 명시적 완료 시그널이 없으면 재시도 또는 경고.
 *
 * SpaceBot: Worker가 text-only exit하면 차단.
 * Effy 구현: Agentic Loop 후 결과 검증 미들웨어.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('outcome-gate');

/**
 * Outcome 유형.
 * @typedef {'tool_executed' | 'text_only' | 'error' | 'max_turns'} OutcomeType
 */

/**
 * Outcome Gate — Agent 실행 결과 검증.
 */
class OutcomeGate {
  /**
   * @param {Object} [opts]
   * @param {boolean} [opts.requireToolUse=false] - true면 도구 호출 없이 종료 시 재시도
   * @param {number} [opts.maxRetries=1] - text-only 시 최대 재시도 횟수
   * @param {string[]} [opts.exemptAgents=[]] - 게이트 면제 에이전트 ID
   * @param {string[]} [opts.requiredSignals=[]] - 필수 완료 시그널 (예: 'task_complete')
   */
  constructor(opts = {}) {
    this.requireToolUse = opts.requireToolUse ?? false;
    this.maxRetries = opts.maxRetries ?? 1;
    this.exemptAgents = new Set(opts.exemptAgents || []);
    this.requiredSignals = opts.requiredSignals || [];
  }

  /**
   * Agent 실행 결과 평가.
   *
   * @param {Object} result - Agent 실행 결과
   * @param {string} result.agentId - 에이전트 ID
   * @param {string} result.responseText - LLM 응답 텍스트
   * @param {Array} result.toolCalls - 실행된 도구 호출 목록
   * @param {number} result.turnCount - 실행된 턴 수
   * @param {number} result.maxTurns - 최대 턴
   * @param {Object} [result.metadata] - 추가 메타데이터
   * @returns {{ passed: boolean, outcome: OutcomeType, reason: string, shouldRetry: boolean }}
   */
  evaluate(result) {
    const { agentId, responseText, toolCalls = [], turnCount = 0, maxTurns = 0, metadata = {} } = result;

    // 면제 에이전트
    if (this.exemptAgents.has(agentId)) {
      return { passed: true, outcome: 'tool_executed', reason: 'Agent exempt from gate', shouldRetry: false };
    }

    // max_turns 도달 시
    if (maxTurns > 0 && turnCount >= maxTurns) {
      log.warn('Max turns reached', { agentId, turnCount, maxTurns });
      return { passed: true, outcome: 'max_turns', reason: `Max turns reached (${turnCount}/${maxTurns})`, shouldRetry: false };
    }

    // 도구 호출 여부 확인
    const hasToolCalls = toolCalls.length > 0;
    const successfulTools = toolCalls.filter(t => t.success !== false);

    // 필수 시그널 확인
    if (this.requiredSignals.length > 0) {
      const signalsMet = this.requiredSignals.every(signal =>
        toolCalls.some(t => t.name === signal) || metadata[signal]
      );
      if (!signalsMet) {
        log.warn('Required signals not met', { agentId, required: this.requiredSignals });
        return {
          passed: false,
          outcome: 'text_only',
          reason: `Required signals missing: ${this.requiredSignals.join(', ')}`,
          shouldRetry: true,
        };
      }
    }

    // requireToolUse 모드
    if (this.requireToolUse && !hasToolCalls) {
      log.warn('Text-only response detected', {
        agentId,
        responseLen: (responseText || '').length,
        toolCalls: 0,
      });
      return {
        passed: false,
        outcome: 'text_only',
        reason: 'No tool calls executed — text-only response',
        shouldRetry: true,
      };
    }

    // 도구 호출은 있으나 모두 실패
    if (hasToolCalls && successfulTools.length === 0) {
      log.warn('All tool calls failed', { agentId, totalTools: toolCalls.length });
      return {
        passed: false,
        outcome: 'error',
        reason: `All ${toolCalls.length} tool calls failed`,
        shouldRetry: true,
      };
    }

    // 정상 통과
    return {
      passed: true,
      outcome: hasToolCalls ? 'tool_executed' : 'text_only',
      reason: hasToolCalls
        ? `${successfulTools.length}/${toolCalls.length} tools succeeded`
        : 'Text-only response (gate not enforced)',
      shouldRetry: false,
    };
  }

  /**
   * 재시도 프롬프트 생성.
   * 텍스트만 생성한 경우, LLM에게 실제 행동을 요구하는 추가 프롬프트.
   *
   * @param {Object} evaluation - evaluate() 결과
   * @returns {string} 재시도 프롬프트
   */
  getRetryPrompt(evaluation) {
    if (evaluation.outcome === 'text_only') {
      return '이전 응답은 텍스트만 포함되어 있습니다. 실제로 도구를 사용하여 작업을 수행해 주세요. 단순히 설명하는 것이 아니라, 요청된 작업을 실행하세요.';
    }
    if (evaluation.outcome === 'error') {
      return '이전 도구 호출이 모두 실패했습니다. 다른 접근 방법을 시도하거나, 실패 원인을 분석하고 재시도해 주세요.';
    }
    return '';
  }
}

module.exports = { OutcomeGate };
