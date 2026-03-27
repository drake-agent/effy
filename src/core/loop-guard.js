/**
 * loop-guard.js — 에이전트 재귀 실행 명시적 감지 + 탈출.
 * SpaceBot LoopGuard 패턴: circuit-breaker보다 세밀한 루프 탐지.
 *
 * Explicit loop detection and prevention for agent calls.
 * Detects same-tool repetition, cycles, depth limits, and time limits.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('core:loop-guard');

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
     * 루프 감지 통계
     * @type {Object}
     */
    this.stats = {
      totalChecks: 0,
      repetitionWarnings: 0,
      cycleDetections: 0,
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

    // 3. 같은 도구 + 입력 반복 감지
    const repetitionCount = chain.filter(
      (call) => call.toolName === toolName && call.inputHash === inputHash
    ).length;

    if (repetitionCount >= this.maxRepetitions) {
      log.warn('Loop guard: repetition limit exceeded', {
        agentId,
        toolName,
        repetitions: repetitionCount,
        maxRepetitions: this.maxRepetitions,
      });
      this.stats.repetitionWarnings++;
      return 'break';
    } else if (repetitionCount >= this.maxRepetitions - 1) {
      log.warn('Loop guard: repetition approaching limit', {
        agentId,
        toolName,
        repetitions: repetitionCount + 1,
      });
      return 'warn';
    }

    // 4. 사이클 감지 (A → B → A)
    const lastCall = chain.length > 0 ? chain[chain.length - 1] : null;
    if (lastCall) {
      // 지난 2개 호출이 반복되는 패턴 확인
      if (
        chain.length >= 2 &&
        chain[chain.length - 1].toolName === toolName &&
        chain[chain.length - 2].toolName === toolName
      ) {
        log.warn('Loop guard: potential cycle detected', {
          agentId,
          recentTools: [
            chain[chain.length - 2].toolName,
            chain[chain.length - 1].toolName,
            toolName,
          ],
        });
        this.stats.cycleDetections++;
        return 'warn';
      }
    }

    // 호출 기록 추가
    chain.push({
      agentId,
      toolName,
      inputHash,
      timestamp: now,
    });

    // 시간이 오래되면 오래된 기록 정리
    const cutoffTime = now - this.maxDurationMs;
    const newChain = chain.filter((call) => call.timestamp > cutoffTime);
    this.callChains.set(agentId, newChain);

    return 'continue';
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
    // 간단한 구현 - 실제로는 crypto.createHash('sha256') 사용
    const str = JSON.stringify(input);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `hash_${Math.abs(hash)}`;
  }
}

module.exports = { LoopGuard };
