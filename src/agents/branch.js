/**
 * branch.js — Branch Forking.
 *
 * Channel의 전체 대화 히스토리를 복제하여 독립적으로 추론.
 * Worker와 다른 점: Branch는 기존 맥락을 유지하면서 평행 사고.
 *
 * 동작:
 * 1. Channel 컨텍스트(메시지 히스토리 + 메모리) 스냅샷
 * 2. 독립 LLM 세션에서 추론 실행
 * 3. 결론만 Channel에 반환 (중간 과정은 숨김)
 * 4. 다수 Branch 동시 실행 가능 (첫 완료 우선)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('agent:branch');

class BranchManager {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxConcurrent=3] - 에이전트당 최대 동시 Branch
   * @param {number} [opts.maxTurns=10] - Branch 당 최대 LLM 턴
   * @param {number} [opts.timeoutMs=120000] - Branch 타임아웃 (2분)
   */
  constructor(opts = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? 3;
    this.maxTurns = opts.maxTurns ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 120000;

    /** @type {Map<string, Map<string, BranchInstance>>} agentId → Map<branchId, instance> */
    this._branches = new Map();

    /** @type {Map<string, { conclusion: string, branchId: string, durationMs: number }>} */
    this._results = new Map();
  }

  /**
   * Branch 생성 (컨텍스트 포크).
   *
   * @param {Object} opts
   * @param {string} opts.agentId - 부모 에이전트 ID
   * @param {string} opts.purpose - Branch 목적 (예: 'analyze_risk', 'compare_options')
   * @param {Array} opts.messages - 부모 대화 히스토리 복제본
   * @param {string} opts.systemPrompt - 시스템 프롬프트
   * @param {string} [opts.additionalContext] - 추가 지시사항
   * @returns {{ branchId: string, created: boolean, reason: string }}
   */
  create(opts) {
    const { agentId, purpose, messages = [], systemPrompt = '', additionalContext = '' } = opts;

    // 동시성 제한 확인
    const agentBranches = this._branches.get(agentId) || new Map();
    const activeBranches = Array.from(agentBranches.values()).filter(b => b.status === 'running');

    if (activeBranches.length >= this.maxConcurrent) {
      log.warn('Max concurrent branches reached', { agentId, active: activeBranches.length });
      return { branchId: null, created: false, reason: `Max concurrent branches (${this.maxConcurrent}) reached` };
    }

    const branchId = `branch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

    const instance = {
      branchId,
      agentId,
      purpose,
      messages: JSON.parse(JSON.stringify(messages)), // 딥카피 (독립 컨텍스트)
      systemPrompt: systemPrompt + (additionalContext ? `\n\n[Branch 지시]\n${additionalContext}` : ''),
      status: 'running', // running | completed | failed | timeout
      conclusion: null,
      startedAt: Date.now(),
      completedAt: null,
      turns: 0,
    };

    agentBranches.set(branchId, instance);
    this._branches.set(agentId, agentBranches);

    log.info('Branch created', { branchId, agentId, purpose, historyLen: messages.length });
    return { branchId, created: true, reason: 'Branch created successfully' };
  }

  /**
   * Branch 인스턴스 조회 (LLM 실행용).
   * @param {string} branchId
   * @returns {Object|null}
   */
  get(branchId) {
    for (const [, branches] of this._branches) {
      if (branches.has(branchId)) return branches.get(branchId);
    }
    return null;
  }

  /**
   * Branch 완료 기록.
   * @param {string} branchId
   * @param {string} conclusion - 결론 텍스트
   */
  complete(branchId, conclusion) {
    const branch = this.get(branchId);
    if (!branch) return;

    branch.status = 'completed';
    branch.conclusion = conclusion;
    branch.completedAt = Date.now();

    this._results.set(branchId, {
      conclusion,
      branchId,
      agentId: branch.agentId,
      purpose: branch.purpose,
      durationMs: branch.completedAt - branch.startedAt,
      turns: branch.turns,
    });

    log.info('Branch completed', {
      branchId,
      agentId: branch.agentId,
      durationMs: branch.completedAt - branch.startedAt,
    });
  }

  /**
   * Branch 실패 기록.
   * @param {string} branchId
   * @param {string} reason
   */
  fail(branchId, reason) {
    const branch = this.get(branchId);
    if (!branch) return;

    branch.status = 'failed';
    branch.completedAt = Date.now();
    log.warn('Branch failed', { branchId, reason });
  }

  /**
   * 에이전트의 활성 Branch 목록.
   * @param {string} agentId
   * @returns {Array}
   */
  getActive(agentId) {
    const branches = this._branches.get(agentId);
    if (!branches) return [];

    return Array.from(branches.values())
      .filter(b => b.status === 'running')
      .map(b => ({
        branchId: b.branchId,
        purpose: b.purpose,
        durationMs: Date.now() - b.startedAt,
        turns: b.turns,
      }));
  }

  /**
   * 완료된 Branch 결과 수집 (첫 완료 우선).
   * @param {string} agentId
   * @returns {Array}
   */
  harvestResults(agentId) {
    const branches = this._branches.get(agentId);
    if (!branches) return [];

    const completed = Array.from(branches.values())
      .filter(b => b.status === 'completed' && b.conclusion)
      .sort((a, b) => a.completedAt - b.completedAt) // 먼저 완료된 순
      .map(b => ({
        branchId: b.branchId,
        purpose: b.purpose,
        conclusion: b.conclusion,
        durationMs: b.completedAt - b.startedAt,
      }));

    // 수확된 결과 정리
    for (const result of completed) {
      branches.delete(result.branchId);
    }

    return completed;
  }

  /**
   * 타임아웃된 Branch 정리.
   */
  cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [agentId, branches] of this._branches) {
      for (const [branchId, branch] of branches) {
        if (branch.status === 'running' && (now - branch.startedAt) > this.timeoutMs) {
          branch.status = 'timeout';
          branch.completedAt = now;
          branches.delete(branchId);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) log.info('Expired branches cleaned', { cleaned });
  }
}

module.exports = { BranchManager };
