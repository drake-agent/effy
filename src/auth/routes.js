/**
 * routes.js — OAuth2 콜백 라우터.
 *
 * Express Router로 /auth/* 경로를 처리.
 * webhook.js의 Express 앱에 마운트된다.
 *
 * 엔드포인트:
 *   GET /auth/callback — MS OAuth2 redirect 수신, 토큰 교환, DB 저장
 *   GET /auth/status   — 인증 상태 확인 (디버깅용)
 */

const express = require('express');
const { exchangeCodeForToken } = require('./ms-oauth');
const { entity } = require('../memory/manager');
const { createLogger } = require('../shared/logger');

const log = createLogger('auth-routes');
const router = express.Router();

/**
 * GET /auth/callback
 *
 * MS OAuth2 redirect에서 code와 state를 받아 토큰 교환 후 DB 저장.
 * 성공 시 사용자에게 완료 페이지를 보여준다.
 */
router.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // MS에서 에러를 보낸 경우
  if (error) {
    log.warn('OAuth callback error from MS', { error, error_description });
    return res.status(400).send(renderPage('인증 실패', `Microsoft 인증 오류: ${error_description || error}`, false));
  }

  if (!code || !state) {
    return res.status(400).send(renderPage('인증 실패', '잘못된 요청입니다. code 또는 state가 없습니다.', false));
  }

  try {
    const result = await exchangeCodeForToken(code, state);

    if (!result) {
      return res.status(400).send(renderPage('인증 실패', '토큰 교환에 실패했습니다. 다시 시도해주세요.', false));
    }

    // Entity에 MS 토큰 저장
    const { userId, platform, accessToken, refreshToken, expiresAt, userInfo } = result;

    await entity.upsert('user', userId, userInfo?.displayName || userId, {
      ms_auth: {
        accessToken,
        refreshToken,
        expiresAt,
        email: userInfo?.mail || userInfo?.userPrincipalName || '',
        displayName: userInfo?.displayName || '',
        department: userInfo?.department || '',
        authenticatedAt: new Date().toISOString(),
      },
    });

    log.info('MS OAuth token saved', {
      userId,
      platform,
      email: userInfo?.mail || 'unknown',
    });

    const displayName = userInfo?.displayName || '사용자';
    const email = userInfo?.mail || userInfo?.userPrincipalName || '';

    return res.send(renderPage(
      'Microsoft 인증 완료',
      `${displayName}${email ? ` (${email})` : ''} 계정이 Effy와 연동되었습니다.\n이 창을 닫고 Slack으로 돌아가세요.`,
      true,
    ));
  } catch (err) {
    log.error('OAuth callback error', { error: err.message });
    return res.status(500).send(renderPage('인증 실패', '서버 오류가 발생했습니다.', false));
  }
});

/**
 * GET /auth/status
 *
 * OAuth 설정 상태 확인 (디버깅용, 민감 정보 미노출).
 */
router.get('/auth/status', (_req, res) => {
  const { getOAuthConfig } = require('./ms-oauth');
  const conf = getOAuthConfig();

  res.json({
    configured: !!conf,
    tenantId: conf ? conf.tenantId.slice(0, 8) + '...' : null,
    redirectUri: conf?.redirectUri || null,
  });
});

/**
 * 인증 결과 HTML 페이지 렌더링.
 */
function renderPage(title, message, success) {
  const color = success ? '#2ea44f' : '#d73a49';
  const icon = success ? '&#10003;' : '&#10007;';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Effy - ${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f6f8fa; }
    .card { background: white; border-radius: 12px; padding: 40px; max-width: 400px; text-align: center; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
    .icon { font-size: 48px; color: ${color}; margin-bottom: 16px; }
    h1 { font-size: 20px; color: #24292f; margin: 0 0 12px; }
    p { color: #57606a; line-height: 1.6; white-space: pre-line; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

module.exports = { authRouter: router };
