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

router.get('/overview', async (req, res) => {
  const cost = getMemoryManager()?.cost;
  const monthlyCost = (await cost?.getMonthlyTotal?.()) ?? 0;
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

router.get('/memory', async (req, res) => {
  try {
    const db = require('../../db').getDb();
    const episodic = (await db.prepare('SELECT COUNT(*) as c FROM episodic_memory').get())?.c || 0;
    const semantic = (await db.prepare('SELECT COUNT(*) as c FROM semantic_memory WHERE archived=0').get())?.c || 0;
    const entity = (await db.prepare('SELECT COUNT(*) as c FROM entities').get())?.c || 0;

    res.json({
      working: 0,
      episodic,
      semantic,
      entity,
      history: _runLogger?.getMemoryHistory?.() || [],
    });
  } catch (err) {
    log.error('Memory API error', { error: err.message });
    res.json({ working: 0, episodic: 0, semantic: 0, entity: 0, history: [] });
  }
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

// ─── GET /conversations ──────────────────────────────

router.get('/conversations', async (req, res) => {
  try {
    const db = require('../../db').getDb();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const userFilter = req.query.user || '';
    const search = req.query.q || '';

    let countConditions = ["role = 'user'"];
    let joinConditions = [];
    const params = [];
    let paramIdx = 0;
    const p = () => `$${++paramIdx}`;

    if (userFilter) {
      countConditions.push(`user_id = ${p()}`);
      joinConditions.push(`u.user_id = $${paramIdx}`);
      params.push(userFilter);
    }
    if (search) {
      countConditions.push(`content ILIKE ${p()}`);
      joinConditions.push(`u.content ILIKE $${paramIdx}`);
      params.push(`%${search}%`);
    }

    const countWhere = `WHERE ${countConditions.join(' AND ')}`;
    const joinWhere = joinConditions.length > 0
      ? `WHERE u.role = 'user' AND ${joinConditions.join(' AND ')}`
      : "WHERE u.role = 'user'";

    // 총 개수 (user 메시지만)
    const countRow = await db.prepare(
      `SELECT COUNT(*) as total FROM episodic_memory ${countWhere}`
    ).get(...params);

    // 대화 목록: user 메시지만 먼저 가져오고, 각 user에 대응하는 assistant 응답을 조인
    params.push(limit, offset);
    const rows = await db.prepare(`
      SELECT u.id, u.conversation_key, u.user_id, u.channel_id, u.content AS question,
             u.agent_type, u.function_type, u.created_at,
             a.content AS answer
      FROM episodic_memory u
      LEFT JOIN episodic_memory a
        ON a.conversation_key = u.conversation_key
        AND a.role = 'assistant'
        AND a.id = (SELECT MIN(id) FROM episodic_memory WHERE conversation_key = u.conversation_key AND role = 'assistant' AND id > u.id)
      ${joinWhere}
      ORDER BY u.created_at DESC
      LIMIT ${p()} OFFSET ${p()}
    `).all(...params);

    // 쌍으로 변환
    const pairs = rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      channel: row.channel_id,
      agent: row.agent_type || 'general',
      question: row.question,
      answer: row.answer || null,
      timestamp: row.created_at,
      functionType: row.function_type,
    }));

    // 사용자 목록 (필터용) — entities 테이블에서 이름 매핑
    const users = await db.prepare(
      `SELECT DISTINCT em.user_id, COALESCE(e.name, em.user_id) AS name
       FROM episodic_memory em
       LEFT JOIN entities e ON e.entity_type = 'user' AND e.entity_id = em.user_id
       WHERE em.role = 'user'
       ORDER BY name`
    ).all();

    // 대화 목록에도 이름 매핑
    const userNameMap = {};
    for (const u of users) userNameMap[u.user_id] = u.name;

    res.json({
      total: countRow?.total || 0,
      offset,
      limit,
      conversations: pairs.map(p => ({ ...p, userName: userNameMap[p.userId] || p.userId?.slice(0, 12) })),
      users: users.map(u => ({ id: u.user_id, name: u.name })),
    });
  } catch (err) {
    log.error('Conversations API error', { error: err.message });
    res.json({ total: 0, conversations: [], users: [], error: err.message });
  }
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

// ─── Graph API (Feature #15) ────────────────────────────

// GET /graph/stats — node/edge counts by type
router.get('/graph/stats', async (req, res) => {
  try {
    const db = require('../../db').getDb();

    // Count nodes by type
    const nodesByType = await db.prepare(`
      SELECT type, COUNT(*) as count FROM memories
      WHERE archived = 0
      GROUP BY type
      ORDER BY count DESC
    `).all();

    const typeCounts = {};
    const types = ['fact', 'preference', 'decision', 'identity', 'event', 'observation', 'goal', 'todo'];
    types.forEach(t => typeCounts[t] = 0);
    nodesByType.forEach(row => { typeCounts[row.type] = row.count; });

    // Total counts
    const totalNodes = nodesByType.reduce((sum, row) => sum + row.count, 0);
    const totalEdges = (await db.prepare('SELECT COUNT(*) as c FROM memory_edges').get())?.c || 0;

    res.json({
      totalNodes,
      totalEdges,
      nodesByType: typeCounts,
    });
  } catch (err) {
    log.error('Graph stats API error', { error: err.message });
    res.json({ totalNodes: 0, totalEdges: 0, nodesByType: {} });
  }
});

// GET /graph/nodes — list memory nodes with filters
router.get('/graph/nodes', async (req, res) => {
  try {
    const db = require('../../db').getDb();
    const type = req.query.type || '';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 50, 200));
    const minImportance = Math.max(0, parseFloat(req.query.minImportance) || 0);

    let query = 'SELECT id, type, content, importance, created_at FROM memories WHERE archived = 0';
    const params = [];

    if (type) {
      query += ' AND type = ?';
      params.push(type);
    }

    query += ' AND importance >= ?';
    params.push(minImportance);

    query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(limit);

    const nodes = await db.prepare(query).all(...params);

    res.json({
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type,
        content: n.content,
        importance: n.importance,
        createdAt: n.created_at,
      })),
    });
  } catch (err) {
    log.error('Graph nodes API error', { error: err.message });
    res.json({ nodes: [] });
  }
});

// GET /graph/node/:id/neighbors — get node + connected nodes/edges for visualization
router.get('/graph/node/:id/neighbors', async (req, res) => {
  try {
    const db = require('../../db').getDb();
    const nodeId = parseInt(req.query.id || req.params.id);
    const depth = parseInt(req.query.depth) || 1;

    if (isNaN(nodeId)) {
      return res.status(400).json({ error: 'Invalid node id' });
    }

    // Fetch the node itself
    const node = await db.prepare(
      'SELECT id, type, content, importance, created_at FROM memories WHERE id = ? AND archived = 0'
    ).get(nodeId);

    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }

    const nodes = [node];
    const edges = [];
    const visited = new Set([nodeId]);

    // BFS to get neighbors at specified depth
    let queue = [nodeId];
    for (let d = 0; d < depth && queue.length > 0; d++) {
      const nextQueue = [];

      for (const currentId of queue) {
        // Get edges where this node is source or target
        const edgeRows = await db.prepare(`
          SELECT * FROM memory_edges
          WHERE (source_id = ? OR target_id = ?)
          AND source_id != target_id
        `).all(currentId, currentId);

        for (const edge of edgeRows) {
          edges.push({
            source: edge.source_id,
            target: edge.target_id,
            relation: edge.relation,
            weight: edge.weight,
          });

          const neighborId = edge.source_id === currentId ? edge.target_id : edge.source_id;
          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextQueue.push(neighborId);
          }
        }
      }

      // Fetch neighbor nodes
      for (const nid of nextQueue) {
        const neighbor = await db.prepare(
          'SELECT id, type, content, importance, created_at FROM memories WHERE id = ? AND archived = 0'
        ).get(nid);
        if (neighbor) {
          nodes.push(neighbor);
        }
      }

      queue = nextQueue;
    }

    res.json({
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type,
        content: n.content,
        importance: n.importance,
        createdAt: n.created_at,
      })),
      edges,
    });
  } catch (err) {
    log.error('Graph node neighbors API error', { error: err.message });
    res.json({ nodes: [], edges: [] });
  }
});

// ─── Audit API (Feature #23) ────────────────────────

let _auditLogger = null;

function getAuditLogger() {
  if (_auditLogger !== undefined) return _auditLogger;
  try {
    const { AuditLogger } = require('../../shared/audit-logger');
    _auditLogger = new AuditLogger();
  } catch {
    _auditLogger = null;
  }
  return _auditLogger;
}

// GET /audit — query audit events with filters
router.get('/audit', async (req, res) => {
  try {
    const auditLogger = getAuditLogger();
    if (!auditLogger) {
      return res.json({ events: [], total: 0 });
    }

    const typeFilter = req.query.type || '';
    const agentId = req.query.agentId || '';
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
    const after = req.query.after ? new Date(req.query.after) : null;
    const before = req.query.before ? new Date(req.query.before) : null;

    const events = [];
    const filter = {};
    if (typeFilter) filter.type = typeFilter;
    if (agentId) filter.agentId = agentId;
    if (after) filter.after = after;
    if (before) filter.before = before;

    let count = 0;
    for await (const event of auditLogger.query(filter)) {
      if (count >= limit) break;
      events.push(event);
      count++;
    }

    res.json({
      events: events.reverse(),
      total: events.length,
    });
  } catch (err) {
    log.error('Audit API error', { error: err.message });
    res.json({ events: [], total: 0 });
  }
});

// GET /audit/stats — event counts by type, result, agent
router.get('/audit/stats', async (req, res) => {
  try {
    const auditLogger = getAuditLogger();
    if (!auditLogger) {
      return res.json({ byType: {}, byResult: {}, byAgent: {} });
    }

    const stats = {
      byType: {},
      byResult: {},
      byAgent: {},
    };

    for await (const event of auditLogger.query({})) {
      // Count by type
      stats.byType[event.type] = (stats.byType[event.type] || 0) + 1;

      // Count by result
      stats.byResult[event.result || 'unknown'] = (stats.byResult[event.result || 'unknown'] || 0) + 1;

      // Count by agent
      stats.byAgent[event.agentId || 'unknown'] = (stats.byAgent[event.agentId || 'unknown'] || 0) + 1;
    }

    res.json(stats);
  } catch (err) {
    log.error('Audit stats API error', { error: err.message });
    res.json({ byType: {}, byResult: {}, byAgent: {} });
  }
});

module.exports = { router, inject, broadcastSSE };
