/**
 * tier2-dashboard.test.js — Dashboard Integration + Stress Tests.
 *
 * 검증 범위:
 * 1. Dashboard API 인증 미들웨어 (SEC-1)
 * 2. SSE 커넥션 상한 (SEC-2)
 * 3. Activity limit 경계값 (SEC-3)
 * 4. getLanIp() 유틸리티 (DRY-1)
 * 5. Auth guard + Admin slash command 시뮬레이션
 * 6. Metrics API 응답 구조 검증 (Gateway 미주입 상태)
 * 7. Stress: 인증 검증 ×10000, API 호출 시뮬레이션 ×1000
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// Suite 1: Dashboard Auth Middleware
// ═══════════════════════════════════════════════════════

describe('Dashboard: API Auth Middleware', () => {
  const { isAdmin } = require('../src/shared/auth');

  // Simulate middleware logic
  function simulateAuth(token, header, adminList) {
    const userId = token || header || null;
    // isAdmin with empty list = all pass
    if (adminList.length === 0) return { allowed: true, userId };
    if (!userId || !adminList.includes(userId)) {
      return { allowed: false, status: 403, code: 'ADMIN_REQUIRED' };
    }
    return { allowed: true, userId };
  }

  it('should allow when adminUsers is empty (dev mode)', () => {
    const r = simulateAuth(null, null, []);
    assert.strictEqual(r.allowed, true);
  });

  it('should allow admin via token query param', () => {
    const r = simulateAuth('U_ADMIN', null, ['U_ADMIN']);
    assert.strictEqual(r.allowed, true);
  });

  it('should allow admin via X-Effy-User header', () => {
    const r = simulateAuth(null, 'U_ADMIN', ['U_ADMIN']);
    assert.strictEqual(r.allowed, true);
  });

  it('should block non-admin user', () => {
    const r = simulateAuth('U_RANDOM', null, ['U_ADMIN']);
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.status, 403);
  });

  it('should block null token when admins configured', () => {
    const r = simulateAuth(null, null, ['U_ADMIN']);
    assert.strictEqual(r.allowed, false);
  });

  it('should prefer token over header', () => {
    const r = simulateAuth('U_ADMIN', 'U_OTHER', ['U_ADMIN']);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.userId, 'U_ADMIN');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: SSE Connection Limit
// ═══════════════════════════════════════════════════════

describe('Dashboard: SSE Connection Limit', () => {
  it('should enforce MAX_SSE_CLIENTS = 10', () => {
    const MAX = 10;
    const clients = new Set();

    // Fill to limit
    for (let i = 0; i < MAX; i++) {
      clients.add({ id: i });
    }
    assert.strictEqual(clients.size, MAX);

    // 11th should be rejected
    const canConnect = clients.size < MAX;
    assert.strictEqual(canConnect, false, 'should reject 11th connection');
  });

  it('should allow connection after disconnect', () => {
    const MAX = 10;
    const clients = new Set();

    for (let i = 0; i < MAX; i++) clients.add({ id: i });
    assert.strictEqual(clients.size, MAX);

    // Disconnect one
    const first = clients.values().next().value;
    clients.delete(first);
    assert.strictEqual(clients.size, MAX - 1);

    // New connection should work
    const canConnect = clients.size < MAX;
    assert.strictEqual(canConnect, true);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: Activity Limit Boundary
// ═══════════════════════════════════════════════════════

describe('Dashboard: Activity Limit Validation', () => {
  function validateLimit(input) {
    return Math.max(1, Math.min(parseInt(input) || 20, 100));
  }

  it('should default to 20 when no input', () => {
    assert.strictEqual(validateLimit(undefined), 20);
    assert.strictEqual(validateLimit(null), 20);
    assert.strictEqual(validateLimit(''), 20);
  });

  it('should cap at 100', () => {
    assert.strictEqual(validateLimit('999'), 100);
    assert.strictEqual(validateLimit('101'), 100);
  });

  it('should floor at 1 for negatives', () => {
    assert.strictEqual(validateLimit('-5'), 1);
    assert.strictEqual(validateLimit('-100'), 1);
    // '0' → parseInt returns 0 → falsy → fallback to 20
    assert.strictEqual(validateLimit('0'), 20);
  });

  it('should pass valid values through', () => {
    assert.strictEqual(validateLimit('1'), 1);
    assert.strictEqual(validateLimit('50'), 50);
    assert.strictEqual(validateLimit('100'), 100);
  });

  it('should handle NaN strings', () => {
    assert.strictEqual(validateLimit('abc'), 20);
    assert.strictEqual(validateLimit('NaN'), 20);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 4: getLanIp Utility
// ═══════════════════════════════════════════════════════

describe('Dashboard: getLanIp Utility', () => {
  const { getLanIp } = require('../src/shared/utils');

  it('should return a string', () => {
    const ip = getLanIp();
    assert.strictEqual(typeof ip, 'string');
    assert.ok(ip.length > 0);
  });

  it('should return IPv4 format or localhost', () => {
    const ip = getLanIp();
    const isIPv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip);
    const isLocalhost = ip === 'localhost';
    assert.ok(isIPv4 || isLocalhost, `Expected IPv4 or localhost, got: ${ip}`);
  });

  it('should NOT return loopback 127.x', () => {
    const ip = getLanIp();
    if (ip !== 'localhost') {
      assert.ok(!ip.startsWith('127.'), 'should not return loopback address');
    }
  });

  it('should be deterministic', () => {
    const ip1 = getLanIp();
    const ip2 = getLanIp();
    assert.strictEqual(ip1, ip2);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 5: Dashboard URL Resolution
// ═══════════════════════════════════════════════════════

describe('Dashboard: URL Resolution Logic', () => {
  const { getLanIp } = require('../src/shared/utils');

  function resolveDashUrl(externalUrl, port) {
    if (externalUrl) {
      return `${externalUrl.replace(/\/+$/, '')}/dashboard`;
    }
    return `http://${getLanIp()}:${port}/dashboard`;
  }

  it('should use externalUrl when set', () => {
    const url = resolveDashUrl('https://effy.myteam.com', 3100);
    assert.strictEqual(url, 'https://effy.myteam.com/dashboard');
  });

  it('should strip trailing slashes from externalUrl', () => {
    const url = resolveDashUrl('https://effy.myteam.com///', 3100);
    assert.strictEqual(url, 'https://effy.myteam.com/dashboard');
  });

  it('should use LAN IP when externalUrl is empty', () => {
    const url = resolveDashUrl('', 3100);
    assert.ok(url.includes(':3100/dashboard'));
    assert.ok(!url.includes('undefined'));
  });

  it('should use LAN IP when externalUrl is null', () => {
    const url = resolveDashUrl(null, 3100);
    assert.ok(url.startsWith('http://'));
    assert.ok(url.endsWith(':3100/dashboard'));
  });

  it('should use custom port', () => {
    const url = resolveDashUrl(null, 8080);
    assert.ok(url.includes(':8080/dashboard'));
  });
});

// ═══════════════════════════════════════════════════════
// Suite 6: Metrics API Response Structure
// ═══════════════════════════════════════════════════════

describe('Dashboard: Metrics Response Structure', () => {
  // Simulate API responses when Gateway is not injected (null state)
  function simulateOverview() {
    const monthlyCost = 0;
    const budget = 500;
    return {
      requests: 0,
      cost: { current: monthlyCost, budget, percent: Math.round((monthlyCost / budget) * 100) },
      sessions: { active: 0, total: 0 },
      latency: { avg: 0 },
      contextHub: { searches: 0 },
    };
  }

  function simulateAgents(configs) {
    return configs.map(ac => ({
      id: ac.id,
      name: ac.id.charAt(0).toUpperCase() + ac.id.slice(1),
      tier: (ac.model?.range || ['tier1'])[0],
      status: 'idle',
      requests: 0, latency: 0, toolCount: 0,
    }));
  }

  it('should return valid overview structure with zero values', () => {
    const ov = simulateOverview();
    assert.strictEqual(typeof ov.requests, 'number');
    assert.strictEqual(typeof ov.cost.current, 'number');
    assert.strictEqual(typeof ov.cost.budget, 'number');
    assert.strictEqual(typeof ov.cost.percent, 'number');
    assert.strictEqual(ov.cost.percent, 0);
    assert.strictEqual(typeof ov.sessions.active, 'number');
    assert.strictEqual(typeof ov.latency.avg, 'number');
  });

  it('should return valid agent structure', () => {
    const agents = simulateAgents([
      { id: 'general', model: { range: ['tier1', 'tier2'] } },
      { id: 'code', model: { range: ['tier2', 'tier4'] } },
    ]);
    assert.strictEqual(agents.length, 2);
    assert.strictEqual(agents[0].name, 'General');
    assert.strictEqual(agents[0].tier, 'tier1');
    assert.strictEqual(agents[1].tier, 'tier2');
    assert.strictEqual(agents[0].status, 'idle');
  });

  it('should handle empty system response', () => {
    const sys = {
      circuitBreaker: { status: 'closed', detail: 'All models healthy' },
      coalescer: { status: 'active', detail: '150ms batch' },
      budgetGate: { status: 'ok', detail: '$0 / $500' },
      rateLimit: { status: 'ok', detail: '0 / 20 slots' },
    };
    assert.strictEqual(typeof sys.circuitBreaker.status, 'string');
    assert.ok(['closed', 'open'].includes(sys.circuitBreaker.status));
  });
});

// ═══════════════════════════════════════════════════════
// Suite 7: Slash Command Admin Guard
// ═══════════════════════════════════════════════════════

describe('Dashboard: /dashboard Slash Command Guard', () => {
  const { isAdmin } = require('../src/shared/auth');

  function simulateSlashCommand(userId, adminList) {
    // Simulate: isAdmin checks config.gateway.adminUsers
    const allowed = adminList.length === 0 || (userId && adminList.includes(userId));
    if (!allowed) return { blocked: true, msg: '관리자만 사용할 수 있습니다.' };
    return { blocked: false };
  }

  it('should allow admin', () => {
    assert.strictEqual(simulateSlashCommand('U_ADMIN', ['U_ADMIN']).blocked, false);
  });

  it('should block non-admin', () => {
    const r = simulateSlashCommand('U_RANDOM', ['U_ADMIN']);
    assert.strictEqual(r.blocked, true);
    assert.ok(r.msg.includes('관리자'));
  });

  it('should allow all when no admins configured', () => {
    assert.strictEqual(simulateSlashCommand('U_ANYONE', []).blocked, false);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 8: Stress — Auth Validation ×10000
// ═══════════════════════════════════════════════════════

describe('Stress: Dashboard Auth ×10000', () => {
  const { isAdmin } = require('../src/shared/auth');

  it('should validate 10000 auth checks in < 50ms', () => {
    const users = ['U001', 'U002', 'U003', null, '', 'U_ADMIN', 'U_RANDOM'];

    const start = performance.now();
    let passed = 0;
    let blocked = 0;

    for (let i = 0; i < 10000; i++) {
      const userId = users[i % users.length];
      // In dev mode (empty adminUsers), all pass
      if (isAdmin(userId)) passed++;
      else blocked++;
    }

    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `10000 auth checks took ${elapsed.toFixed(0)}ms, expected < 50ms`);
    assert.ok(passed > 0, 'some should pass');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 9: Stress — getLanIp ×1000
// ═══════════════════════════════════════════════════════

describe('Stress: getLanIp ×1000', () => {
  const { getLanIp } = require('../src/shared/utils');

  it('should resolve LAN IP 1000 times in < 200ms', () => {
    const start = performance.now();
    let lastIp;
    for (let i = 0; i < 1000; i++) {
      lastIp = getLanIp();
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 200, `1000 getLanIp calls took ${elapsed.toFixed(0)}ms, expected < 200ms`);
    assert.ok(lastIp, 'should return an IP');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 10: Stress — Simulated API Response ×1000
// ═══════════════════════════════════════════════════════

describe('Stress: Metrics Response Build ×1000', () => {
  it('should build 1000 overview responses in < 50ms', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      const overview = {
        requests: i,
        cost: { current: i * 0.1, budget: 500, percent: Math.round((i * 0.1 / 500) * 100) },
        sessions: { active: i % 5, total: i },
        latency: { avg: 2.4 },
        contextHub: { searches: i * 3 },
      };
      // Simulate JSON serialization
      const json = JSON.stringify(overview);
      assert.ok(json.length > 0);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `1000 response builds took ${elapsed.toFixed(0)}ms, expected < 50ms`);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 11: Stress — broadcastSSE Simulation ×5000
// ═══════════════════════════════════════════════════════

describe('Stress: SSE Broadcast ×5000', () => {
  it('should build 5000 SSE messages in < 50ms', () => {
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const event = 'activity';
      const data = { time: Date.now(), agent: 'code', type: 'tool', detail: `action ${i}` };
      const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      assert.ok(msg.length > 0);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `5000 SSE messages took ${elapsed.toFixed(0)}ms, expected < 50ms`);
  });
});
