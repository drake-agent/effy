/**
 * branch-manager.js — Branch Manager (병렬 사고).
 *
 * Spacebot의 Branch 프로세스를 구현: runAgent를 병렬로 실행하여
 * 다중 사고 경로를 동시 진행하고 가장 빨리 완료된 결과 또는
 * 합의 결과를 반환.
 *
 * 특징:
 * - 세션별 동시성 제한 (maxBranchesPerSession)
 * - 타임아웃 관리 (branchTimeoutMs)
 * - 전략 선택: first_done | all | consensus
 * - 로깅 및 추적성
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('core:branch');

class BranchManager {
  /**
   * BranchManager 초기화.
   * @param {object} [options]
   * @param {number} [options.maxBranchesPerSession=3]
   * @param {number} [options.branchTimeoutMs=60000]
   */
  constructor(options = {}) {
    this._maxBranches = options.maxBranchesPerSession || 3;
    this._branchTimeout = options.branchTimeoutMs || 60000;
    this._maxResultsRetained = options.maxResultsRetained || 100;

    // sessionKey → Set<branchId> (활성 브랜치 추적)
    this._activeBranches = new Map();

    // sessionKey → AbortController (브랜치 취소용)
    this._abortControllers = new Map();

    // branchId → { status, result, error, durationMs, createdAt }
    // R1-003 fix: 상한 제한으로 메모리 누수 방지
    this._results = new Map();

    // 통계
    this._stats = {
      totalBranches: 0,
      successfulBranches: 0,
      failedBranches: 0,
      timedoutBranches: 0,
      consensusUsed: 0,
    };
  }

  /**
   * 병렬 브랜치 실행 — N개 사고 경로를 동시 실행, 전략에 따라 결과 반환.
   *
   * @param {string} sessionKey - 세션 식별자
   * @param {Array<object>} branches - 각 브랜치의 runAgent params
   *   [{ systemPrompt, messages, agentId, model, ... }, ...]
   * @param {Function} runAgentFn - runAgent 함수 참조
   * @param {object} [options]
   * @param {string} [options.strategy='first_done'] - 'first_done' | 'all' | 'consensus'
   * @returns {Promise<object>}
   *   { result, branchId, allResults, strategy, durationMs }
   */
  async executeBranches(sessionKey, branches, runAgentFn, options = {}) {
    const strategy = options.strategy || 'first_done';
    const startMs = Date.now();

    // 로깅
    log.info(`병렬 브랜치 시작: ${sessionKey}`, {
      count: branches.length,
      strategy,
      maxBranches: this._maxBranches,
    });

    // 동시성 상한
    const branchCount = Math.min(branches.length, this._maxBranches);
    const branchSlice = branches.slice(0, branchCount);

    // 활성 브랜치 추적
    if (!this._activeBranches.has(sessionKey)) {
      this._activeBranches.set(sessionKey, new Set());
    }
    const activeBranches = this._activeBranches.get(sessionKey);

    // R1-001 fix: AbortController로 브랜치 취소 지원
    const abortController = new AbortController();
    this._abortControllers.set(sessionKey, abortController);

    // 각 브랜치 실행
    const branchPromises = branchSlice.map((params, idx) => {
      const branchId = `${sessionKey}:branch:${idx}:${Date.now()}`;
      activeBranches.add(branchId);
      this._stats.totalBranches++;

      return this._executeSingleBranch(branchId, params, runAgentFn, abortController.signal)
        .finally(() => {
          activeBranches.delete(branchId);
          if (activeBranches.size === 0) {
            this._activeBranches.delete(sessionKey);
            this._abortControllers.delete(sessionKey);
          }
        });
    });

    try {
      let returnValue;

      if (strategy === 'first_done') {
        // Promise.any — 첫 성공 결과 반환
        returnValue = await Promise.any(branchPromises);
        // R1-001 fix: 나머지 브랜치 취소 (API 토큰 낭비 방지)
        abortController.abort();
        returnValue.strategy = 'first_done';
      } else if (strategy === 'all') {
        // 모든 브랜치 대기
        const results = await Promise.allSettled(branchPromises);
        const fulfilled = results
          .filter(r => r.status === 'fulfilled')
          .map((r, idx) => ({
            idx,
            branchId: branchSlice[idx]?.id || `branch_${idx}`,
            ...r.value,
          }));
        returnValue = {
          allResults: fulfilled,
          strategy: 'all',
          successCount: fulfilled.length,
          totalCount: results.length,
        };
      } else if (strategy === 'consensus') {
        // 모든 브랜치 실행, 합의 결과 도출
        const results = await Promise.allSettled(branchPromises);
        const fulfilled = results
          .filter(r => r.status === 'fulfilled')
          .map(r => r.value);

        // R1-001 fix: 합의할 결과가 없으면 에러 대신 throw → fallback 경로
        if (fulfilled.length === 0) {
          throw new Error('All branches failed (consensus requires at least 1 success)');
        }
        returnValue = this._selectConsensus(fulfilled);
        returnValue.strategy = 'consensus';
        this._stats.consensusUsed++;
      }

      const durationMs = Date.now() - startMs;
      returnValue.durationMs = durationMs;

      log.info(`병렬 브랜치 완료: ${sessionKey}`, {
        strategy,
        durationMs,
        successCount: strategy === 'all' ? returnValue.successCount : branchCount,
      });

      return returnValue;
    } catch (err) {
      const durationMs = Date.now() - startMs;
      log.error(`병렬 브랜치 실패: ${sessionKey}`, {
        strategy,
        error: err.message,
        durationMs,
      });
      throw err;
    }
  }

  /**
   * 단일 브랜치 실행 (타임아웃 래퍼).
   *
   * @private
   * @param {string} branchId
   * @param {object} params - runAgent 파라미터
   * @param {Function} runAgentFn - runAgent 함수
   * @returns {Promise<object>}
   */
  async _executeSingleBranch(branchId, params, runAgentFn, abortSignal) {
    const startMs = Date.now();

    // R1-001 fix: 타임아웃 핸들 저장 → 완료 시 정리 (타이머 누수 방지)
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`브랜치 타임아웃: ${this._branchTimeout}ms`));
      }, this._branchTimeout);
    });

    // R1-001 fix: AbortSignal 지원 — abort 시 즉시 reject
    let abortReject;
    const abortPromise = abortSignal
      ? new Promise((_, reject) => {
          abortReject = reject;
          if (abortSignal.aborted) { reject(new Error('Branch aborted')); return; }
          abortSignal.addEventListener('abort', () => reject(new Error('Branch aborted')), { once: true });
        })
      : null;

    const racers = [runAgentFn(params), timeoutPromise];
    if (abortPromise) racers.push(abortPromise);

    try {
      // runAgent, 타임아웃, 또는 abort 중 먼저 완료된 것 반환
      const result = await Promise.race(racers);
      clearTimeout(timeoutHandle);

      const durationMs = Date.now() - startMs;
      this._results.set(branchId, {
        status: 'success',
        result,
        durationMs,
        createdAt: Date.now(),
      });

      // R1-003 fix: _results 상한 제한
      if (this._results.size > this._maxResultsRetained) {
        const oldest = this._results.keys().next().value;
        this._results.delete(oldest);
      }

      this._stats.successfulBranches++;

      log.debug(`브랜치 성공: ${branchId}`, {
        durationMs,
        model: result.model,
        tokens: `${result.inputTokens}+${result.outputTokens}`,
      });

      return result;
    } catch (err) {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startMs;

      // R1-001 fix: abort된 브랜치는 조용히 reject (로그 불필요)
      if (err.message === 'Branch aborted') {
        this._results.set(branchId, { status: 'aborted', durationMs, createdAt: Date.now() });
        throw err;
      }

      if (err.message.includes('타임아웃')) {
        this._stats.timedoutBranches++;
        log.warn(`브랜치 타임아웃: ${branchId}`, { durationMs });
      } else {
        this._stats.failedBranches++;
        log.warn(`브랜치 실패: ${branchId}`, {
          error: err.message,
          durationMs,
        });
      }

      this._results.set(branchId, {
        status: 'error',
        error: err.message,
        durationMs,
      });

      throw err;
    }
  }

  /**
   * 합의 선택 — 가장 일반적인 답변 선택.
   *
   * @private
   * @param {Array<object>} results - 완료된 브랜치 결과들
   * @returns {object}
   */
  _selectConsensus(results) {
    if (results.length === 0) {
      throw new Error('합의할 결과 없음');
    }

    if (results.length === 1) {
      return { result: results[0], consensus: true, branchCount: 1 };
    }

    // 응답 텍스트로 grouping
    const grouped = new Map();
    results.forEach((r, idx) => {
      const text = r.text || '';
      const key = text.substring(0, 100); // 첫 100자로 비교
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key).push({ idx, result: r });
    });

    // 가장 많이 선택된 그룹 (합의)
    let maxGroup = null;
    let maxCount = 0;
    grouped.forEach((group, key) => {
      if (group.length > maxCount) {
        maxCount = group.length;
        maxGroup = group;
      }
    });

    if (!maxGroup) {
      // 어떤 그룹도 2개 이상 없으면 첫 결과 반환
      return { result: results[0], consensus: false, branchCount: results.length };
    }

    // 합의 결과 (가장 긴 응답 선택)
    const consensusResult = maxGroup.reduce((best, curr) => {
      const currLen = (curr.result.text || '').length;
      const bestLen = (best.result.text || '').length;
      return currLen > bestLen ? curr : best;
    });

    return {
      result: consensusResult.result,
      consensus: true,
      consensusCount: maxGroup.length,
      branchCount: results.length,
    };
  }

  /**
   * 세션의 활성 브랜치 수 조회.
   *
   * @param {string} sessionKey
   * @returns {number}
   */
  getActiveBranchCount(sessionKey) {
    return this._activeBranches.get(sessionKey)?.size || 0;
  }

  /**
   * 세션의 모든 브랜치 취소.
   *
   * @param {string} sessionKey
   */
  cancelBranches(sessionKey) {
    // R1-001 fix: AbortController를 통해 실제로 실행 중단
    const controller = this._abortControllers.get(sessionKey);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(sessionKey);
    }
    const activeBranches = this._activeBranches.get(sessionKey);
    if (activeBranches) {
      log.info(`브랜치 취소: ${sessionKey}`, {
        count: activeBranches.size,
      });
      activeBranches.clear();
      this._activeBranches.delete(sessionKey);
    }
  }

  /**
   * 통계 조회.
   *
   * @returns {object}
   */
  getStats() {
    return { ...this._stats };
  }

  /**
   * 통계 초기화.
   */
  resetStats() {
    this._stats = {
      totalBranches: 0,
      successfulBranches: 0,
      failedBranches: 0,
      timedoutBranches: 0,
      consensusUsed: 0,
    };
  }
}

module.exports = { BranchManager };
