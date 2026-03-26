/**
 * ms-graph.js — Microsoft Graph API 클라이언트.
 *
 * Teams 사용자의 부서, 직급 등 프로필 정보를 가져온다.
 * Client Credentials Flow (앱 전용 토큰) 사용.
 *
 * 필요 권한: User.Read.All (Application)
 */
const { createLogger } = require('./logger');

const log = createLogger('ms-graph');

let _tokenCache = { token: null, expiresAt: 0 };

/**
 * Client Credentials Flow로 앱 전용 액세스 토큰 발급.
 */
async function getAccessToken(tenantId, clientId, clientSecret) {
  const now = Date.now();
  if (_tokenCache.token && now < _tokenCache.expiresAt - 60000) {
    return _tokenCache.token;
  }

  try {
    const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      log.debug('Graph token failed', { status: res.status });
      return null;
    }

    const data = await res.json();
    _tokenCache = {
      token: data.access_token,
      expiresAt: now + (data.expires_in * 1000),
    };
    return data.access_token;
  } catch (err) {
    log.debug('Graph token error', { error: err.message });
    return null;
  }
}

/**
 * Graph API로 사용자 프로필 조회.
 *
 * @param {string} aadObjectId - Azure AD Object ID
 * @returns {{ displayName, department, jobTitle, mail } | null}
 */
async function getUserProfile(aadObjectId) {
  const tenantId = process.env.TEAMS_TENANT_ID;
  const clientId = process.env.TEAMS_APP_ID;
  const clientSecret = process.env.TEAMS_APP_PASSWORD;

  if (!tenantId || !clientId || !clientSecret) {
    log.debug('MS Graph credentials not configured');
    return null;
  }

  const token = await getAccessToken(tenantId, clientId, clientSecret);
  if (!token) return null;

  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${aadObjectId}?$select=displayName,department,jobTitle,mail`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
    );

    if (!res.ok) {
      log.debug('Graph API user fetch failed', { status: res.status, userId: aadObjectId.slice(0, 8) });
      return null;
    }

    const data = await res.json();
    return {
      displayName: data.displayName || '',
      department: data.department || '',
      jobTitle: data.jobTitle || '',
      mail: data.mail || '',
    };
  } catch (err) {
    log.debug('Graph API error', { error: err.message });
    return null;
  }
}

// 프로필 캐시 (메모리, userId → profile)
const _profileCache = new Map();
const PROFILE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

/**
 * 캐시 포함 프로필 조회.
 * 한번 조회한 사용자는 24시간 동안 재조회하지 않음.
 */
async function getUserProfileCached(aadObjectId) {
  const cached = _profileCache.get(aadObjectId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.profile;
  }

  const profile = await getUserProfile(aadObjectId);
  if (profile) {
    _profileCache.set(aadObjectId, {
      profile,
      expiresAt: Date.now() + PROFILE_CACHE_TTL,
    });
  }
  return profile;
}

module.exports = { getUserProfile, getUserProfileCached };
