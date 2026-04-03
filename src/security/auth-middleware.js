/**
 * auth-middleware.js — Express authentication middleware (v4.0 Security).
 *
 * 3가지 인증 방식 지원:
 *   1. JWT Bearer token (Authorization: Bearer <token>)
 *   2. API Key (X-API-Key header)
 *   3. Platform internal bypass (x-effy-internal header with shared secret)
 *
 * Export: authenticate(), requireAuth(), optionalAuth()
 */
const { config } = require('../config');
const { createLogger } = require('../shared/logger');

const log = createLogger('security:auth');

let jwt;
try {
  jwt = require('jsonwebtoken');
} catch (err) {
  log.warn('jsonwebtoken not installed — JWT auth will be unavailable');
}

// ─── Config ───
const JWT_SECRET = process.env.JWT_SECRET || config.security?.jwtSecret || '';
const API_KEYS = config.security?.apiKeys || [];
const INTERNAL_SECRET = process.env.EFFY_INTERNAL_SECRET || config.security?.internalSecret || '';

/**
 * JWT 토큰 검증.
 * @param {string} token
 * @returns {object|null} decoded payload or null
 */
function verifyJwt(token) {
  if (!jwt) {
    log.error('JWT verification attempted but jsonwebtoken is not installed');
    return null;
  }
  if (!JWT_SECRET) {
    log.error('JWT_SECRET not configured');
    return null;
  }
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    log.debug('JWT verification failed', { error: err.message });
    return null;
  }
}

/**
 * API Key 검증.
 * @param {string} key
 * @returns {object|null} user info or null
 */
function verifyApiKey(key) {
  if (!key || API_KEYS.length === 0) return null;

  const crypto = require('crypto');
  const keyHash = crypto.createHash('sha256').update(key).digest();

  const found = API_KEYS.find(k => {
    const stored = typeof k === 'string' ? k : (typeof k === 'object' && k.key ? k.key : null);
    if (!stored) return false;
    const storedHash = crypto.createHash('sha256').update(stored).digest();
    return crypto.timingSafeEqual(keyHash, storedHash);
  });

  if (!found) return null;

  // API key can carry metadata (name, role, etc.)
  if (typeof found === 'object') {
    return {
      id: found.id || found.name || 'api-key-user',
      role: found.role || 'user',
      platformUserId: found.platformUserId || null,
      authMethod: 'api-key',
    };
  }

  return {
    id: 'api-key-user',
    role: 'user',
    authMethod: 'api-key',
  };
}

/**
 * Platform internal bypass 검증.
 * Slack/Teams adapter 등 내부 서비스 간 통신에 사용.
 * @param {string} secret
 * @returns {object|null}
 */
function verifyInternalSecret(secret) {
  if (!INTERNAL_SECRET || !secret) return null;

  // 타이밍 공격 방지를 위해 상수 시간 비교 (hash both to fixed-size to avoid length oracle)
  const crypto = require('crypto');
  const a = crypto.createHash('sha256').update(secret).digest();
  const b = crypto.createHash('sha256').update(INTERNAL_SECRET).digest();
  if (!crypto.timingSafeEqual(a, b)) return null;

  return {
    id: 'internal-service',
    role: 'operator',
    authMethod: 'internal',
    internal: true,
  };
}

/**
 * authenticate() — 인증 미들웨어 (비차단).
 *
 * 요청에서 인증 정보를 추출하여 req.user에 설정.
 * 인증 실패 시에도 요청을 계속 진행 (requireAuth와 조합해서 사용).
 *
 * @returns {Function} Express middleware
 */
function authenticate() {
  return (req, res, next) => {
    req.user = null;

    // 1. Platform internal bypass
    const internalHeader = req.headers['x-effy-internal'];
    if (internalHeader) {
      const user = verifyInternalSecret(internalHeader);
      if (user) {
        req.user = user;
        log.debug('Internal auth accepted', { path: req.path });
        return next();
      }
    }

    // 2. JWT Bearer token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const decoded = verifyJwt(token);
      if (decoded) {
        req.user = {
          id: decoded.sub || decoded.id || decoded.userId,
          role: decoded.role || 'user',
          platformUserId: decoded.platformUserId || null,
          authMethod: 'jwt',
          claims: decoded,
        };
        return next();
      }
    }

    // 3. API Key
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const user = verifyApiKey(apiKey);
      if (user) {
        req.user = user;
        return next();
      }
    }

    // No valid auth found — continue without user (optionalAuth pattern)
    next();
  };
}

/**
 * requireAuth() — 인증 필수 미들웨어.
 *
 * authenticate() 이후에 사용. req.user가 없으면 401 반환.
 *
 * @returns {Function} Express middleware
 */
function requireAuth() {
  return (req, res, next) => {
    if (!req.user) {
      log.warn('Unauthenticated request rejected', {
        path: req.path,
        method: req.method,
        ip: req.ip,
      });
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Provide a valid Bearer token, API key, or internal secret.',
      });
    }
    next();
  };
}

/**
 * optionalAuth() — 인증 선택 미들웨어.
 *
 * authenticate()와 동일하지만 의도를 명확히 함.
 * req.user가 있으면 설정, 없으면 null로 계속 진행.
 *
 * @returns {Function} Express middleware
 */
function optionalAuth() {
  return authenticate();
}

module.exports = {
  authenticate,
  requireAuth,
  optionalAuth,
  // Internal helpers (for testing)
  verifyJwt,
  verifyApiKey,
  verifyInternalSecret,
};
