/**
 * tier1-auth.test.js — Admin User Authorization Tests.
 *
 * 검증 범위:
 * 1. auth.js 유틸리티 — getAdminUsers, isAdmin, requireAdmin, isAdminOnlyTool
 * 2. ADMIN_ONLY_TOOLS 완전성 — tool-registry adminOnly 플래그와 동기화
 * 3. Config 동작 — adminUsers[] 비어있으면 모든 유저 허용 (개발 환경)
 * 4. runtime.js executeTool 통합 — 고위험 도구 차단 시뮬레이션
 * 5. Backward-compat aliases — getMasterUsers, isMasterUser 등
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ═══════════════════════════════════════════════════════
// Suite 1: auth.js Primary API
// ═══════════════════════════════════════════════════════

describe('Auth: isAdmin / requireAdmin', () => {
  const { isAdmin, requireAdmin, isAdminOnlyTool, ADMIN_ONLY_TOOLS, getAdminUsers } = require('../src/shared/auth');

  it('should return true for all users when adminUsers is empty (dev mode)', () => {
    const admins = getAdminUsers();
    if (admins.length === 0) {
      assert.strictEqual(isAdmin('U_ANYONE'), true);
      assert.strictEqual(isAdmin('U_RANDOM'), true);
      assert.strictEqual(isAdmin(null), true);
      assert.strictEqual(isAdmin(''), true);
    }
  });

  it('requireAdmin should return null (pass) when no adminUsers configured', () => {
    const admins = getAdminUsers();
    if (admins.length === 0) {
      const result = requireAdmin('U_ANYONE', 'shell');
      assert.strictEqual(result, null, 'should pass when no admins configured');
    }
  });

  it('should define all 9 admin-only tools', () => {
    const expected = [
      'shell', 'remove_api_source',
      'add_api_source', 'delete_skill', 'cron_schedule',
      'config_inspect', 'file_write',
      // 4th/5th review (BL-3, LLM-1) — skill installation/creation promoted to admin
      'install_skill', 'create_skill',
    ];
    assert.strictEqual(ADMIN_ONLY_TOOLS.size, 9);
    for (const t of expected) {
      assert.ok(ADMIN_ONLY_TOOLS.has(t), `${t} should be admin-only`);
    }
  });

  it('memory_delete should NOT exist (permanently disabled)', () => {
    assert.ok(!ADMIN_ONLY_TOOLS.has('memory_delete'), 'memory_delete should be removed');
    assert.strictEqual(isAdminOnlyTool('memory_delete'), false, 'memory_delete is no longer a tool');
  });

  it('isAdminOnlyTool should correctly classify tools', () => {
    // Admin-only
    assert.strictEqual(isAdminOnlyTool('shell'), true);
    assert.strictEqual(isAdminOnlyTool('remove_api_source'), true);
    assert.strictEqual(isAdminOnlyTool('add_api_source'), true);
    assert.strictEqual(isAdminOnlyTool('delete_skill'), true);
    assert.strictEqual(isAdminOnlyTool('cron_schedule'), true);
    assert.strictEqual(isAdminOnlyTool('config_inspect'), true);
    assert.strictEqual(isAdminOnlyTool('file_write'), true);

    // NOT admin-only
    assert.strictEqual(isAdminOnlyTool('slack_reply'), false);
    assert.strictEqual(isAdminOnlyTool('search_knowledge'), false);
    assert.strictEqual(isAdminOnlyTool('search_api_docs'), false);
    assert.strictEqual(isAdminOnlyTool('list_api_sources'), false);
    assert.strictEqual(isAdminOnlyTool('get_api_doc'), false);
    assert.strictEqual(isAdminOnlyTool('web_search'), false);
    assert.strictEqual(isAdminOnlyTool('file_read'), false);
    assert.strictEqual(isAdminOnlyTool('create_task'), false);
  });

  it('isAdminOnlyTool should return false for unknown tool', () => {
    assert.strictEqual(isAdminOnlyTool('nonexistent_tool'), false);
    assert.strictEqual(isAdminOnlyTool(''), false);
    assert.strictEqual(isAdminOnlyTool(null), false);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 2: adminUsers Config 동작 시뮬레이션
// ═══════════════════════════════════════════════════════

describe('Auth: adminUsers Config Behavior', () => {
  it('should allow listed users and block others', () => {
    function simulateIsAdmin(userId, adminList) {
      if (adminList.length === 0) return true;
      if (!userId) return false;
      return adminList.includes(userId);
    }

    // adminUsers 설정됨 → 목록에 있는 유저만 허용
    assert.strictEqual(simulateIsAdmin('U001', ['U001', 'U002']), true);
    assert.strictEqual(simulateIsAdmin('U002', ['U001', 'U002']), true);
    assert.strictEqual(simulateIsAdmin('U003', ['U001', 'U002']), false);

    // adminUsers 비어있음 → 모든 유저 허용 (개발 환경)
    assert.strictEqual(simulateIsAdmin('U_ANYONE', []), true);
    assert.strictEqual(simulateIsAdmin('', []), true);
    assert.strictEqual(simulateIsAdmin(null, []), true);

    // null userId + adminUsers 설정됨 → 차단
    assert.strictEqual(simulateIsAdmin(null, ['U001']), false);
    assert.strictEqual(simulateIsAdmin('', ['U001']), false);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 3: requireAdmin Error Object
// ═══════════════════════════════════════════════════════

describe('Auth: requireAdmin Error Object', () => {
  it('should return structured error when blocked', () => {
    function simulateRequireAdmin(userId, toolName, adminList) {
      if (adminList.length === 0) return null;
      if (!userId || !adminList.includes(userId)) {
        return {
          error: `⛔ 권한 부족: \`${toolName}\`은(는) Admin 권한이 필요합니다.`,
          code: 'ADMIN_REQUIRED',
          hint: '관리자에게 문의하거나, config의 gateway.adminUsers에 본인 Slack ID를 추가하세요.',
        };
      }
      return null;
    }

    // Blocked
    const err = simulateRequireAdmin('U_RANDOM', 'shell', ['U_ADMIN']);
    assert.ok(err, 'should return error object');
    assert.strictEqual(err.code, 'ADMIN_REQUIRED');
    assert.ok(err.error.includes('shell'));
    assert.ok(err.error.includes('Admin'));
    assert.ok(err.hint.includes('adminUsers'));

    // Passed
    const ok = simulateRequireAdmin('U_ADMIN', 'shell', ['U_ADMIN']);
    assert.strictEqual(ok, null, 'admin user should pass');
  });
});

// ═══════════════════════════════════════════════════════
// Suite 4: tool-registry adminOnly 플래그 동기화
// ═══════════════════════════════════════════════════════

describe('Auth: tool-registry adminOnly flag sync', () => {
  const { TOOL_DEFINITIONS } = require('../src/agents/tool-registry');
  const { ADMIN_ONLY_TOOLS } = require('../src/shared/auth');

  it('every tool with adminOnly:true should be in ADMIN_ONLY_TOOLS', () => {
    for (const [name, def] of Object.entries(TOOL_DEFINITIONS)) {
      if (def.adminOnly) {
        assert.ok(
          ADMIN_ONLY_TOOLS.has(name),
          `tool-registry ${name} has adminOnly:true but is NOT in auth.ADMIN_ONLY_TOOLS`,
        );
      }
    }
  });

  it('every ADMIN_ONLY_TOOLS entry should have adminOnly:true in tool-registry', () => {
    for (const name of ADMIN_ONLY_TOOLS) {
      const def = TOOL_DEFINITIONS[name];
      assert.ok(def, `ADMIN_ONLY_TOOLS has "${name}" but tool is not defined in TOOL_DEFINITIONS`);
      assert.strictEqual(
        def.adminOnly, true,
        `ADMIN_ONLY_TOOLS has "${name}" but tool-registry lacks adminOnly:true`,
      );
    }
  });

  it('should have exactly 9 admin-only tools', () => {
    const registryCount = Object.values(TOOL_DEFINITIONS).filter(d => d.adminOnly).length;
    assert.strictEqual(registryCount, 9);
    assert.strictEqual(ADMIN_ONLY_TOOLS.size, 9);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 5: Runtime executeTool Guard Simulation
// ═══════════════════════════════════════════════════════

describe('Auth: Runtime executeTool Admin Guard', () => {
  const { isAdminOnlyTool } = require('../src/shared/auth');
  const { validateToolInput } = require('../src/agents/tool-registry');

  function simulateGuard(toolName, userId, adminList) {
    const validation = validateToolInput(toolName, {});
    if (isAdminOnlyTool(toolName)) {
      const allowed = adminList.length === 0 || (userId && adminList.includes(userId));
      if (!allowed) {
        return { blocked: true, code: 'ADMIN_REQUIRED', toolName };
      }
    }
    return { blocked: false };
  }

  it('should block non-admin user from shell execution', () => {
    const result = simulateGuard('shell', 'U_RANDOM', ['U_ADMIN']);
    assert.strictEqual(result.blocked, true);
    assert.strictEqual(result.code, 'ADMIN_REQUIRED');
  });

  it('should allow admin user to execute shell', () => {
    const result = simulateGuard('shell', 'U_ADMIN', ['U_ADMIN']);
    assert.strictEqual(result.blocked, false);
  });

  it('should block non-admin from all 9 admin-only tools', () => {
    const tools = ['shell', 'remove_api_source', 'add_api_source',
                    'delete_skill', 'cron_schedule', 'config_inspect', 'file_write',
                    'install_skill', 'create_skill'];
    for (const t of tools) {
      const result = simulateGuard(t, 'U_RANDOM', ['U_ADMIN']);
      assert.strictEqual(result.blocked, true, `${t} should be blocked for non-admin`);
    }
  });

  it('should allow any user for non-adminOnly tools', () => {
    const safeTools = ['slack_reply', 'search_knowledge', 'search_api_docs', 'list_api_sources', 'file_read'];
    for (const t of safeTools) {
      const result = simulateGuard(t, 'U_RANDOM', ['U_ADMIN']);
      assert.strictEqual(result.blocked, false, `${t} should NOT be blocked for non-admin`);
    }
  });

  it('should allow all users when adminList is empty (dev mode)', () => {
    const adminOnlyTools = ['shell', 'remove_api_source', 'add_api_source', 'delete_skill'];
    for (const t of adminOnlyTools) {
      const result = simulateGuard(t, 'U_ANYONE', []);
      assert.strictEqual(result.blocked, false, `${t} should pass when no admins configured`);
    }
  });

  it('should block null userId when admins are configured', () => {
    assert.strictEqual(simulateGuard('shell', null, ['U_ADMIN']).blocked, true);
    assert.strictEqual(simulateGuard('shell', '', ['U_ADMIN']).blocked, true);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 6: Backward-compat aliases
// ═══════════════════════════════════════════════════════

describe('Auth: Backward-compat aliases', () => {
  const auth = require('../src/shared/auth');

  it('getMasterUsers should be alias of getAdminUsers', () => {
    assert.strictEqual(auth.getMasterUsers, auth.getAdminUsers);
  });

  it('isMasterUser should be alias of isAdmin', () => {
    assert.strictEqual(auth.isMasterUser, auth.isAdmin);
  });

  it('requireMaster should be alias of requireAdmin', () => {
    assert.strictEqual(auth.requireMaster, auth.requireAdmin);
  });

  it('isMasterOnlyTool should be alias of isAdminOnlyTool', () => {
    assert.strictEqual(auth.isMasterOnlyTool, auth.isAdminOnlyTool);
  });

  it('MASTER_ONLY_TOOLS should be same reference as ADMIN_ONLY_TOOLS', () => {
    assert.strictEqual(auth.MASTER_ONLY_TOOLS, auth.ADMIN_ONLY_TOOLS);
  });
});

// ═══════════════════════════════════════════════════════
// Suite 7: Non-restricted tools remain unrestricted
// ═══════════════════════════════════════════════════════

describe('Auth: Non-restricted tools', () => {
  const { TOOL_DEFINITIONS } = require('../src/agents/tool-registry');
  const { ADMIN_ONLY_TOOLS } = require('../src/shared/auth');

  it('should have 25 non-adminOnly tools (34 total - 9 adminOnly)', () => {
    // 9 admin-only: install_skill, create_skill, delete_skill, file_write, shell,
    //   config_inspect, cron_schedule, add_api_source, remove_api_source
    // (install_skill + create_skill promoted to admin-only by 4th/5th review:
    //  BL-3 + LLM-1 — skill installation/creation has system-wide effects)
    const nonAdminTools = Object.keys(TOOL_DEFINITIONS).filter(name => !ADMIN_ONLY_TOOLS.has(name));
    assert.strictEqual(nonAdminTools.length, 25);
  });

  it('read-only and communication tools should NOT be admin-only', () => {
    // install_skill + create_skill removed: now admin-only after security review
    const safeTools = [
      'slack_reply', 'search_knowledge', 'save_knowledge', 'create_task',
      'create_incident', 'query_datasource', 'list_datasources',
      'search_skills', 'list_skills', 'activate_skill',
      'send_message', 'react', 'send_file',
      'send_agent_message', 'task_list', 'task_update', 'file_read',
      'web_search', 'set_status',
      'search_api_docs', 'get_api_doc', 'list_api_sources',
    ];
    for (const t of safeTools) {
      assert.ok(!ADMIN_ONLY_TOOLS.has(t), `${t} should NOT be admin-only`);
    }
  });
});
