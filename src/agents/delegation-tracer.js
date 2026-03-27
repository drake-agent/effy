/**
 * delegation-tracer.js — 에이전트 위임 체인 추적 + 사용자 가시성.
 *
 * v3.9: AgentBus.ask()의 에이전트 A → B → C 체인을 실시간 추적하고,
 * 최종 응답에 "위임 경로 요약"을 자동 첨부한다.
 *
 * 문제: 사용자가 "마케팅팀 일정 알려줘"라고 질문하면 general → knowledge → ops
 * 순서로 위임이 일어나는데, 사용자에게는 최종 답변만 보임.
 * "누가 어떤 정보를 찾아서 답했는지" 투명성이 없음.
 *
 * 해결:
 * 1. AgentBus의 ask:complete/ask:error 이벤트를 수신하여 체인 기록
 * 2. 요청 ID(traceId) 기반으로 전체 위임 트리 추적
 * 3. 최종 응답에 첨부할 요약 생성 (Slack Block Kit 또는 텍스트)
 *
 * 사용:
 *   const tracer = new DelegationTracer();
 *   tracer.attachToBus(agentBus);
 *   // ... 에이전트 실행 ...
 *   const summary = tracer.summarize(traceId);
 */
const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');

const log = createLogger('agents:delegation-tracer');

/** 트레이스 TTL: 10분 후 자동 정리 */
const TRACE_TTL_MS = 10 * 60 * 1000;
/** 최대 보관 트레이스 수 */
const MAX_TRACES = 200;

class DelegationTracer extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, DelegationTrace>} — traceId → trace */
    this._traces = new Map();
    /** @type {Map<string, Set<string>>} — agentId → Set<traceId> (O(1) 역인덱스) */
    this._agentIndex = new Map();
    this._cleanupTimer = null;
  }

  /**
   * AgentBus에 이벤트 리스너 연결.
   * @param {Object} agentBus - AgentBus 인스턴스
   */
  attachToBus(agentBus) {
    if (!agentBus) return;

    agentBus.on('ask:complete', (evt) => this._onAskComplete(evt));
    agentBus.on('ask:error', (evt) => this._onAskError(evt));

    // 주기적 정리 (5분마다)
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);

    log.info('DelegationTracer attached to AgentBus');
  }

  /**
   * 새 트레이스 시작 — 최초 사용자 요청 시 호출.
   *
   * @param {string} requestId - 사용자 요청 식별자 (sessionKey 등)
   * @param {Object} context - { userId, channelId, query, agentId }
   * @returns {string} traceId
   */
  startTrace(requestId, context = {}) {
    const traceId = requestId || `trace-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const trace = {
      traceId,
      userId: context.userId || '',
      channelId: context.channelId || '',
      rootAgent: context.agentId || '',
      rootQuery: context.query || '',
      steps: [],
      startedAt: Date.now(),
      completedAt: null,
      status: 'active',
    };

    // 용량 관리
    if (this._traces.size >= MAX_TRACES) {
      this._evictOldest();
    }

    this._traces.set(traceId, trace);

    // 역인덱스 업데이트
    if (context.agentId) {
      this._indexAgent(context.agentId, traceId);
    }

    return traceId;
  }

  /**
   * 위임 스텝 수동 기록 (AgentBus 이벤트 외 수동 추가용).
   *
   * @param {string} traceId
   * @param {Object} step - { from, to, query, response, elapsed, success, cached }
   */
  addStep(traceId, step) {
    const trace = this._findTrace(traceId, step.from);
    if (!trace) return;

    trace.steps.push({
      from: step.from,
      to: step.to,
      query: (step.query || '').substring(0, 200),
      responsePreview: (step.response || '').substring(0, 150),
      elapsed: step.elapsed || 0,
      success: step.success !== false,
      cached: step.cached || false,
      timestamp: Date.now(),
    });

    // 역인덱스 업데이트
    if (step.from) this._indexAgent(step.from, trace.traceId);
    if (step.to) this._indexAgent(step.to, trace.traceId);
  }

  /**
   * 트레이스 완료.
   * @param {string} traceId
   */
  completeTrace(traceId) {
    const trace = this._traces.get(traceId);
    if (trace) {
      trace.completedAt = Date.now();
      trace.status = 'completed';
    }
  }

  /**
   * 위임 체인 요약 생성 — 사용자에게 보여줄 텍스트.
   *
   * @param {string} traceId
   * @param {Object} [opts]
   * @param {string} [opts.format='text'] - 'text' | 'slack_blocks' | 'markdown'
   * @returns {string|Array|null} 요약 텍스트 또는 Slack Block Kit 배열
   */
  summarize(traceId, opts = {}) {
    const trace = this._traces.get(traceId);
    if (!trace || trace.steps.length === 0) return null;

    const format = opts.format || 'text';

    if (format === 'slack_blocks') {
      return this._buildSlackBlocks(trace);
    } else if (format === 'markdown') {
      return this._buildMarkdown(trace);
    }
    return this._buildText(trace);
  }

  /**
   * 특정 traceId의 전체 스텝 목록.
   * @param {string} traceId
   * @returns {Array|null}
   */
  getSteps(traceId) {
    const trace = this._traces.get(traceId);
    return trace ? [...trace.steps] : null;
  }

  // ─── 내부 메서드 ───

  /** @private AgentBus ask:complete 이벤트 핸들러 */
  _onAskComplete(evt) {
    // 활성 트레이스 중 from이 포함된 것을 찾아 스텝 추가
    const trace = this._findTrace(null, evt.from);
    if (!trace) return;

    trace.steps.push({
      from: evt.from,
      to: evt.to,
      query: '',
      responsePreview: '',
      elapsed: evt.elapsed || 0,
      success: true,
      cached: false,
      timestamp: Date.now(),
    });
  }

  /** @private AgentBus ask:error 이벤트 핸들러 */
  _onAskError(evt) {
    const trace = this._findTrace(null, evt.from);
    if (!trace) return;

    trace.steps.push({
      from: evt.from,
      to: evt.to,
      query: '',
      responsePreview: '',
      elapsed: evt.elapsed || 0,
      success: false,
      error: evt.error || 'unknown error',
      timestamp: Date.now(),
    });
  }

  /** @private 활성 트레이스 찾기 (traceId 또는 agentId로) — O(1) 역인덱스 사용 */
  _findTrace(traceId, agentId) {
    if (traceId && this._traces.has(traceId)) {
      return this._traces.get(traceId);
    }

    // 역인덱스로 O(1) 조회
    if (agentId) {
      const traceIds = this._agentIndex.get(agentId);
      if (traceIds) {
        // 가장 최근 활성 트레이스 반환 (Set은 삽입 순서 유지)
        for (const id of [...traceIds].reverse()) {
          const trace = this._traces.get(id);
          if (trace && trace.status === 'active') return trace;
        }
      }
    }
    return null;
  }

  /** @private 역인덱스에 에이전트 등록 */
  _indexAgent(agentId, traceId) {
    if (!this._agentIndex.has(agentId)) {
      this._agentIndex.set(agentId, new Set());
    }
    this._agentIndex.get(agentId).add(traceId);
  }

  /** @private 텍스트 요약 생성 */
  _buildText(trace) {
    const totalElapsed = trace.completedAt
      ? trace.completedAt - trace.startedAt
      : Date.now() - trace.startedAt;
    const steps = trace.steps;
    const uniqueAgents = new Set(steps.flatMap(s => [s.from, s.to]));

    let text = `🔗 에이전트 협업 경로 (${uniqueAgents.size}개 에이전트, ${totalElapsed}ms)\n`;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const icon = s.success ? '✅' : '❌';
      const cached = s.cached ? ' (캐시)' : '';
      text += `  ${i + 1}. ${s.from} → ${s.to} ${icon}${cached} (${s.elapsed}ms)`;
      if (s.query) text += `\n     질문: "${s.query}"`;
      if (s.responsePreview) text += `\n     응답: "${s.responsePreview}..."`;
      if (s.error) text += `\n     오류: ${s.error}`;
      text += '\n';
    }

    return text;
  }

  /** @private Markdown 요약 생성 */
  _buildMarkdown(trace) {
    const steps = trace.steps;
    const totalElapsed = trace.completedAt
      ? trace.completedAt - trace.startedAt
      : Date.now() - trace.startedAt;
    const uniqueAgents = new Set(steps.flatMap(s => [s.from, s.to]));

    let md = `### 🔗 Agent Delegation Chain\n`;
    md += `**${uniqueAgents.size} agents** involved, **${totalElapsed}ms** total\n\n`;
    md += `| # | From | → | To | Status | Time |\n`;
    md += `|---|------|---|-------|--------|------|\n`;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const status = s.success ? '✅' : '❌';
      md += `| ${i + 1} | ${s.from} | → | ${s.to} | ${status} | ${s.elapsed}ms |\n`;
    }

    return md;
  }

  /** @private Slack Block Kit 요약 생성 */
  _buildSlackBlocks(trace) {
    const steps = trace.steps;
    const totalElapsed = trace.completedAt
      ? trace.completedAt - trace.startedAt
      : Date.now() - trace.startedAt;
    const uniqueAgents = new Set(steps.flatMap(s => [s.from, s.to]));
    const successCount = steps.filter(s => s.success).length;

    const blocks = [
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `🔗 *에이전트 협업* — ${uniqueAgents.size}개 에이전트, ${successCount}/${steps.length} 성공, ${totalElapsed}ms`,
        }],
      },
    ];

    // 시각적 체인: A → B → C
    const chain = [];
    for (const s of steps) {
      if (chain.length === 0 || chain[chain.length - 1] !== s.from) {
        chain.push(s.from);
      }
      chain.push(s.to);
    }

    const uniqueChain = [];
    for (const agent of chain) {
      if (uniqueChain[uniqueChain.length - 1] !== agent) uniqueChain.push(agent);
    }

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: uniqueChain.map(a => `\`${a}\``).join(' → '),
      },
    });

    return blocks;
  }

  /** @private TTL 초과 트레이스 정리 + stale active 트레이스 자동 완료 */
  _cleanup() {
    const now = Date.now();
    let cleaned = 0;
    let autoCompleted = 0;
    const STALE_ACTIVE_MS = 2 * 60 * 1000; // 2분 넘은 active 트레이스는 stale

    for (const [id, trace] of this._traces.entries()) {
      if (now - trace.startedAt > TRACE_TTL_MS) {
        this._removeTrace(id, trace);
        cleaned++;
      } else if (trace.status === 'active' && now - trace.startedAt > STALE_ACTIVE_MS) {
        // stale active → 자동 완료 (메모리 누수 방지)
        trace.status = 'completed';
        trace.completedAt = now;
        autoCompleted++;
      }
    }
    if (cleaned > 0 || autoCompleted > 0) {
      log.debug('Traces cleaned up', { cleaned, autoCompleted });
    }
  }

  /** @private 가장 오래된 트레이스 제거 */
  _evictOldest() {
    const oldest = this._traces.keys().next().value;
    if (oldest) {
      const trace = this._traces.get(oldest);
      this._removeTrace(oldest, trace);
    }
  }

  /** @private 트레이스 삭제 + 역인덱스 정리 */
  _removeTrace(traceId, trace) {
    this._traces.delete(traceId);
    if (trace) {
      // 역인덱스에서 이 traceId 제거
      const agents = new Set([trace.rootAgent, ...trace.steps.flatMap(s => [s.from, s.to])]);
      for (const agentId of agents) {
        const set = this._agentIndex.get(agentId);
        if (set) {
          set.delete(traceId);
          if (set.size === 0) this._agentIndex.delete(agentId);
        }
      }
    }
  }

  /** 통계 */
  getStats() {
    let active = 0;
    for (const t of this._traces.values()) {
      if (t.status === 'active') active++;
    }
    return {
      totalTraces: this._traces.size,
      activeTraces: active,
      completedTraces: this._traces.size - active,
      agentIndexSize: this._agentIndex.size,
    };
  }

  /** 정리 */
  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    this._traces.clear();
    this._agentIndex.clear();
  }
}

// ─── Singleton ───
let _tracer = null;
function getDelegationTracer() {
  if (!_tracer) _tracer = new DelegationTracer();
  return _tracer;
}
function resetDelegationTracer() {
  if (_tracer) _tracer.destroy();
  _tracer = null;
}

module.exports = { DelegationTracer, getDelegationTracer, resetDelegationTracer };
