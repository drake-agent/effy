/**
 * committee.js — Effy Hybrid Committee: 하이브리드 의사결정 위원회.
 *
 * AI 에이전트 + 인간 멤버가 함께 투표하는 하이브리드 구조:
 *   - AI 멤버: LLM 호출로 즉시 투표 (가중치=1)
 *   - 인간 멤버: VoteNotifier로 플랫폼 알림 → 투표 수집 (가중치=2, 설정 가능)
 *
 * 플랫폼 추상화:
 *   Committee는 VoteNotifier 인터페이스에만 의존.
 *   Slack, Discord, Webhook 등 어떤 플랫폼이든 VoteNotifier 구현체만 교체하면 동작.
 *
 * 의결 과정:
 * 1. Proposal 생성 (Distiller 또는 Reflection에서 트리거)
 * 2. AI 멤버: 각자 SOUL.md 관점에서 LLM 투표 (병렬, 즉시)
 * 3. 인간 멤버: VoteNotifier → 플랫폼별 알림 전송 → 응답 대기 (타임아웃 설정 가능)
 * 4. 가중치 합산 의결: approve/reject/defer
 * 5. 결과 → L3 Semantic Memory에 Decision 타입으로 영구 기록
 *
 * 가중치 규칙:
 * - AI 멤버: weight=1 (기본)
 * - 인간 멤버: weight=2 (기본, config로 변경 가능)
 * - 정족수(quorum)도 가중치 기반으로 판정
 */
const { config } = require('../config');
const { client } = require('../shared/anthropic');
const { sanitizeForPrompt } = require('./sanitize');
const { createLogger } = require('../shared/logger');
const { getDefaultModel } = require('../shared/model-config');

const log = createLogger('reflection:committee');

// ─── 상수 ───
const VOTE_OPTIONS = ['approve', 'reject', 'defer'];
const MAX_PENDING_PROPOSALS = 50;
const COMPLETED_PROPOSAL_TTL_MS = 30 * 60 * 1000; // PERF-B: 완료 후 30분 뒤 메모리에서 삭제

class Committee {
  /**
   * @param {object} deps
   * @param {object} deps.agentLoader  - AgentLoader (SOUL.md 로딩)
   * @param {object} deps.semantic     - L3 Semantic Memory (의결 기록 저장)
   * @param {object} deps.notifier     - VoteNotifier 인스턴스 (플랫폼 추상화, nullable)
   * @param {object} deps.config       - committee config section
   */
  constructor({ agentLoader, semantic, notifier = null, config: committeeConfig = {} }) {
    this.agentLoader = agentLoader;
    this.semantic = semantic;
    this.notifier = notifier;

    // 설정
    this.enabled = committeeConfig.enabled !== false;
    this.quorum = committeeConfig.quorum ?? 2;
    this.votingOptions = committeeConfig.votingOptions || VOTE_OPTIONS;
    this.votingModel = committeeConfig.model || getDefaultModel();

    // AI 멤버 (weight=1)
    this.aiMembers = (committeeConfig.members || ['general', 'code', 'ops']).map(id => ({
      id,
      type: 'ai',
      weight: 1,
    }));

    // 인간 멤버 (weight=2 기본, config으로 변경 가능)
    // platformUserId: 플랫폼별 유저 식별자 (Slack User ID, Discord ID, etc.)
    this.humanMembers = (committeeConfig.humanMembers || []).map(h => ({
      id: h.id || `human:${h.platformUserId}`,
      platformUserId: h.platformUserId,
      type: 'human',
      weight: h.weight ?? 2,
      name: h.name || h.id || h.platformUserId,
    }));

    // CLEAN-A: allMembers는 getter로 동적 생성 (동기화 버그 방지)

    // 인간 투표 타임아웃 (분 → ms, 기본 60분)
    this.humanVoteTimeoutMs = (committeeConfig.humanVoteTimeoutMin ?? 60) * 60 * 1000;

    // 대기 중인 안건 (인메모리)
    this._pendingProposals = new Map();
    this._proposalCounter = 0;

    // 인간 투표 대기 Promise resolver (proposalId → { resolve, timer })
    this._humanWaiters = new Map();

    // PERF-B: 완료된 proposal TTL 삭제 타이머
    this._completedTimers = new Map();
  }

  // CLEAN-A: allMembers → getter (동기화 불필요)
  get allMembers() { return [...this.aiMembers, ...this.humanMembers]; }

  // ═══════════════════════════════════════════════════════
  // Proposal 생성
  // ═══════════════════════════════════════════════════════

  /**
   * 새 안건을 생성한다.
   *
   * @param {object} proposal
   * @param {string} proposal.title       - 안건 제목
   * @param {string} proposal.description - 안건 상세 설명
   * @param {string} proposal.type        - 'lesson_promotion' | 'soul_update' | 'process_change'
   * @param {string} proposal.proposedBy  - 제안자 (agentId 또는 'distiller')
   * @returns {{ proposalId: string, status: string }}
   */
  createProposal({ title, description, type, proposedBy }) {
    if (!this.enabled) {
      log.info('Committee disabled — auto-approving proposal');
      return { proposalId: null, status: 'auto_approved' };
    }

    // WARN-3: 대기 안건 상한
    if (this._pendingProposals.size >= MAX_PENDING_PROPOSALS) {
      log.warn(`Pending proposals cap reached (${MAX_PENDING_PROPOSALS}), rejecting new proposal`);
      return { proposalId: null, status: 'rejected_cap' };
    }

    this._proposalCounter++;
    const proposalId = `proposal-${Date.now()}-${this._proposalCounter}`;

    const proposal = {
      id: proposalId,
      title: String(title).slice(0, 200),
      description: String(description).slice(0, 1000),
      type: type || 'general',
      proposedBy: proposedBy || 'unknown',
      votes: new Map(),
      status: 'pending',
      createdAt: Date.now(),
    };

    this._pendingProposals.set(proposalId, proposal);
    log.info(`Proposal created: ${proposalId} — "${title}"`);

    return { proposalId, status: 'pending' };
  }

  // ═══════════════════════════════════════════════════════
  // 투표 수집 (AI 즉시 + 인간 비동기)
  // ═══════════════════════════════════════════════════════

  /**
   * 모든 위원회 멤버에게 투표를 요청한다.
   * AI: LLM 호출로 즉시 수집
   * 인간: VoteNotifier → 플랫폼별 알림 → 타임아웃 내 응답 대기
   *
   * @param {string} proposalId
   * @returns {{ proposalId, status, votes, decision }}
   */
  async collectVotes(proposalId) {
    const proposal = this._pendingProposals.get(proposalId);
    if (!proposal) {
      return { proposalId, status: 'not_found', votes: [] };
    }
    if (proposal.status !== 'pending') {
      return { proposalId, status: proposal.status, votes: this._serializeVotes(proposal) };
    }

    log.info(`Collecting votes for: ${proposalId} (AI=${this.aiMembers.length}, Human=${this.humanMembers.length})`);

    // 1. AI 멤버 투표 (병렬, 즉시)
    const aiVotePromises = this.aiMembers.map(member =>
      this._requestAiVote(member.id, proposal).catch(err => {
        log.warn(`AI vote failed for ${member.id}: ${err.message}`);
        return { agentId: member.id, vote: 'defer', reasoning: `투표 실패: ${err.message}`, failed: true };
      })
    );
    const aiVotes = await Promise.all(aiVotePromises);

    for (const vote of aiVotes) {
      proposal.votes.set(vote.agentId, { ...vote, isHuman: false, weight: 1 });
    }

    // 2. 인간 멤버 투표 (VoteNotifier 기반 플랫폼 알림 + 타임아웃 대기)
    if (this.humanMembers.length > 0 && this.notifier) {
      await this._collectHumanVotes(proposal);
    }

    // 3. 의결 판정 (가중치 기반)
    // BUG-3: 실제 투표가 하나도 없으면 의결 불가
    const successfulVotes = this._getSuccessfulVotes(proposal);
    if (successfulVotes.length === 0) {
      proposal.status = 'deferred';
      log.warn(`No successful votes for ${proposalId} — deferring`);
      return { proposalId, status: 'deferred', votes: this._serializeVotes(proposal) };
    }

    const decision = this._adjudicate(proposal);
    proposal.status = decision.status;

    // 의결 기록을 L3에 저장
    this._recordDecision(proposal, decision);

    // 의결 결과를 인간 멤버에게 브로드캐스트 (플랫폼 추상화)
    if (this.notifier && this.humanMembers.length > 0) {
      try {
        await this.notifier.broadcastDecision(this.humanMembers, proposal, decision);
      } catch (err) {
        log.warn(`Decision broadcast failed: ${err.message}`);
      }
    }

    log.info(`Proposal ${proposalId}: ${decision.status} (${decision.summary})`);

    // PERF-B: 의결 완료 proposal → 일정 시간 후 메모리에서 삭제
    this._scheduleProposalCleanup(proposalId);

    return {
      proposalId,
      status: decision.status,
      votes: this._serializeVotes(proposal),
      decision,
    };
  }

  // ═══════════════════════════════════════════════════════
  // AI 투표 (LLM 기반)
  // ═══════════════════════════════════════════════════════

  /** @private */
  async _requestAiVote(agentId, proposal) {
    let soulContext = '';
    try {
      soulContext = this.agentLoader.buildSystemPrompt(agentId, '');
      soulContext = soulContext.slice(0, 1000);
    } catch {
      soulContext = `Agent: ${agentId}`;
    }

    // SEC-1: proposal 내용을 sanitize하여 prompt injection 방지
    const safeTitle = sanitizeForPrompt(proposal.title, 200);
    const safeDesc = sanitizeForPrompt(proposal.description, 500);
    const safeProposedBy = sanitizeForPrompt(proposal.proposedBy, 50);

    const prompt = `당신은 Effy의 ${agentId} 에이전트입니다.
아래 안건에 대해 당신의 역할과 관점에서 투표하세요.

## 당신의 역할
${soulContext}

## 안건
제목: ${safeTitle}
유형: ${proposal.type}
설명: ${safeDesc}
제안자: ${safeProposedBy}

## 투표 옵션
- approve (찬성): 이 변경이 Effy 시스템을 개선한다
- reject (반대): 이 변경은 위험하거나 불필요하다
- defer (보류): 판단을 위해 더 많은 데이터/시간이 필요하다

## 출력 형식 (JSON만)
{ "vote": "approve|reject|defer", "reasoning": "투표 이유 (1-2문장)" }`;

    const response = await client.messages.create({
      model: this.votingModel,
      max_tokens: 200,
      system: '당신은 Effy 위원회 멤버입니다. JSON 형식으로만 투표하세요.',
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const vote = VOTE_OPTIONS.includes(parsed.vote) ? parsed.vote : 'defer';
        return {
          agentId,
          vote,
          reasoning: sanitizeForPrompt(parsed.reasoning || '', 300),
        };
      } catch (parseErr) { log.debug('Vote JSON parse failed', { agentId, error: parseErr.message }); }
    }

    return { agentId, vote: 'defer', reasoning: 'LLM 응답 파싱 실패', failed: true };
  }

  // ═══════════════════════════════════════════════════════
  // 인간 투표 (플랫폼 추상화 — VoteNotifier)
  // ═══════════════════════════════════════════════════════

  /**
   * 모든 인간 멤버에게 투표 요청 + 대기.
   * @private
   */
  async _collectHumanVotes(proposal) {
    // 각 인간 멤버에게 플랫폼별 알림 발송
    const notifyPromises = this.humanMembers.map(member =>
      this.notifier.sendVoteRequest(member, proposal, {
        timeoutMs: this.humanVoteTimeoutMs,
        voteOptions: VOTE_OPTIONS,
      }).catch(err => {
        log.warn(`Vote notification failed for ${member.name}: ${err.message}`);
        proposal.votes.set(member.id, {
          agentId: member.id,
          vote: 'defer',
          reasoning: `알림 발송 실패: ${err.message}`,
          isHuman: true,
          weight: member.weight,
          failed: true,
        });
      })
    );
    await Promise.all(notifyPromises);

    // 아직 투표하지 않은 인간 멤버가 있으면 타임아웃 대기
    const pendingHumans = this.humanMembers.filter(m => !proposal.votes.has(m.id));
    if (pendingHumans.length === 0) return;

    // Promise 기반 대기: submitHumanVote()이 resolve하거나, 타임아웃
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        for (const member of this.humanMembers) {
          if (!proposal.votes.has(member.id)) {
            proposal.votes.set(member.id, {
              agentId: member.id,
              vote: 'defer',
              reasoning: `투표 타임아웃 (${this.humanVoteTimeoutMs / 60000}분)`,
              isHuman: true,
              weight: member.weight,
              timedOut: true,
            });
          }
        }
        this._humanWaiters.delete(proposal.id);
        resolve();
      }, this.humanVoteTimeoutMs);

      this._humanWaiters.set(proposal.id, {
        resolve: () => {
          clearTimeout(timer);
          this._humanWaiters.delete(proposal.id);
          resolve();
        },
        timer,
        proposal,
      });
    });
  }

  /**
   * 인간 멤버의 투표를 접수한다.
   * VoteNotifier 액션 핸들러에서 호출.
   *
   * @param {string} proposalId    - 안건 ID
   * @param {string} platformUserId - 투표자 플랫폼 User ID
   * @param {string} vote          - 'approve' | 'reject' | 'defer'
   * @param {string} reasoning     - 투표 사유 (선택)
   * @returns {{ accepted: boolean, message: string }}
   */
  submitHumanVote(proposalId, platformUserId, vote, reasoning = '') {
    const proposal = this._pendingProposals.get(proposalId);
    if (!proposal) {
      return { accepted: false, message: '안건을 찾을 수 없습니다.' };
    }

    // BUG-B fix: 이미 의결 완료된 안건에 투표 접수 방지
    if (proposal.status !== 'pending') {
      return { accepted: false, message: `이미 의결 완료된 안건입니다 (${proposal.status}).` };
    }

    const member = this.humanMembers.find(m => m.platformUserId === platformUserId);
    if (!member) {
      return { accepted: false, message: '위원회 멤버가 아닙니다.' };
    }

    if (proposal.votes.has(member.id) && !proposal.votes.get(member.id).timedOut) {
      return { accepted: false, message: '이미 투표했습니다.' };
    }

    if (!VOTE_OPTIONS.includes(vote)) {
      return { accepted: false, message: `유효하지 않은 투표: ${vote}` };
    }

    proposal.votes.set(member.id, {
      agentId: member.id,
      vote,
      reasoning: sanitizeForPrompt(reasoning, 300),
      isHuman: true,
      weight: member.weight,
    });

    log.info(`Human vote received: ${member.name} → ${vote} for ${proposalId}`);

    // 모든 인간 투표 완료 시 → waiter resolve
    const allHumansVoted = this.humanMembers.every(m => {
      const v = proposal.votes.get(m.id);
      return v && !v.timedOut;
    });

    if (allHumansVoted) {
      const waiter = this._humanWaiters.get(proposalId);
      if (waiter) waiter.resolve();
    }

    return { accepted: true, message: `${vote} 투표가 접수되었습니다. (가중치 ×${member.weight})` };
  }

  // ═══════════════════════════════════════════════════════
  // 의결 판정 (가중치 기반)
  // ═══════════════════════════════════════════════════════

  /** @private */
  _adjudicate(proposal) {
    const counts = { approve: 0, reject: 0, defer: 0 };
    let totalWeight = 0;

    for (const [, v] of proposal.votes) {
      if (v.failed) continue;
      const w = v.weight || 1;
      counts[v.vote] = (counts[v.vote] || 0) + w;
      totalWeight += w;
    }

    const humanVotes = [...proposal.votes.values()].filter(v => v.isHuman && !v.failed && !v.timedOut);
    const humanSuffix = humanVotes.length > 0
      ? ` | 인간: ${humanVotes.map(v => `${v.agentId}=${v.vote}(×${v.weight})`).join(',')}`
      : '';
    const summary = `찬성=${counts.approve}w, 반대=${counts.reject}w, 보류=${counts.defer}w (총 ${totalWeight}w)${humanSuffix}`;

    // 1. reject가 과반 가중치 → 기각
    if (counts.reject > totalWeight / 2) {
      return { status: 'rejected', summary, counts, totalWeight };
    }
    // 2. approve가 정족수 가중치 이상 → 승인
    if (counts.approve >= this.quorum) {
      return { status: 'approved', summary, counts, totalWeight };
    }
    // 3. 그 외 → 보류
    return { status: 'deferred', summary, counts, totalWeight };
  }

  /** @private */
  _getSuccessfulVotes(proposal) {
    return [...proposal.votes.values()].filter(v => !v.failed);
  }

  /** @private */
  _recordDecision(proposal, decision) {
    try {
      const voteSummary = [...proposal.votes.entries()]
        .map(([, v]) => {
          const tag = v.isHuman ? '👤' : '🤖';
          const w = v.weight || 1;
          return `  ${tag} ${v.agentId}: ${v.vote}(×${w}) — ${v.reasoning || '(사유 없음)'}`;
        })
        .join('\n');

      const content = [
        `[Committee Decision] ${proposal.title}`,
        `유형: ${proposal.type}`,
        `제안자: ${proposal.proposedBy}`,
        `의결: ${decision.status} (${decision.summary})`,
        `투표 내역:`,
        voteSummary,
      ].join('\n');

      this.semantic.save({
        content,
        sourceType: 'committee_decision',
        tags: ['committee', proposal.type, decision.status],
        promotionReason: `Committee ${decision.status}: ${proposal.title}`,
        poolId: 'team',
        memoryType: 'Decision',
      });
    } catch (err) {
      log.warn(`Decision record failed: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // 편의 메서드
  // ═══════════════════════════════════════════════════════

  /** 안건 생성 + 즉시 투표 수집 + 의결까지 원스텝. */
  async proposeAndVote({ title, description, type, proposedBy }) {
    const { proposalId, status } = this.createProposal({ title, description, type, proposedBy });

    if (status === 'auto_approved') {
      return { proposalId: null, status: 'auto_approved', votes: [], decision: { status: 'approved', summary: 'committee disabled' } };
    }
    if (status === 'rejected_cap') {
      return { proposalId: null, status: 'rejected_cap', votes: [], decision: { status: 'rejected', summary: 'pending proposals cap' } };
    }

    return this.collectVotes(proposalId);
  }

  /** 대기 중인 안건 목록 조회. */
  getPendingProposals() {
    const pending = [];
    for (const [id, p] of this._pendingProposals) {
      if (p.status === 'pending') {
        pending.push({ id, title: p.title, type: p.type, proposedBy: p.proposedBy, createdAt: p.createdAt });
      }
    }
    return pending;
  }

  /**
   * VoteNotifier 액션 핸들러 등록.
   * 플랫폼별 앱 인스턴스에 투표 수신 핸들러를 바인딩.
   *
   * @param {object} platformApp - 플랫폼 앱 (Slack Bolt App, Express, etc.)
   */
  registerActionHandlers(platformApp) {
    if (!this.notifier || !platformApp) return;

    this.notifier.registerActionHandlers(platformApp, (proposalId, platformUserId, vote, reasoning) => {
      return this.submitHumanVote(proposalId, platformUserId, vote, reasoning);
    });
  }

  /** @private */
  _serializeVotes(proposal) {
    return [...proposal.votes.values()].map(v => ({
      agentId: v.agentId,
      vote: v.vote,
      reasoning: v.reasoning,
      isHuman: !!v.isHuman,
      weight: v.weight || 1,
    }));
  }

  // ═══════════════════════════════════════════════════════
  // 동적 멤버 관리 (/committee 슬래시 커맨드용)
  // ═══════════════════════════════════════════════════════

  /**
   * 인간 멤버를 위원회에 추가한다.
   *
   * @param {object} member
   * @param {string} member.platformUserId - 플랫폼 유저 ID (Slack: U07XXXXXXXX)
   * @param {string} member.name           - 표시 이름
   * @param {number} member.weight         - 투표 가중치 (기본 2)
   * @returns {{ added: boolean, message: string }}
   */
  addHumanMember({ platformUserId, name, weight = 2 }) {
    if (!platformUserId) {
      return { added: false, message: 'platformUserId가 필요합니다.' };
    }

    const existing = this.humanMembers.find(m => m.platformUserId === platformUserId);
    if (existing) {
      return { added: false, message: `이미 위원회 멤버입니다: ${existing.name} (×${existing.weight})` };
    }

    // BUG-A fix: id는 항상 platformUserId 기반 → 고유성 보장 (이름 중복 방지)
    const id = `human:${platformUserId}`;
    const member = {
      id,
      platformUserId,
      type: 'human',
      weight,
      name: name || platformUserId,
    };

    this.humanMembers.push(member);
    // CLEAN-A: allMembers는 getter → push 불필요

    log.info(`Human member added: ${member.name} (${platformUserId}, ×${weight})`);
    return { added: true, message: `위원회 가입 완료: ${member.name} (가중치 ×${weight})` };
  }

  /**
   * 인간 멤버를 위원회에서 제거한다.
   *
   * @param {string} platformUserId - 플랫폼 유저 ID
   * @returns {{ removed: boolean, message: string }}
   */
  removeHumanMember(platformUserId) {
    const idx = this.humanMembers.findIndex(m => m.platformUserId === platformUserId);
    if (idx === -1) {
      return { removed: false, message: '위원회 멤버가 아닙니다.' };
    }

    const removed = this.humanMembers.splice(idx, 1)[0];
    // CLEAN-A: allMembers는 getter → splice 불필요

    log.info(`Human member removed: ${removed.name} (${platformUserId})`);
    return { removed: true, message: `위원회 탈퇴 완료: ${removed.name}` };
  }

  /**
   * 현재 위원회 멤버 목록을 반환한다.
   *
   * @returns {{ ai: Array, human: Array, quorum: number, totalMaxWeight: number }}
   */
  getMemberStatus() {
    const ai = this.aiMembers.map(m => ({ id: m.id, type: 'ai', weight: m.weight }));
    const human = this.humanMembers.map(m => ({
      id: m.id,
      name: m.name,
      platformUserId: m.platformUserId,
      type: 'human',
      weight: m.weight,
    }));
    const totalMaxWeight = ai.reduce((s, m) => s + m.weight, 0) + human.reduce((s, m) => s + m.weight, 0);

    return { ai, human, quorum: this.quorum, totalMaxWeight, enabled: this.enabled };
  }

  // ═══════════════════════════════════════════════════════
  // PERF-B: 완료 proposal 메모리 정리
  // ═══════════════════════════════════════════════════════

  /** @private */
  _scheduleProposalCleanup(proposalId) {
    const timer = setTimeout(() => {
      this._pendingProposals.delete(proposalId);
      this._completedTimers.delete(proposalId);
      log.info(`Completed proposal cleaned up: ${proposalId}`);
    }, COMPLETED_PROPOSAL_TTL_MS);

    // unref()로 Node.js 종료 차단 방지
    if (timer.unref) timer.unref();
    this._completedTimers.set(proposalId, timer);
  }

  /** 정리. */
  destroy() {
    for (const [, waiter] of this._humanWaiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
    }
    this._humanWaiters.clear();

    // PERF-B: 정리 타이머 해제
    for (const [, timer] of this._completedTimers) {
      clearTimeout(timer);
    }
    this._completedTimers.clear();

    const count = this._pendingProposals.size;
    this._pendingProposals.clear();

    if (this.notifier) {
      try { this.notifier.destroy(); } catch (_) { /* best-effort */ }
    }

    log.info(`Committee destroyed (${count} pending proposals cleared)`);
  }
}

module.exports = { Committee, VOTE_OPTIONS };
