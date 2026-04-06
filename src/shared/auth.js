/**
 * auth.js — 권한 관리 유틸리티.
 *
 * v3.6.2: Admin Guard — 고위험 도구 실행을 adminUsers로 제한.
 *
 * 고위험 도구 분류:
 * - CRITICAL: shell (시스템 명령), remove_api_source (소스 삭제)
 * - HIGH: add_api_source (외부 URL 등록), delete_skill (스킬 삭제),
 *         cron_schedule (예약 작업), config_inspect (설정 노출), file_write (파일 쓰기)
 *
 * 설정:
 *   gateway.adminUsers: [U07XXXXXXXX, U08YYYYYYYY]  # Slack user IDs
 *   비어있으면 → 모든 유저 허용 (개발 환경 호환)
 *
 * 단일 역할 모델:
 *   adminUsers 하나로 슬래시 커맨드 관리(/committee invite, /skill) + 고위험 도구 권한 통합 관리.
 */
const { config } = require('../config');
const { createLogger } = require('./logger');

const log = createLogger('auth');

/**
 * Admin User 목록 조회 (캐시 없음 — config 핫리로드 대응).
 *
 * @returns {string[]} Slack user ID 배열 (빈 배열 = 모두 허용)
 */
function getAdminUsers() {
  const adminUsers = config.gateway?.adminUsers;
  if (Array.isArray(adminUsers) && adminUsers.length > 0) {
    return adminUsers;
  }
  return [];
}

/**
 * 사용자가 Admin 권한을 가지는지 확인.
 *
 * IC-8 fix: Delegate to rbac.js getEffectiveRole() when available,
 * falling back to config-based check. This unifies the admin decision.
 *
 * @param {string} userId - Slack user ID
 * @returns {boolean}
 */
function isAdmin(userId) {
  // IC-8: Try RBAC first for unified admin decision
  try {
    const { getEffectiveRole } = require('../security/rbac');
    const role = getEffectiveRole({ id: userId, platformUserId: userId });
    return role === 'admin';
  } catch {
    // rbac.js not available — fall back to config-based check
    const admins = getAdminUsers();
    if (admins.includes(userId)) return true;
    // SEC-5 fix: Production safety — no admins configured and no RBAC
    if (process.env.NODE_ENV !== 'production') return true;
    return false;
  }
}

/**
 * Admin 권한 검증 — 실패 시 에러 객체 반환.
 *
 * @param {string} userId - 요청자 Slack user ID
 * @param {string} toolName - 도구 이름 (로깅용)
 * @returns {null|object} null=통과, {error, code}=차단
 */
function requireAdmin(userId, toolName) {
  if (isAdmin(userId)) return null;

  log.warn('Admin-only tool blocked', { userId, toolName });

  return {
    error: `⛔ 권한 부족: \`${toolName}\`은(는) Admin 권한이 필요합니다.`,
    code: 'ADMIN_REQUIRED',
    hint: '관리자에게 문의하거나, config의 gateway.adminUsers에 본인 Slack ID를 추가하세요.',
  };
}

/**
 * 도구가 Admin-only인지 확인.
 *
 * R3-DESIGN-1: tool-registry.js의 adminOnly 플래그를 Single Source of Truth로 사용.
 * 캐시 없음 — 핫리로드 대응. 호출 빈도가 낮아 오버헤드 무시함.
 *
 * @param {string} toolName
 * @returns {boolean}
 */
function isAdminOnlyTool(toolName) {
  try {
    const { TOOL_DEFINITIONS } = require('../agents/tool-registry');
    return TOOL_DEFINITIONS[toolName]?.adminOnly === true;
  } catch { return false; }
}

/**
 * Admin-only 도구 Set (하위 호환 — 테스트에서 참조).
 * tool-registry에서 동적 추출. 캐시 없음 — 핫리로드 대응.
 */
function getAdminOnlyTools() {
  try {
    const { TOOL_DEFINITIONS } = require('../agents/tool-registry');
    return new Set(Object.keys(TOOL_DEFINITIONS).filter(n => TOOL_DEFINITIONS[n]?.adminOnly));
  } catch { return new Set(); }
}
const ADMIN_ONLY_TOOLS = getAdminOnlyTools();

// ── 하위 호환 aliases (기존 코드 깨지지 않도록) ──
const getMasterUsers = getAdminUsers;
const isMasterUser = isAdmin;
const requireMaster = requireAdmin;
const isMasterOnlyTool = isAdminOnlyTool;
const MASTER_ONLY_TOOLS = ADMIN_ONLY_TOOLS;

module.exports = {
  // Primary API (admin 기반)
  getAdminUsers,
  isAdmin,
  requireAdmin,
  isAdminOnlyTool,
  ADMIN_ONLY_TOOLS,
  // Backward-compat aliases
  getMasterUsers,
  isMasterUser,
  requireMaster,
  isMasterOnlyTool,
  MASTER_ONLY_TOOLS,
};
