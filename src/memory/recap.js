/**
 * recap.js — 구조화된 메시지 요약으로 컴팩션 시 도구 호출/결과 보존.
 * Structured Message Recap for Compaction
 *
 * 메시지 컴팩션 시 도구 호출명/인자/결과 명시적 보존 및 결정사항 추출.
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('memory/recap');

/**
 * 구조화된 메시지 요약 생성 클래스
 * StructuredRecap — 턴 컴팩션 시 핵심 정보 보존
 */
class StructuredRecap {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.maxRecapLength=2000] - 요약의 최대 문자 수
   * @param {boolean} [opts.preserveToolCalls=true] - 도구 호출 보존 여부
   * @param {boolean} [opts.preserveDecisions=true] - 결정사항 추출 여부
   */
  constructor(opts = {}) {
    this.maxRecapLength = opts.maxRecapLength ?? 2000;
    this.preserveToolCalls = opts.preserveToolCalls ?? true;
    this.preserveDecisions = opts.preserveDecisions ?? true;
  }

  /**
   * 컴팩션 대상 메시지들로부터 구조화된 요약 생성
   * @param {Array<Object>} messages - role/content/tool_calls/tool_results 포함
   * @returns {{
   *   recap: string,
   *   toolCallsSummary: Array<{tool: string, args: Object, result: string, timestamp: number}>,
   *   decisionsExtracted: Array<{decision: string, context: string}>,
   *   originalCount: number
   * }}
   */
  generate(messages) {
    try {
      if (!Array.isArray(messages) || messages.length === 0) {
        return {
          recap: '[메시지 없음]',
          toolCallsSummary: [],
          decisionsExtracted: [],
          originalCount: 0,
        };
      }

      const toolCalls = this.preserveToolCalls ? this.extractToolCalls(messages) : [];
      const decisions = this.preserveDecisions ? this.extractDecisions(messages) : [];

      let recapContent = [];

      if (toolCalls.length > 0) {
        recapContent.push('[도구 호출 요약]');
        toolCalls.forEach((tc) => {
          recapContent.push(`- ${tc.tool}(${JSON.stringify(tc.args).slice(0, 100)}...) → ${tc.result.slice(0, 80)}`);
        });
      }

      if (decisions.length > 0) {
        recapContent.push('[추출된 결정사항]');
        decisions.forEach((d) => {
          recapContent.push(`- ${d.decision}`);
          if (d.context) {
            recapContent.push(`  Context: ${d.context.slice(0, 100)}`);
          }
        });
      }

      const recap = recapContent.join('\n').slice(0, this.maxRecapLength);

      log.debug('Recap generated', {
        originalCount: messages.length,
        toolCallsCount: toolCalls.length,
        decisionsCount: decisions.length,
        recapLength: recap.length,
      });

      return {
        recap,
        toolCallsSummary: toolCalls,
        decisionsExtracted: decisions,
        originalCount: messages.length,
      };
    } catch (err) {
      log.error('Failed to generate recap', err);
      return {
        recap: '[요약 생성 실패]',
        toolCallsSummary: [],
        decisionsExtracted: [],
        originalCount: messages.length,
      };
    }
  }

  /**
   * 메시지 히스토리로부터 도구 호출 추출
   * @param {Array<Object>} messages
   * @returns {Array<{ tool: string, args: Object, result: string, timestamp: number }>}
   */
  extractToolCalls(messages) {
    const toolCalls = [];

    try {
      for (const msg of messages) {
        const timestamp = msg.timestamp || Date.now();

        // assistant 메시지의 tool_calls 배열 처리
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            toolCalls.push({
              tool: tc.function?.name || tc.type || 'unknown',
              args: typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments || {},
              result: '[pending]',
              timestamp,
            });
          }
        }

        // tool 역할 메시지에서 결과 수집
        if (msg.role === 'tool' && toolCalls.length > 0) {
          const lastToolCall = toolCalls[toolCalls.length - 1];
          if (lastToolCall.result === '[pending]') {
            lastToolCall.result = typeof msg.content === 'string'
              ? msg.content.slice(0, 200)
              : JSON.stringify(msg.content).slice(0, 200);
          }
        }
      }
    } catch (err) {
      log.warn('Error extracting tool calls', err);
    }

    return toolCalls;
  }

  /**
   * assistant 메시지로부터 핵심 결정사항 추출
   * @param {Array<Object>} messages
   * @returns {Array<{ decision: string, context: string }>}
   */
  extractDecisions(messages) {
    const decisions = [];
    const decisionKeywords = [
      '결정',
      '결정했다',
      '정하다',
      'decide',
      'decided',
      'will',
      'should',
      '우리는',
      '우리가',
      '계획',
      'plan',
      '다음',
      'next',
    ];

    try {
      for (const msg of messages) {
        if (msg.role === 'assistant' && msg.content) {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

          // 간단한 키워드 기반 결정사항 감지
          if (decisionKeywords.some((kw) => text.toLowerCase().includes(kw))) {
            const sentences = text.split(/[.!?]+/).filter(Boolean);
            const relevant = sentences
              .filter((s) => decisionKeywords.some((kw) => s.toLowerCase().includes(kw)))
              .map((s) => s.trim())
              .slice(0, 2);

            relevant.forEach((decision) => {
              if (decision.length > 10 && decision.length < 300) {
                decisions.push({
                  decision: decision.slice(0, 150),
                  context: text.slice(0, 100),
                });
              }
            });
          }
        }
      }
    } catch (err) {
      log.warn('Error extracting decisions', err);
    }

    return decisions.slice(0, 5); // 최대 5개 결정사항
  }

  /**
   * 요약을 시스템 메시지로 포맷
   * @param {Object} recapData - generate() 반환 객체
   * @returns {{ role: 'system', content: string }}
   */
  formatAsSystemMessage(recapData) {
    const content = [
      '[이전 대화 요약]',
      recapData.recap || '[정보 없음]',
      '',
    ];

    if (recapData.toolCallsSummary && recapData.toolCallsSummary.length > 0) {
      content.push('[도구 호출 기록]');
      recapData.toolCallsSummary.slice(0, 5).forEach((tc) => {
        content.push(`• ${tc.tool}: ${tc.result}`);
      });
    }

    return {
      role: 'system',
      content: content.join('\n'),
    };
  }
}

module.exports = { StructuredRecap };
