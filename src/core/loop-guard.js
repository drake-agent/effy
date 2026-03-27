/**
 * loop-guard.js — 에이전트 재귀 실행 명시적 감지 + 탈출.
 * SpaceBot LoopGuard 패턴: circuit-breaker보다 세밀한 루프 탐지.
 *
 * Explicit loop detection and prevention for agent calls.
 * Detects same-tool repetition, cycles, depth limits, and time limits.
 *
 * v3.7.1 — outcome 해시 포이즈닝 방어, ping-pong 사이클 감지 (2/3원소)
 */
const crypto = require('crypto');
const { createLogger } = require('../shared/logger');

const log = createLogger('core:loop-guard');

/**
 * 관찰 전용 도구 — 루프 가드 체크 제외 대상
 * Observation-only tools exempted from loop guard checks
 */
const OBSERVATION_TOOLS = new Set([
  'memory_search', 'memory_list', 'memory_get',
  'list_channels', 'get_status', 'health_check',
  'get_metrics', 'describe_page',
]);

/**
 * LoopGuardVerdict — 루프 검증 결과
 * @typedef {'continue' | 'warn' | 'break' | 'escalate'} LoopGuardVerdict
 */

/**
 * CallRecord — 호출 기록
 * @typedef {Object} CallRecord
 * @property {string} agentId
 * @property {string} toolName
 * @property {string} inputHash
 * @property {number} timestamp
 */

/**
 * LoopGuard — 에이전트 재귀 루프 감지 및 차단
 * Detects and prevents agent execution loops
 */
class LoopGuard {
  constructor(opts = {}) {
    /**
     * 에이전트별 호출 체인 기록
     * @type {Map<string, CallRecord[]>}
     */
    this.callChains = new Map();

    /**
     * 최대 반복 횟수 (같은 도구 + 입력)
     * @type {number}
     */
    this.maxRepetitions = opts.maxRepetitions || 3;

    /**
     * 최대 중첩 깊이
     * @type {number}
     */
    this.maxDepth = opts.maxDepth || 5;

    /**
     * 최대 실행 시간 (ms) - 단일 체인
     * @type {number}
     */
    this.maxDurationMs = opts.maxDurationMs || 30000;

    /**
     * 관찰 도구 예외 목록 (사용자 추가 가능)
     * @type {Set<string>}
     */
    this.observationTools = new Set([
      ...OBSERVATION_TOOLS,
      ...(opts.observationTools || []),
    ]);

    /**
     * 루프 감지 통계
     * @type {Object}
     */
    this.stats = {
      totalChecks: 0,
      repetitionWarnings: 0,
      cycleDetections: 0,
      pingPongDetections: 0,
      depthExceeded: 0,
      timeoutExceeded: 0,
      breaks: 0,
    };

    log.info('LoopGuard initialized', {
      maxRepetitions: this.maxRepetitions,
      maxDepth: this.maxDepth,
      maxDurationMs: this.maxDurationMs,
    });
  }

  /**
   * 호출 체인 검사 및 루프 감지
   * Check call chain and detect loops
   *
   * @param {string} agentId - 에이전트 ID
   * @param {string} toolName - 도구 이름
   * @param {string} inputHash - 입력 해시 (SHA256 등)
   * @returns {LoopGuardVerdict} 검증 결과: 'continue' | 'warn' | 'break' | 'escalate'
   */
  check(agentId, toolName, inputHash) {
    this.stats.totalChecks++;

    // 관찰 도구는 루프 가드 체크 제외
    if (this.observationTools.has(toolName)) {
      return 'continue';
    }

    // 에이전트의 호출 체인 초기화
    if (!this.callChains.has(agentId)) {
      this.callChains.set(agentId, []);
    }

    const chain = this.callChains.get(agentId);
    const now = Date.now();
    const chainStart = chain.length > 0 ? chain[0].timestamp : now;

    // 1. 시간 제한 확인 (단일 체인이 너무 오래 실행)
    if (now - chainStart > this.maxDurationMs) {
      log.warn('Loop guard: time limit exceeded', {
        agentId,
        durationMs: now - chainStart,
        maxDurationMs: this.maxDurationMs,
      });
      this.stats.timeoutExceeded++;
      return 'break';
    }

    // 2. 깊이 제한 확인
    if (chain.length >= this.maxDepth) {
      log.warn('Loop guard: depth limit exceeded', {
        agentId,
        depth: chain.length,
        maxDepth: this.maxDepth,
      });
      this.stats.depthExceeded++;
      return 'escalate';
    }

    // 3. 같은 도구 + 입력 반복 감지 (포이즈닝 방어 해시 사용)
    const safeHash = LoopGuard.hashInput(inputHash);
    const repetitionCount = chain.filter(
      (call) => call.toolName === toolName && call.inputHash === safeHash
    ).length;

    if (repetitionCount >= this.maxRepetitions) {
      log.warn('Loop guard: repetition limit exceeded', {
        agentId,
        toolName,
        repetitions: repetitionCount,
        maxRepetitions: this.maxRepetitions,
      });
      this.stats.repetitionWarnings++;
      this.stats.breaks++;
      return 'break';
    }

    // 4. Ping-pong 사이클 감지 (A→B→A→B 2원소, A→B→C→A→B→C 3원소)
    const pingPong = this._detectPingPong(chain, toolName);
    if (pingPong) {
      log.warn('Loop guard: ping-pong cycle detected', {
        agentId,
        pattern: pingPong.pattern,
        elements: pingPong.elements,
      });
      this.stats.pingPongDetections++;
      this.stats.cycleDetections++;
      // 2원소 ping-pong은 break, 3원소는 warn (기록은 추가)
      if (pingPong.elements < 3) {
        this.stats.breaks++;
        return 'break';
      }
    }

    // 5. 판정 수집 (warn 수준 — 기록은 항상 추가)
    let verdict = pingPong ? 'warn' : 'continue';

    // 6. 반복 경고 (break 직전 단계)
    if (repetitionCount >= this.maxRepetitions - 1 && verdict === 'continue') {
      log.warn('Loop guard: repetition approaching limit', {
        agentId,
        toolName,
        repetitions: repetitionCount + 1,
      });
      verdict = 'warn';
    }

    // 7. 동일 도구 연속 호출 감지 (A→A→A)
    if (chain.length >= 2 && verdict === 'continue') {
      const last2 = chain.slice(-2);
      if (last2.every((c) => c.toolName === toolName)) {
        log.warn('Loop guard: same-tool triple call', {
          agentId,
          toolName,
        });
        this.stats.cycleDetections++;
        verdict = 'warn';
      }
    }

    // 호출 기록 추가 (warn 이하는 항상 기록 — break/escalate만 제외)
    chain.push({
      agentId,
      toolName,
      inputHash: safeHash,
      timestamp: now,
    });

    // 시간이 오래되면 오래된 기록 정리
    const cutoffTime = now - this.maxDurationMs;
    const newChain = chain.filter((call) => call.timestamp > cutoffTime);
    this.callChains.set(agentId, newChain);

    return verdict;
  }

  /**
   * Ping-pong 사이클 감지 (2원소: A→B→A→B, 3원소: A→B→C→A→B→C)
   * Detects alternating ping-pong cycles in tool call sequences
   *
   * @private
   * @param {CallRecord[]} chain - 호출 체인
   * @param {string} currentTool - 현재 도구 이름
   * @returns {{ pattern: string, elements: number } | null}
   */
  _detectPingPong(chain, currentTool) {
    const tools = chain.map((c) => c.toolName);
    tools.push(currentTool);

    // 2원소 ping-pong: A→B→A→B (최소 4개 필요)
    if (tools.length >= 4) {
      const a = tools[tools.length - 4];
      const b = tools[tools.length - 3];
      if (
        a !== b &&
        tools[tools.length - 2] === a &&
        tools[tools.length - 1] === b
      ) {
        return { pattern: `${a}→${b}→${a}→${b}`, elements: 2 };
      }
    }

    // 3원소 ping-pong: A→B→C→A→B→C (최소 6개 필요)
    if (tools.length >= 6) {
      const a = tools[tools.length - 6];
      const b = tools[tools.length - 5];
      const c = tools[tools.length - 4];
      if (
        a !== b && b !== c && a !== c &&
        tools[tools.length - 3] === a &&
        tools[tools.length - 2] === b &&
        tools[tools.length - 1] === c
      ) {
        return { pattern: `${a}→${b}→${c}→${a}→${b}→${c}`, elements: 3 };
      }
    }

    return null;
  }

  /**
   * 에이전트 리셋 (작업 완료 후)
   * Reset state for an agent (after task completion)
   *
   * @param {string} agentId - 에이전트 ID
   */
  reset(agentId) {
    if (this.callChains.has(agentId)) {
      const removed = this.callChains.get(agentId).length;
      this.callChains.delete(agentId);
      log.debug('Loop guard reset', { agentId, removedCalls: removed });
    }
  }

  /**
   * 모든 에이전트 리셋
   * Reset all agents
   */
  resetAll() {
    const count = this.callChains.size;
    this.callChains.clear();
    log.info('Loop guard reset all', { agentsReset: count });
  }

  /**
   * 루프 감지 통계 반환
   * Get loop detection statistics
   *
   * @returns {Object} 통계 객체
   */
  getStats() {
    return {
      ...this.stats,
      activeAgents: this.callChains.size,
      chains: Array.from(this.callChains.entries()).map(([agentId, chain]) => ({
        agentId,
        callCount: chain.length,
        tools: chain.map((c) => c.toolName),
      })),
    };
  }

  /**
   * 에이전트의 호출 체인 조회
   * Get call chain for an agent
   *
   * @param {string} agentId - 에이전트 ID
   * @returns {CallRecord[]} 호출 기록들
   */
  getChain(agentId) {
    return this.callChains.get(agentId) || [];
  }

  /**
   * 입력 해시 생성 (SHA256)
   * Generate hash from input (simple version, use crypto.createHash for production)
   *
   * @static
   * @param {*} input - 입력 데이터
   * @returns {string} 해시 문자열
   */
  static hashInput(input) {
    const str = typeof input === 'string' ? input : JSON.stringify(input);
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
  }
}

module.exports = { LoopGuard };
