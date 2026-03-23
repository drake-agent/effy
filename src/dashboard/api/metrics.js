/**
 * metrics.js — Dashboard Metrics API.
 *
 * Effy 런타임 모듈에서 실시간 데이터 수집 → JSON 응답.
 * Express Router로 /dashboard/api/* 에 마운트.
 *
 * Endpoints:
 *   GET /dashboard/api/overview   — KPI 카드 데이터
 *   GET /dashboard/api/agents     — 에이전트 상태
 *   GET /dashboard/api/cost       — 비용 추이
 *   GET /dashboard/api/activity   — 최근 활동 로그
 *   GET /dashboard/api/sessions   — 세션 목록
 *   GET /dashboard/api/memory     — 메모리 통계
 *   GET /dashboard/api/tools      — 도구 사용 통계
 *   GET /dashboard/api/system     — 시스템 상태 (CB, Coalescer, Budget)
 *   GET /dashboard/api/events     — SSE 실시간 스트림
 */
const { Router } = require('express');
const { config } = require('../../config');
const { createLogger } = require('../../shared/logger');

const { isAdmin } = require('../../shared/auth');

const log = createLogger('dashboard:api');
const router = Router();

// R3-SEC-1: Dashboard API 인증 — 헤더 전용 (query param은 로그/리퍼러 노출 위험)
// 인증 방식: Authorization: Bearer <userId> 또는 X-Effy-User: <userId>
// R3-SEC-2: CORS — 동일 오리진만 허용
router.use((req, res, next) => {
  // CORS: 허용 오리진 체크 (브라우저 요청만 해당)
  const origin = req.headers.origin;
  if (origin) {
    const port = config.gateway?.port || 3100;
    const extUrl = config.dashboard?.externalUrl;
    const allowed = extUrl
      ? origin === extUrl.replace(/\/+$/, '')
      : origin.includes(`localhost:${port}`) || origin.includes(`:${port}`);
    if (!allowed) {
      return res.status(403).json({ error: 'CORS origin denied' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Effy-User');
  }

  // Auth: Bearer token 또는 X-Effy-User 헤더
  const authHeader = req.headers.authorization;
  const userId = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : (req.headers['x-effy-user'] || null);

  if (!isAdmin(userId)) {
    return res.status(403).json({ error: 'Dashboard access denied', code: 'ADMIN_REQUIRED' });
  }
  req.effyUserId = userId;
  next();
});

// ─── Internal state references (Gateway에서 주입) ────

let _gateway = null;
let _runLogger = null;

function inject(gateway, runLogger) {
  _gateway = gateway;
  _runLogger = runLogger;
}

// ─── Helpers ─────────────────────────────────────────

// PERF-1: lazy init — 첫 호출 시 캐시, 실패 시 null 고정
let _memoryManager = undefined;
function getMemoryManager() {
  if (_memoryManager !== undefined) return _memoryManager;
  try { _memoryManager = require('../../memory/manager'); } catch { _memoryManager = null; }
  return _memoryManager;
}

function getAgentConfigs() {
  return config.agents?.list || [];
}

function getTierMeta(tierStr) {
  const tiers = {
    tier1: { label: 'Haiku', color: '#5ac8fa' },
    tier2: { label: 'Sonnet', color: '#5856d6' },
    tier3: { label: 'Opus', color: '#af52de' },
    tier4: { label: 'Opus ET', color: '#ff3b30' },
  };
  return tiers[tierStr] || tiers.tier1;
}

// ─── SSE Clients ─────────────────────────────────────

const sseClients = new Set();
const MAX_SSE_CLIENTS = 10;  // SEC-2: SSE 커넥션 상한

function broadcastSSE(event, data) {
  // R3-HIDDEN-1: event name validation — alphanumeric + underscore only
  if (!/^[a-z_][a-z0-9_]*$/i.test(event)) {
    log.warn('Invalid SSE event name rejected', { event });
    return;
  }
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  // R3-PERF-1: collect dead clients, remove after iteration (safe)
  const dead = [];
  for (const res of sseClients) {
    try {
      if (!res.write(msg)) dead.push(res);  // backpressure: buffer full
    } catch (err) {
      log.debug('SSE write failed', { error: err.message });
      dead.push(res);
    }
  }
  for (const res of dead) sseClients.delete(res);
}

// ─── GET /overview ───────────────────────────────────

router.get('/overview', (req, res) => {
  const cost = getMemoryManager()?.cost;
  const monthlyCost = cost?.getMonthlyTotal?.() ?? 0;
  const budget = config.cost?.monthlyBudgetUsd ?? 500;

  const sessionCount = _gateway?.sessions?.size ?? 0;

  res.json({
    requests: _runLogger?.getTodayCount?.() || 0,
    cost: { current: monthlyCost, budget, percent: Math.round((monthlyCost / budget) * 100) },
    sessions: { active: sessionCount, total: _runLogger?.getSessionCount?.() || 0 },
    latency: { avg: _runLogger?.getAvgLatency?.() || 0 },
    contextHub: { searches: _runLogger?.getToolCount?.('search_api_docs') || 0 },
  });
});

// ─── GET /agents ─────────────────────────────────────

router.get('/agents', (req, res) => {
  const agentConfigs = getAgentConfigs();
  const agents = agentConfigs.map(ac => {
    const range = ac.model?.range || ['tier1', 'tier2'];
    const currentTier = range[0];
    const tierInfo = getTierMeta(currentTier);
    const stats = _runLogger?.getAgentStats?.(ac.id) || {};

    return {
      id: ac.id,
      name: ac.id.charAt(0).toUpperCase() + ac.id.slice(1),
      tier: currentTier,
      tierLabel: tierInfo.label,
      color: tierInfo.color,
      range,
      status: _gateway?.getAgentStatus?.(ac.id) || 'idle',
      requests: stats.requests || 0,
      latency: stats.avgLatency || 0,
      toolCount: stats.toolCount || 0,
    };
  });

  res.json({ agents });
});

// ─── GET /cost ───────────────────────────────────────

router.get('/cost', (req, res) => {
  const costHistory = _runLogger?.getCostHistory?.() || [];
  const tierDist = _runLogger?.getTierDistribution?.() || [];

  res.json({ history: costHistory, tierDistribution: tierDist });
});

// ─── GET /activity ───────────────────────────────────

router.get('/activity', (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
  const events = _runLogger?.getRecentActivity?.(limit) || [];

  res.json({ events });
});

// ─── GET /sessions ───────────────────────────────────

router.get('/sessions', (req, res) => {
  const sessions = _runLogger?.getActiveSessions?.() || [];
  res.json({ sessions });
});

// ─── GET /memory ─────────────────────────────────────

router.get('/memory', (req, res) => {
  const mgr = getMemoryManager();
  const stats = {
    // R14-BUG-4: count() 메서드 대신 직접 SQL 카운트 (manager에 count 없음)
    working: 0,  // WorkingMemory는 in-memory Map — 외부에서 접근 불가
    episodic: await (async () => { try { const db = require('../../db').getDb(); return (await db.prepare('SELECT COUNT(*) as c FROM episodic_memory').get())?.c || 0; } catch { return 0; } })(),
    semantic: await (async () => { try { const db = require('../../db').getDb(); return (await db.prepare('SELECT COUNT(*) as c FROM semantic_memory WHERE archived=0').get())?.c || 0; } catch { return 0; } })(),
    entity: await (async () => { try { const db = require('../../db').getDb(); return (await db.prepare('SELECT COUNT(*) as c FROM entities').get())?.c || 0; } catch { return 0; } })(),
    history: _runLogger?.getMemoryHistory?.() || [],
  };

  res.json(stats);
});

// ─── GET /tools ──────────────────────────────────────

router.get('/tools', (req, res) => {
  const toolStats = _runLogger?.getToolUsageStats?.() || [];
  res.json({ tools: toolStats });
});

// ─── GET /system ─────────────────────────────────────

router.get('/system', (req, res) => {
  const cb = _gateway?.circuitBreaker;
  const budget = config.cost || {};

  res.json({
    circuitBreaker: {
      status: cb?.isOpen?.() ? 'open' : 'closed',
      detail: cb?.isOpen?.() ? `Tripped: ${cb.tripReason || 'unknown'}` : 'All models healthy',
    },
    coalescer: {
      status: 'active',
      detail: `${config.coalescer?.debounceMs || 150}ms batch`,
    },
    budgetGate: {
      status: 'ok',
      detail: `$${(_runLogger?.getMonthlyTotal?.() || 0).toFixed(0)} / $${budget.monthlyBudgetUsd || 500}`,
    },
    rateLimit: {
      status: 'ok',
      detail: `${_gateway?.concurrentCount || 0} / ${config.gateway?.maxConcurrency?.global || 20} slots`,
    },
  });
});

// ─── GET /events (SSE) ───────────────────────────────

router.get('/events', (req, res) => {
  // SEC-2: 커넥션 상한 초과 시 거부 (SSE 헤더 설정 전에 체크)
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return res.status(429).json({ error: 'Too many SSE connections', limit: MAX_SSE_CLIENTS });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

  sseClients.add(res);
  log.info('SSE client connected', { total: sseClients.size });

  req.on('close', () => {
    sseClients.delete(res);
    log.info('SSE client disconnected', { total: sseClients.size });
  });
});

module.exports = { router, inject, broadcastSSE };
