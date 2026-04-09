/**
 * ms-oauth.js — Microsoft Entra ID (Azure AD) OAuth2 Authorization Code Flow.
 *
 * Slack/Teams 사용자를 MS 계정과 연동하여 per-user 토큰을 발급받는다.
 * 발급된 토큰은 fnf-portal MCP 등 사용자별 인증이 필요한 서비스에 사용.
 *
 * 흐름:
 *   1. 사용자가 Effy에게 "포탈 연결" 요청
 *   2. Effy가 MS 로그인 URL 생성 (state에 userId 인코딩)
 *   3. 사용자가 브라우저에서 MS 로그인
 *   4. MS가 /auth/callback으로 redirect (code + state)
 *   5. Effy가 code → access_token 교환
 *   6. 사용자 entity에 토큰 저장
 */

const crypto = require('crypto');
const { createLogger } = require('../shared/logger');

const log = createLogger('ms-oauth');

// ─── 설정 ───

function getOAuthConfig() {
  const tenantId = process.env.TEAMS_TENANT_ID;
  const clientId = process.env.TEAMS_APP_ID;
  const clientSecret = process.env.TEAMS_APP_PASSWORD;
  const redirectUri = process.env.OAUTH_REDIRECT_URI || `https://172.20.45.20:3443/auth/callback`;

  if (!tenantId || !clientId || !clientSecret) {
    return null;
  }

  return { tenantId, clientId, clientSecret, redirectUri };
}

// ─── State 관리 (CSRF 방지) ───
// state → { userId, platform, createdAt }
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10분

// 주기적 정리
const _cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, data] of pendingStates.entries()) {
    if (data.createdAt < cutoff) pendingStates.delete(state);
  }
}, 60_000);
_cleanupTimer.unref();

/**
 * MS 로그인 URL 생성.
 *
 * @param {string} userId - Slack/Teams 사용자 ID
 * @param {string} platform - 'slack' | 'teams'
 * @returns {{ url: string, state: string } | null}
 */
function generateLoginUrl(userId, platform = 'slack') {
  const conf = getOAuthConfig();
  if (!conf) {
    log.error('OAuth config missing (TEAMS_TENANT_ID, TEAMS_APP_ID, TEAMS_APP_PASSWORD)');
    return null;
  }

  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, { userId, platform, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: conf.clientId,
    response_type: 'code',
    redirect_uri: conf.redirectUri,
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
    prompt: 'select_account',
  });

  const url = `https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/authorize?${params}`;

  log.info('Login URL generated', { userId, platform });
  return { url, state };
}

/**
 * Authorization code → access token 교환.
 *
 * @param {string} code - Authorization code (MS redirect에서 받은 값)
 * @param {string} state - CSRF state 값
 * @returns {Promise<{ userId, platform, accessToken, refreshToken, expiresAt, userInfo } | null>}
 */
async function exchangeCodeForToken(code, state) {
  // State 검증
  const stateData = pendingStates.get(state);
  if (!stateData) {
    log.warn('Invalid or expired state', { state: state?.slice(0, 8) });
    return null;
  }
  pendingStates.delete(state);

  // TTL 체크
  if (Date.now() - stateData.createdAt > STATE_TTL_MS) {
    log.warn('State expired', { userId: stateData.userId });
    return null;
  }

  const conf = getOAuthConfig();
  if (!conf) return null;

  try {
    // Code → Token 교환
    const tokenUrl = `https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: conf.clientId,
      client_secret: conf.clientSecret,
      code,
      redirect_uri: conf.redirectUri,
      grant_type: 'authorization_code',
      scope: 'openid profile email User.Read',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      log.error('Token exchange failed', { status: res.status, body: errBody.slice(0, 200) });
      return null;
    }

    const tokenData = await res.json();
    const expiresAt = Date.now() + (tokenData.expires_in * 1000);

    // MS Graph에서 사용자 프로필 가져오기
    let userInfo = null;
    if (tokenData.access_token) {
      userInfo = await fetchUserProfile(tokenData.access_token);
    }

    log.info('Token exchange success', {
      userId: stateData.userId,
      email: userInfo?.mail || userInfo?.userPrincipalName || 'unknown',
    });

    return {
      userId: stateData.userId,
      platform: stateData.platform,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt,
      idToken: tokenData.id_token || null,
      userInfo,
    };
  } catch (err) {
    log.error('Token exchange error', { error: err.message });
    return null;
  }
}

/**
 * Access token으로 MS Graph 사용자 프로필 조회.
 */
async function fetchUserProfile(accessToken) {
  try {
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName,department,jobTitle',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5000),
      },
    );

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Refresh token으로 새 access token 발급.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken, refreshToken, expiresAt } | null>}
 */
async function refreshAccessToken(refreshToken) {
  const conf = getOAuthConfig();
  if (!conf || !refreshToken) return null;

  try {
    const tokenUrl = `https://login.microsoftonline.com/${conf.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: conf.clientId,
      client_secret: conf.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'openid profile email User.Read',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      log.warn('Token refresh failed', { status: res.status });
      return null;
    }

    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
  } catch (err) {
    log.error('Token refresh error', { error: err.message });
    return null;
  }
}

module.exports = {
  getOAuthConfig,
  generateLoginUrl,
  exchangeCodeForToken,
  refreshAccessToken,
};
