/**
 * rbac.js — Role-Based Access Control (v4.0 Security).
 *
 * 계층적 역할 모델: admin > operator > user > agent
 *
 * 각 역할은 하위 역할의 권한을 상속.
 * adminUsers 목록이 비어 있고 production이면 CRITICAL 경고 후 전체 user 역할 부여.
 *
 * Export: requirePermission(), hasPermission(), getRolePermissions()
 */
const { config } = require('../config');
const { createLogger } = require('../shared/logger');

const log = createLogger('security:rbac');

// ─── 역할 계층 (높은 숫자 = 높은 권한) ───
const ROLE_HIERARCHY = {
  agent: 0,
  user: 1,
  operator: 2,
  admin: 3,
};

// ─── 역할별 권한 매핑 ───
const PERMISSIONS = {
  admin: [
    'execute_tools',
    'read_sessions',
    'manage_agents',
    'manage_users',
    'manage_config',
    'manage_secrets',
    'view_audit_log',
    'manage_committee',
    'admin_all',
  ],
  operator: [
    'execute_tools',
    'read_sessions',
    'manage_agents',
  ],
  user: [
    'execute_tools',
    'read_sessions',
  ],
  agent: [
    'execute_tools', // own scope only
  ],
};

// ─── Admin users from config ───
const adminUsers = config.gateway?.adminUsers || [];

// CRITICAL warning for production with no adminUsers
if (adminUsers.length === 0 && process.env.NODE_ENV === 'production') {
  log.error('CRITICAL: No adminUsers configured in production. All users will default to "user" role. ' +
    'Set gateway.adminUsers in effy.config.yaml to designate administrators.');
}

/**
 * 사용자의 유효 역할 결정.
 *
 * - platformUserId가 adminUsers에 포함되면 admin
 * - adminUsers가 비어 있고 production이면 user (admin 아님)
 * - req.user.role이 있으면 해당 역할 사용
 * - 기본값: user
 *
 * @param {object} user - req.user 객체
 * @returns {string} 유효 역할
 */
function getEffectiveRole(user) {
  if (!user) return 'agent';

  const platformUserId = user.platformUserId || user.id;

  // Admin check via config
  if (platformUserId && adminUsers.includes(platformUserId)) {
    return 'admin';
  }

  // Production with no adminUsers — no one gets admin
  if (adminUsers.length === 0 && process.env.NODE_ENV === 'production') {
    // User's explicit role, but capped at 'user'
    const explicitRole = user.role || 'user';
    const capped = ROLE_HIERARCHY[explicitRole] !== undefined
      ? (ROLE_HIERARCHY[explicitRole] > ROLE_HIERARCHY.user ? 'user' : explicitRole)
      : 'user';
    return capped;
  }

  // Use the role from auth, or default to 'user'
  return user.role && ROLE_HIERARCHY[user.role] !== undefined ? user.role : 'user';
}

/**
 * 역할에 대한 모든 권한 반환 (상속 포함).
 * @param {string} role
 * @returns {string[]}
 */
function getRolePermissions(role) {
  const normalizedRole = role && ROLE_HIERARCHY[role] !== undefined ? role : 'user';
  const roleLevel = ROLE_HIERARCHY[normalizedRole];
  const allPermissions = new Set();

  for (const [r, perms] of Object.entries(PERMISSIONS)) {
    if (ROLE_HIERARCHY[r] <= roleLevel) {
      for (const p of perms) {
        allPermissions.add(p);
      }
    }
  }

  return Array.from(allPermissions);
}

/**
 * 사용자가 특정 권한을 가지고 있는지 확인.
 * @param {object} user - req.user 객체
 * @param {string} permission - 확인할 권한
 * @returns {boolean}
 */
function hasPermission(user, permission) {
  const effectiveRole = getEffectiveRole(user);
  const permissions = getRolePermissions(effectiveRole);

  // admin_all grants everything
  if (permissions.includes('admin_all')) return true;

  return permissions.includes(permission);
}

/**
 * requirePermission() — 권한 필수 미들웨어.
 *
 * authenticate() + requireAuth() 이후에 사용.
 * 사용자가 지정된 권한을 가지고 있지 않으면 403 반환.
 *
 * @param {string} permission - 필요한 권한
 * @returns {Function} Express middleware
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'You must be authenticated to access this resource.',
      });
    }

    const granted = hasPermission(req.user, permission);

    if (!granted) {
      const effectiveRole = getEffectiveRole(req.user);
      log.warn('Permission denied', {
        userId: req.user.id,
        role: effectiveRole,
        permission,
        path: req.path,
      });
      return res.status(403).json({
        error: 'Forbidden',
        message: `Permission '${permission}' required. Your role: ${effectiveRole}`,
      });
    }

    next();
  };
}

module.exports = {
  requirePermission,
  hasPermission,
  getRolePermissions,
  getEffectiveRole,
  ROLE_HIERARCHY,
  PERMISSIONS,
};
