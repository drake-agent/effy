/**
 * tier1-reflection.test.js — v3.6 Self-Improvement 모듈 단위 테스트.
 *
 * 6 Suites:
 * 1. ReflectionEngine — 교정 감지 (8 tests)
 * 2. ReflectionEngine — Outcome 감지 (5 tests)
 * 3. OutcomeTracker — 통계 집계 (5 tests)
 * 4. Committee — 의결 로직 (7 tests)
 * 5. Committee — 하이브리드 가중치 투표 (5 tests)
 * 6. VoteNotifier — 플랫폼 추상화 (4 tests)
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ReflectionEngine, CORRECTION_PATTERNS, POSITIVE_SIGNALS, NEGATIVE_SIGNALS } = require('../src/reflection/engine');
const { OutcomeTracker } = require('../src/reflection/outcome-tracker');
const { Committee, VOTE_OPTIONS } = require('../src/reflection/committee');
const { VoteNotifier, SlackVoteNotifier, WebhookVoteNotifier } = require('../src/reflection/vote-notifier');
const { sanitizeForPrompt, escapeXml, validateSchema } = require('../src/reflection/sanitize');

// ─── Mock Dependencies ───
function mockSemantic() {
  const saved = [];
  return {
    save: (entry) => { saved.push(entry); return `hash-${saved.length}`; },
    searchWithPools: () => [],
    _saved: saved,
  };
}

function mockRunLogger() {
  const logged = [];
  return {
    log: (entry) => logged.push(entry),
    _logged: logged,
  };
}

function mockAgentLoader() {
  return {
    buildSystemPrompt: (agentId) => `System prompt for ${agentId}`,
  };
}

function mockNotifier() {
  const sent = [];
  const confirmations = [];
  const broadcasts = [];
  return {
    platform: 'mock',
    sendVoteRequest: async (member, proposal, options) => { sent.push({ member, proposal, options }); },
    sendVoteConfirmation: async (member, vote, msg) => { confirmations.push({ member, vote, msg }); },
    broadcastDecision: async (members, proposal, decision) => { broadcasts.push({ members, proposal, decision }); },
    registerActionHandlers: (app, onVote) => { /* no-op for test */ },
    destroy: () => {},
    _sent: sent,
    _confirmations: confirmations,
    _broadcasts: broadcasts,
  };
}

// ═══════════════════════════════════════════════════════
// Suite 1: ReflectionEngine — 교정 감지
// ═══════════════════════════════════════════════════════

describe('ReflectionEngine — Correction Detection', () => {
  let engine;

  beforeEach(() => {
    engine = new ReflectionEngine({
      semantic: mockSemantic(),
      episodic: {},
      entity: {},
      runLogger: mockRunLogger(),
      config: { correctionThreshold: 0.6 },
    });
  });

  afterEach(() => { engine.destroy(); });

  it('should detect Korean direct correction "아니 그게 아니라"', () => {
    const result = engine.detectCorrection('아니 그게 아니라 이렇게 해야 해', 'session-1', { agentId: 'general', userId: 'u1' });
    assert.ok(result.detected);
    assert.ok(result.score >= 0.6);
  });

  it('should detect Korean repeated mistake "또 틀렸잖아"', () => {
    const result = engine.detectCorrection('또 틀렸잖아 제대로 해줘', 'session-2', { agentId: 'code', userId: 'u1' });
    assert.ok(result.detected);
    assert.ok(result.corrections.some(c => c.type === 'repeated_mistake'));
  });

  it('should detect English correction "No, that\'s not right"', () => {
    const result = engine.detectCorrection("No, that's not right. You should use the other API.", 'session-3', { agentId: 'code', userId: 'u1' });
    assert.ok(result.detected);
  });

  it('should detect English "I told you before"', () => {
    const result = engine.detectCorrection("I told you before, use the staging endpoint", 'session-4', { agentId: 'ops', userId: 'u1' });
    assert.ok(result.detected);
    assert.ok(result.corrections.some(c => c.type === 'repeated_mistake'));
  });

  it('should NOT detect normal conversation', () => {
    const result = engine.detectCorrection('오늘 배포 일정 알려줘', 'session-5', { agentId: 'general', userId: 'u1' });
    assert.ok(!result.detected);
    assert.equal(result.score, 0);
  });

  it('should NOT detect simple question', () => {
    const result = engine.detectCorrection('How do I set up the dev environment?', 'session-6', { agentId: 'code', userId: 'u1' });
    assert.ok(!result.detected);
  });

  it('should handle empty/null input gracefully', () => {
    assert.ok(!engine.detectCorrection('', 's', {}).detected);
    assert.ok(!engine.detectCorrection(null, 's', {}).detected);
    assert.ok(!engine.detectCorrection(undefined, 's', {}).detected);
  });

  it('should accumulate session corrections', () => {
    engine.detectCorrection('아니 그게 아니라 이렇게', 'session-7', { agentId: 'general', userId: 'u1' });
    engine.detectCorrection('또 틀렸잖아', 'session-7', { agentId: 'general', userId: 'u1' });
    const bucket = engine._sessionCorrections.get('session-7');
    assert.ok(bucket);
    assert.equal(bucket.corrections.length, 2);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: ReflectionEngine — Outcome 감지
// ═══════════════════════════════════════════════════════

describe('ReflectionEngine — Outcome Detection', () => {
  let engine;

  beforeEach(() => {
    engine = new ReflectionEngine({
      semantic: mockSemantic(),
      episodic: {},
      entity: {},
      runLogger: mockRunLogger(),
    });
  });

  afterEach(() => { engine.destroy(); });

  it('should detect positive sentiment "고마워"', () => {
    const result = engine.detectOutcome('고마워 잘 해결됐어');
    assert.equal(result.sentiment, 'positive');
    assert.ok(result.score >= 0.5);
  });

  it('should detect positive sentiment with emoji', () => {
    const result = engine.detectOutcome('👍 perfect');
    assert.equal(result.sentiment, 'positive');
  });

  it('should detect negative sentiment "틀렸"', () => {
    const result = engine.detectOutcome('아닌데 틀렸어');
    assert.equal(result.sentiment, 'negative');
  });

  it('should return neutral for normal text', () => {
    const result = engine.detectOutcome('다음 미팅은 언제야?');
    assert.equal(result.sentiment, 'neutral');
  });

  it('should handle empty/null input', () => {
    assert.equal(engine.detectOutcome('').sentiment, 'neutral');
    assert.equal(engine.detectOutcome(null).sentiment, 'neutral');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: OutcomeTracker — 통계 집계
// ═══════════════════════════════════════════════════════

describe('OutcomeTracker — Stats Aggregation', () => {
  let tracker;
  let logger;

  beforeEach(() => {
    logger = mockRunLogger();
    tracker = new OutcomeTracker({ runLogger: logger });
  });

  it('should record outcome and log to RunLogger', () => {
    tracker.recordOutcome({ agentId: 'general', traceId: 't1' }, { sentiment: 'positive' });
    assert.equal(logger._logged.length, 1);
    assert.equal(logger._logged[0].outcome.sentiment, 'positive');
  });

  it('should aggregate stats by agentId', () => {
    tracker.recordOutcome({ agentId: 'general' }, { sentiment: 'positive' });
    tracker.recordOutcome({ agentId: 'general' }, { sentiment: 'negative' });
    tracker.recordOutcome({ agentId: 'code' }, { sentiment: 'positive' });

    const report = tracker.getPerformanceReport();
    const generalStat = report.find(r => r.agentId === 'general');
    assert.equal(generalStat.total, 2);
    assert.equal(generalStat.positiveRate, '50.0%');
  });

  it('should track correction rate', () => {
    for (let i = 0; i < 10; i++) {
      tracker.recordOutcome({ agentId: 'ops' }, { sentiment: 'neutral', correctionDetected: i < 3 });
    }

    const health = tracker.checkAgentHealth('ops', 0.2);
    assert.ok(health.alert);
    assert.ok(health.correctionRate > 0.2);
  });

  it('should not alert when data is insufficient', () => {
    tracker.recordOutcome({ agentId: 'code' }, { sentiment: 'positive' });
    const health = tracker.checkAgentHealth('code', 0.2);
    assert.ok(!health.alert); // < 10 samples
  });

  it('should reset stats', () => {
    tracker.recordOutcome({ agentId: 'general' }, { sentiment: 'positive' });
    tracker.reset();
    assert.deepEqual(tracker.toJSON(), {});
  });
});

// ═══════════════════════════════════════════════════════
// Suite 4: Committee — 기본 의결 로직
// ═══════════════════════════════════════════════════════

describe('Committee — Voting Logic', () => {
  let committee;
  let semantic;

  beforeEach(() => {
    semantic = mockSemantic();
    committee = new Committee({
      agentLoader: mockAgentLoader(),
      semantic,
      config: {
        enabled: true,
        members: ['general', 'code', 'ops'],
        quorum: 2,
      },
    });
  });

  afterEach(() => { committee.destroy(); });

  it('should create proposal and return pending status', () => {
    const result = committee.createProposal({
      title: 'Test Proposal',
      description: 'Test',
      type: 'lesson_promotion',
      proposedBy: 'distiller',
    });
    assert.equal(result.status, 'pending');
    assert.ok(result.proposalId);
  });

  it('should auto-approve when committee is disabled', () => {
    const disabledCommittee = new Committee({
      agentLoader: mockAgentLoader(),
      semantic,
      config: { enabled: false },
    });
    const result = disabledCommittee.createProposal({ title: 'Test', description: 'Test', type: 'test', proposedBy: 'test' });
    assert.equal(result.status, 'auto_approved');
    disabledCommittee.destroy();
  });

  it('should list pending proposals', () => {
    committee.createProposal({ title: 'Proposal 1', description: 'A', type: 'test', proposedBy: 'distiller' });
    committee.createProposal({ title: 'Proposal 2', description: 'B', type: 'test', proposedBy: 'distiller' });
    const pending = committee.getPendingProposals();
    assert.equal(pending.length, 2);
  });

  it('should adjudicate approve when quorum met', () => {
    const proposal = {
      votes: new Map([
        ['general', { agentId: 'general', vote: 'approve', reasoning: 'Good', weight: 1 }],
        ['code', { agentId: 'code', vote: 'approve', reasoning: 'LGTM', weight: 1 }],
        ['ops', { agentId: 'ops', vote: 'defer', reasoning: 'Need data', weight: 1 }],
      ]),
    };
    const decision = committee._adjudicate(proposal);
    assert.equal(decision.status, 'approved');
    assert.equal(decision.counts.approve, 2);
  });

  it('should adjudicate reject when majority rejects', () => {
    const proposal = {
      votes: new Map([
        ['general', { agentId: 'general', vote: 'reject', reasoning: 'Risky', weight: 1 }],
        ['code', { agentId: 'code', vote: 'reject', reasoning: 'Not needed', weight: 1 }],
        ['ops', { agentId: 'ops', vote: 'approve', reasoning: 'OK', weight: 1 }],
      ]),
    };
    const decision = committee._adjudicate(proposal);
    assert.equal(decision.status, 'rejected');
  });

  it('should adjudicate defer when no quorum', () => {
    const proposal = {
      votes: new Map([
        ['general', { agentId: 'general', vote: 'approve', reasoning: 'OK', weight: 1 }],
        ['code', { agentId: 'code', vote: 'defer', reasoning: 'Not sure', weight: 1 }],
        ['ops', { agentId: 'ops', vote: 'defer', reasoning: 'Need time', weight: 1 }],
      ]),
    };
    const decision = committee._adjudicate(proposal);
    assert.equal(decision.status, 'deferred');
  });

  it('should export VOTE_OPTIONS', () => {
    assert.deepEqual(VOTE_OPTIONS, ['approve', 'reject', 'defer']);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 5: Committee — 하이브리드 가중치 투표
// ═══════════════════════════════════════════════════════

describe('Committee — Hybrid Weighted Voting', () => {
  let committee;
  let semantic;
  let notifier;

  beforeEach(() => {
    semantic = mockSemantic();
    notifier = mockNotifier();
    committee = new Committee({
      agentLoader: mockAgentLoader(),
      semantic,
      notifier,
      config: {
        enabled: true,
        members: ['general', 'code'],
        quorum: 2,
        humanMembers: [
          { id: 'drake', platformUserId: 'U12345', weight: 2, name: 'Drake' },
        ],
        humanVoteTimeoutMin: 1,
      },
    });
  });

  afterEach(() => { committee.destroy(); });

  it('should configure AI + human members', () => {
    assert.equal(committee.aiMembers.length, 2);
    assert.equal(committee.humanMembers.length, 1);
    assert.equal(committee.allMembers.length, 3);
    assert.equal(committee.humanMembers[0].weight, 2);
  });

  it('should adjudicate with weighted votes — human approve tips the scale', () => {
    const proposal = {
      votes: new Map([
        ['general', { agentId: 'general', vote: 'defer', reasoning: 'Hmm', weight: 1 }],
        ['code', { agentId: 'code', vote: 'defer', reasoning: 'Not sure', weight: 1 }],
        ['drake', { agentId: 'drake', vote: 'approve', reasoning: 'Go for it', isHuman: true, weight: 2 }],
      ]),
    };
    const decision = committee._adjudicate(proposal);
    // approve=2w >= quorum(2) → approved
    assert.equal(decision.status, 'approved');
    assert.equal(decision.counts.approve, 2);
    assert.equal(decision.totalWeight, 4);
  });

  it('should adjudicate with weighted votes — human reject + AI reject blocks', () => {
    const proposal = {
      votes: new Map([
        ['general', { agentId: 'general', vote: 'reject', reasoning: 'Bad idea', weight: 1 }],
        ['code', { agentId: 'code', vote: 'approve', reasoning: 'LGTM', weight: 1 }],
        ['drake', { agentId: 'drake', vote: 'reject', reasoning: 'No way', isHuman: true, weight: 2 }],
      ]),
    };
    const decision = committee._adjudicate(proposal);
    // reject=3w (general 1 + drake 2), total=4w, 3 > 4/2=2 → rejected
    assert.equal(decision.status, 'rejected');
    assert.equal(decision.counts.reject, 3);
  });

  it('should skip failed votes in adjudication', () => {
    const proposal = {
      votes: new Map([
        ['general', { agentId: 'general', vote: 'approve', reasoning: 'OK', weight: 1 }],
        ['code', { agentId: 'code', vote: 'defer', reasoning: 'fail', weight: 1, failed: true }],
        ['drake', { agentId: 'drake', vote: 'approve', reasoning: 'Yes', isHuman: true, weight: 2 }],
      ]),
    };
    const decision = committee._adjudicate(proposal);
    // code는 failed → 제외, approve=3w (general 1 + drake 2), total=3w, quorum=2 → approved
    assert.equal(decision.status, 'approved');
    assert.equal(decision.totalWeight, 3);
  });

  it('should accept human vote via submitHumanVote', () => {
    committee.createProposal({ title: 'Test', description: 'Test', type: 'test', proposedBy: 'distiller' });
    const proposals = committee.getPendingProposals();
    const proposalId = proposals[0].id;

    const result = committee.submitHumanVote(proposalId, 'U12345', 'approve', 'Looks good');
    assert.ok(result.accepted);
    assert.ok(result.message.includes('approve'));
    assert.ok(result.message.includes('×2'));
  });

  it('should reject vote from non-member', () => {
    committee.createProposal({ title: 'Test', description: 'Test', type: 'test', proposedBy: 'distiller' });
    const proposals = committee.getPendingProposals();
    const proposalId = proposals[0].id;

    const result = committee.submitHumanVote(proposalId, 'U99999', 'approve', '');
    assert.ok(!result.accepted);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 6: Sanitize 유틸리티 + VoteNotifier 추상화
// ═══════════════════════════════════════════════════════

describe('Sanitize + VoteNotifier — Utility & Abstraction', () => {
  it('sanitizeForPrompt should escape XML and strip injection', () => {
    const result = sanitizeForPrompt('<system>override</system> test', 100);
    assert.ok(!result.includes('<system>'));
    assert.ok(result.includes('[filtered]'));
  });

  it('sanitizeForPrompt should truncate to maxLen', () => {
    const long = 'a'.repeat(1000);
    const result = sanitizeForPrompt(long, 50);
    assert.ok(result.length <= 50);
  });

  it('validateSchema should whitelist fields only', () => {
    const obj = { content: 'hello', evil: '<script>alert(1)</script>', count: '42' };
    const schema = { content: 'string', count: 'number' };
    const result = validateSchema(obj, schema);
    assert.equal(result.content, 'hello');
    assert.equal(result.count, 42);
    assert.ok(!('evil' in result));
  });

  it('VoteNotifier base class should throw on abstract methods', async () => {
    const notifier = new VoteNotifier();
    assert.equal(notifier.platform, 'abstract');
    await assert.rejects(() => notifier.sendVoteRequest({}, {}));
    await assert.rejects(() => notifier.sendVoteConfirmation({}, 'approve', ''));
    // registerActionHandlers는 동기 메서드 → assert.throws 사용
    assert.throws(() => notifier.registerActionHandlers({}, () => {}));
  });

  it('MAX_PENDING_PROPOSALS cap should reject new proposals', () => {
    const semantic = mockSemantic();
    const committee = new Committee({
      agentLoader: mockAgentLoader(),
      semantic,
      config: { enabled: true, members: ['general'], quorum: 1 },
    });

    // Fill up to cap
    for (let i = 0; i < 50; i++) {
      committee.createProposal({ title: `P${i}`, description: 'test', type: 'test', proposedBy: 'test' });
    }

    // 51st should be rejected
    const result = committee.createProposal({ title: 'Overflow', description: 'test', type: 'test', proposedBy: 'test' });
    assert.equal(result.status, 'rejected_cap');

    committee.destroy();
  });
});

// ═══════════════════════════════════════════════════════
// Suite 7: Committee — 동적 멤버 관리 (/committee 커맨드)
// ═══════════════════════════════════════════════════════

describe('Committee — Dynamic Member Management', () => {
  let committee;

  beforeEach(() => {
    committee = new Committee({
      agentLoader: mockAgentLoader(),
      semantic: mockSemantic(),
      config: {
        enabled: true,
        members: ['general', 'code'],
        quorum: 2,
      },
    });
  });

  afterEach(() => { committee.destroy(); });

  it('should add a human member via addHumanMember', () => {
    const result = committee.addHumanMember({ platformUserId: 'U12345', name: 'Drake', weight: 2 });
    assert.ok(result.added);
    assert.equal(committee.humanMembers.length, 1);
    assert.equal(committee.allMembers.length, 3); // 2 AI + 1 human
  });

  it('should reject duplicate member', () => {
    committee.addHumanMember({ platformUserId: 'U12345', name: 'Drake' });
    const result = committee.addHumanMember({ platformUserId: 'U12345', name: 'Drake' });
    assert.ok(!result.added);
    assert.equal(committee.humanMembers.length, 1);
  });

  it('should remove a human member via removeHumanMember', () => {
    committee.addHumanMember({ platformUserId: 'U12345', name: 'Drake' });
    const result = committee.removeHumanMember('U12345');
    assert.ok(result.removed);
    assert.equal(committee.humanMembers.length, 0);
    assert.equal(committee.allMembers.length, 2); // AI only
  });

  it('should return status with getMemberStatus', () => {
    committee.addHumanMember({ platformUserId: 'U12345', name: 'Drake', weight: 2 });
    const status = committee.getMemberStatus();
    assert.equal(status.ai.length, 2);
    assert.equal(status.human.length, 1);
    assert.equal(status.quorum, 2);
    assert.equal(status.totalMaxWeight, 4); // AI 1+1 + human 2
    assert.ok(status.enabled);
  });

  it('should reject removal of non-member', () => {
    const result = committee.removeHumanMember('U99999');
    assert.ok(!result.removed);
  });
});
