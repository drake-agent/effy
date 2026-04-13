/**
 * portal-auth.js — FnF 포털 MCP 인증 모듈.
 *
 * MS access token을 사용하여 포털 인증 토큰을 교환하고 DB에 저장한다.
 * 포털 MCP 호출 전 ensurePortalAuth()를 호출하면:
 *   1. DB에서 portal_auth 조회
 *   2. 유효하면 반환
 *   3. 만료/없으면 MS access token으로 포털 토큰 교환
 *   4. MS 토큰도 만료면 refresh 시도
 *   5. 모두 실패 시 null 반환 (재인증 필요)
 *
 * 포털 API:
 *   POST https://portal-backend.fnf.co.kr/api/auth/portal/token
 *   Body: { grant_type: "access_token", provider: "fnf_ms", access_token: "<MS token>" }
 *   Response: { data: { token_type, access_token, refresh_token, expires_in, refresh_expires_in } }
 */

const { createLogger } = require('../shared/logger');

const log = createLogger('portal-auth');

const PORTAL_TOKEN_URL = 'https://portal-backend.fnf.co.kr/api/auth/portal/token';

/** 만료 5분 전이면 만료로 간주 */
const EXPIRY_BUFFER_MS = 300_000;

/**
 * MS access token으로 포털 토큰을 교환한다.
 * @param {string} msAccessToken
 * @returns {Promise<{ accessToken, refreshToken, expiresAt, refreshExpiresAt } | null>}
 */
async function exchangeForPortalToken(msAccessToken) {
  try {
    const res = await fetch(PORTAL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'access_token',
        provider: 'fnf_ms',
        access_token: msAccessToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.warn('Portal token exchange failed', { status: res.status, body: body.slice(0, 200) });
      return null;
    }

    const json = await res.json();
    const data = json.data;
    if (!data?.access_token) {
      log.warn('Portal token response missing access_token', { json });
      return null;
    }

    const now = Date.now();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: now + (data.expires_in * 1000),           // 30분
      refreshExpiresAt: now + (data.refresh_expires_in * 1000), // 24시간
    };
  } catch (err) {
    log.error('Portal token exchange error', { error: err.message });
    return null;
  }
}

/**
 * 포털 refresh token으로 새 토큰을 발급받는다.
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken, refreshToken, expiresAt, refreshExpiresAt } | null>}
 */
async function refreshPortalToken(refreshToken) {
  try {
    const res = await fetch(PORTAL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      log.warn('Portal token refresh failed', { status: res.status });
      return null;
    }

    const json = await res.json();
    const data = json.data;
    if (!data?.access_token) return null;

    const now = Date.now();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: now + (data.expires_in * 1000),
      refreshExpiresAt: now + (data.refresh_expires_in * 1000),
    };
  } catch (err) {
    log.error('Portal token refresh error', { error: err.message });
    return null;
  }
}

/**
 * 포털 토큰이 유효한지 확인한다 (만료 5분 전 = 만료 간주).
 */
function isTokenValid(portalAuth) {
  if (!portalAuth?.accessToken || !portalAuth?.expiresAt) return false;
  return Date.now() < (portalAuth.expiresAt - EXPIRY_BUFFER_MS);
}

/**
 * 포털 refresh token이 유효한지 확인한다.
 */
function isRefreshValid(portalAuth) {
  if (!portalAuth?.refreshToken || !portalAuth?.refreshExpiresAt) return false;
  return Date.now() < (portalAuth.refreshExpiresAt - EXPIRY_BUFFER_MS);
}

/**
 * 사용자의 유효한 포털 토큰을 확보한다.
 *
 * 1. DB에서 portal_auth 조회 → 유효하면 반환
 * 2. 포털 refresh token 유효하면 refresh 시도
 * 3. MS access token으로 포털 토큰 교환 시도 (MS 토큰 만료 시 refresh)
 * 4. 모두 실패 시 null 반환
 *
 * @param {string} userId
 * @returns {Promise<{ accessToken: string } | null>}
 */
async function ensurePortalAuth(userId) {
  const { entity: entityMgr } = require('../memory/manager');
  const { refreshAccessToken } = require('./ms-oauth');

  const userEntity = await entityMgr.get('user', userId);
  if (!userEntity) {
    log.warn('User entity not found', { userId });
    return null;
  }

  const portalAuth = userEntity.properties?.portal_auth;
  const msAuth = userEntity.properties?.ms_auth;

  // 1. 포털 토큰이 유효하면 그대로 반환
  if (isTokenValid(portalAuth)) {
    return { accessToken: portalAuth.accessToken };
  }

  // 2. 포털 refresh token으로 갱신 시도
  if (isRefreshValid(portalAuth)) {
    const refreshed = await refreshPortalToken(portalAuth.refreshToken);
    if (refreshed) {
      await _savePortalAuth(entityMgr, userId, refreshed);
      log.info('Portal token refreshed', { userId });
      return { accessToken: refreshed.accessToken };
    }
  }

  // 3. MS access token으로 포털 토큰 교환
  if (!msAuth?.accessToken) return null;

  let msToken = msAuth.accessToken;

  // MS 토큰 만료 시 refresh
  if (Date.now() > (msAuth.expiresAt - EXPIRY_BUFFER_MS)) {
    if (!msAuth.refreshToken) return null;
    const msRefreshed = await refreshAccessToken(msAuth.refreshToken);
    if (!msRefreshed) return null;

    // MS 토큰 DB 업데이트
    await entityMgr.upsert('user', userId, null, {
      ms_auth: { ...msAuth, accessToken: msRefreshed.accessToken, refreshToken: msRefreshed.refreshToken, expiresAt: msRefreshed.expiresAt },
    });
    msToken = msRefreshed.accessToken;
    log.info('MS token refreshed for portal auth', { userId });
  }

  // 포털 토큰 교환
  const portalResult = await exchangeForPortalToken(msToken);
  if (!portalResult) return null;

  await _savePortalAuth(entityMgr, userId, portalResult);
  log.info('Portal token acquired', { userId });
  return { accessToken: portalResult.accessToken };
}

/**
 * portal_auth를 DB에 저장한다.
 */
async function _savePortalAuth(entityMgr, userId, tokenData) {
  await entityMgr.upsert('user', userId, null, {
    portal_auth: {
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      expiresAt: tokenData.expiresAt,
      refreshExpiresAt: tokenData.refreshExpiresAt,
      authenticatedAt: new Date().toISOString(),
    },
  });
}

module.exports = {
  exchangeForPortalToken,
  refreshPortalToken,
  ensurePortalAuth,
  isTokenValid,
};
