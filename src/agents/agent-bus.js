/**
 * agent-bus.js — 에이전트 간 실제 통신 버스.
 *
 * 기존 Mailbox(비동기 큐) + CommGraph(권한) 위에 구축하여
 * 에이전트가 다른 에이전트에게 **동기적으로 질문하고 답을 받을 수 있게** 한다.
 *
 * 모드:
 * - ask(from, to, query)     → 타겟 에이전트 즉시 실행, 결과 대기 (동기)
 * - tell(from, to, message)  → Mailbox 큐잉 (비동기, fire-and-forget)
 * - broadcast(from, query)   → 연결된 모든 에이전트에 질문, 결과 취합
 *
 * 의존성:
 * - CommGraph: 통신 권한 확인
 * - Mailbox: 비동기 메시지 저장
 * - AgentLoader + Runtime: 타겟 에이전트 즉시 실행
 */
const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');

const log = createLogger('agents:bus');

/**
 * 동시 ask 요청 제한 — 무한 재귀/폭주 방지
 */
const MAX_CONCURRENT_ASKS = 5;
const ASK_TIMEOUT_MS = 30000;
const MAX_ASK_DEPTH = 3; // 에이전트 A → B → C 까지만 허용
const MAX_QUERY_LENGTH = 4000; // 쿼리 길이 제한

/**
 * 에이전트 간 위임 시 프롬프트 인젝션 방지.
 * 시스템 프롬프트 변경 시도, 역할 변경 등을 감지.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(previous|all|above)\s+(instructions?|prompts?)/i,
  /you\s+are\s+now\s+a/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /<\|im_start\|>/i,
  /forget\s+(everything|your\s+instructions)/i,
];

function sanitizeQuery(query) {
  if (!query || typeof query !== 'string') return '';
  const trimmed = query.substring(0, MAX_QUERY_LENGTH);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      log.warn('Potential prompt injection detected in agent query', { pattern: pattern.source });
      return `[SANITIZED — injection attempt removed] ${trimmed.replace(pattern, '[REDACTED]')}`;
    }
  }
  return trimmed;
}

class AgentBus extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {Object} opts.commGraph - AgentCommGraph 인스턴스
   * @param {Object} opts.mailbox - AgentMailbox 인스턴스
   * @param {Function} opts.executeAgent - (agentId, query, context) => Promise<string>
   *   게이트웨이/런타임이 주입하는 에이전트 실행 함수
   */
  constructor(opts = {}) {
    super();
    this.commGraph = opts.commGraph || null;
    this.mailbox = opts.mailbox || null;
    this.executeAgent = opts.executeAgent || null;

    this._activeAsks = 0;
    this._stats = {
      askCount: 0,
      askSuccess: 0,
      askFailed: 0,
      askTimeout: 0,
      tellCount: 0,
      broadcastCount: 0,
    };

    /** @type {Map<string, { result, timestamp }>} — 최근 응답 캐시 (2분 TTL, 최대 500항목) */
    this._responseCache = new Map();
    this._cacheTTL = 2 * 60 * 1000;
    this._cacheMaxSize = 500;
    // 주기적 캐시 정리 (30초마다)
    this._cacheCleanupTimer = setInterval(() => this.cleanCache(), 30 * 1000);
    if (this._cacheCleanupTimer.unref) this._cacheCleanupTimer.unref();
  }

  /**
   * 동기 질문 — 타겟 에이전트를 즉시 실행하고 결과 대기.
   *
   * @param {string} from - 발신 에이전트 ID
   * @param {string} to - 수신 에이전트 ID
   * @param {string} query - 질문 내용
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=30000]
   * @param {number} [opts.depth=0] - 현재 ask 깊이 (재귀 방지)
   * @param {string} [opts.threadId]
   * @returns {Promise<{ success: boolean, response: string|null, source: string, error?: string }>}
   */
  async ask(from, to, query, opts = {}) {
    const { timeoutMs = ASK_TIMEOUT_MS, depth = 0, threadId } = opts;
    this._stats.askCount++;

    // 깊이 제한
    if (depth >= MAX_ASK_DEPTH) {
      this._stats.askFailed++;
      return {
        success: false,
        response: null,
        source: `agent:${to}`,
        error: `Ask depth limit exceeded (max ${MAX_ASK_DEPTH}). Agent delegation chain too deep.`,
      };
    }

    // 동시 요청 제한
    if (this._activeAsks >= MAX_CONCURRENT_ASKS) {
      this._stats.askFailed++;
      return {
        success: false,
        response: null,
        source: `agent:${to}`,
        error: `Too many concurrent agent asks (max ${MAX_CONCURRENT_ASKS}). Try again later.`,
      };
    }

    // CommGraph 권한 확인
    if (this.commGraph) {
      const check = this.commGraph.canSend(from, to, threadId);
      if (!check.allowed) {
        this._stats.askFailed++;
        return {
          success: false,
          response: null,
          source: `agent:${to}`,
          error: `Communication denied: ${check.reason}`,
        };
      }
    }

    // 캐시 확인 — 컨텍스트 포함 키로 사용자/스레드 간 격리
    const cacheKey = `${from}:${to}:${threadId || '_'}:${query}`;
    const cached = this._responseCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this._cacheTTL) {
      this._stats.askSuccess++;
      return {
        success: true,
        response: cached.result,
        source: `agent:${to}:cached`,
      };
    }

    // executeAgent 필수
    if (!this.executeAgent) {
      this._stats.askFailed++;
      return {
        success: false,
        response: null,
        source: `agent:${to}`,
        error: 'AgentBus.executeAgent not configured. Cannot dispatch synchronous ask.',
      };
    }

    // 실행 — 위임 쿼리는 sanitize
    this._activeAsks++;
    const startTime = Date.now();
    const safeQuery = depth > 0 ? sanitizeQuery(query) : query; // 최초 사용자 쿼리는 그대로, 위임 쿼리만 sanitize

    try {
      const resultPromise = this.executeAgent(to, safeQuery, {
        fromAgent: from,
        depth: depth + 1,
        threadId,
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Agent ask timeout (${timeoutMs}ms)`)), timeoutMs)
      );

      const result = await Promise.race([resultPromise, timeoutPromise]);

      const elapsed = Date.now() - startTime;
      log.info('Agent ask completed', { from, to, elapsed, responseLen: (result || '').length });

      // 캐시 저장 (용량 초과 시 가장 오래된 항목 제거)
      if (this._responseCache.size >= this._cacheMaxSize) {
        const oldest = this._responseCache.keys().next().value;
        if (oldest) this._responseCache.delete(oldest);
      }
      this._responseCache.set(cacheKey, { result, timestamp: Date.now() });

      // CommGraph 메시지 로그 기록
      if (this.commGraph) {
        this.commGraph.sendMessage(from, to, query, { threadId });
      }

      this._stats.askSuccess++;
      this.emit('ask:complete', { from, to, elapsed, success: true });

      return {
        success: true,
        response: result,
        source: `agent:${to}`,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const isTimeout = err.message.includes('timeout');

      if (isTimeout) this._stats.askTimeout++;
      else this._stats.askFailed++;

      log.warn('Agent ask failed', { from, to, error: err.message, elapsed });
      this.emit('ask:error', { from, to, error: err.message, elapsed });

      return {
        success: false,
        response: null,
        source: `agent:${to}`,
        error: err.message,
      };
    } finally {
      this._activeAsks--;
    }
  }

  /**
   * 비동기 전송 — Mailbox에 큐잉 (fire-and-forget).
   *
   * @param {string} from
   * @param {string} to
   * @param {string} message
   * @param {Object} [opts]
   * @returns {{ success: boolean, messageId?: string, error?: string }}
   */
  tell(from, to, message, opts = {}) {
    this._stats.tellCount++;

    // CommGraph 권한 확인
    if (this.commGraph) {
      const check = this.commGraph.canSend(from, to, opts.threadId);
      if (!check.allowed) {
        return { success: false, error: `Communication denied: ${check.reason}` };
      }
    }

    if (!this.mailbox) {
      return { success: false, error: 'Mailbox not configured' };
    }

    const result = this.mailbox.send({
      from,
      to,
      message,
      context: opts.context || {},
      timestamp: Date.now(),
    });

    if (result.success && this.commGraph) {
      this.commGraph.sendMessage(from, to, message, { threadId: opts.threadId });
    }

    return result;
  }

  /**
   * 브로드캐스트 — 연결된 모든 에이전트에 동기 질문, 결과 취합.
   *
   * @param {string} from
   * @param {string} query
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=15000] - 각 에이전트별 타임아웃
   * @param {number} [opts.depth=0]
   * @returns {Promise<Array<{ agentId: string, success: boolean, response: string|null }>>}
   */
  async broadcast(from, query, opts = {}) {
    this._stats.broadcastCount++;
    const { timeoutMs = 15000, depth = 0 } = opts;

    if (!this.commGraph) {
      return [];
    }

    const reachable = this.commGraph.getReachable(from);
    if (reachable.length === 0) {
      return [];
    }

    log.info('Broadcasting to agents', { from, targets: reachable.map(r => r.agentId) });

    // 병렬 실행 (각 에이전트 독립 타임아웃)
    const results = await Promise.allSettled(
      reachable.map(r =>
        this.ask(from, r.agentId, query, { timeoutMs, depth })
          .then(res => ({ agentId: r.agentId, ...res }))
      )
    );

    return results.map(r => {
      if (r.status === 'fulfilled') return r.value;
      return { agentId: 'unknown', success: false, response: null, error: r.reason?.message };
    });
  }

  /**
   * 캐시 정리 (만료 항목 제거)
   */
  cleanCache() {
    const now = Date.now();
    for (const [key, entry] of this._responseCache) {
      if (now - entry.timestamp > this._cacheTTL) {
        this._responseCache.delete(key);
      }
    }
  }

  /**
   * @returns {Object} 통계
   */
  getStats() {
    return {
      ...this._stats,
      activeAsks: this._activeAsks,
      cacheSize: this._responseCache.size,
    };
  }
}

// ─── 싱글톤 ─────────────────────────────────────────

let _instance = null;

function getAgentBus() {
  if (!_instance) {
    _instance = new AgentBus();
  }
  return _instance;
}

function initAgentBus(opts) {
  _instance = new AgentBus(opts);
  return _instance;
}

function resetAgentBus() {
  if (_instance) {
    if (_instance._cacheCleanupTimer) clearInterval(_instance._cacheCleanupTimer);
    _instance._responseCache.clear();
    _instance.removeAllListeners();
    _instance = null;
  }
}

module.exports = { AgentBus, getAgentBus, initAgentBus, resetAgentBus };
