/**
 * webhook.js — GitHub Webhook Handler.
 *
 * PR open/merge/push → Haiku 요약 → L4 Entity → KPI DB → Slack 알림.
 * Express 서버로 별도 포트에서 수신 (Cloudflare Tunnel 연결).
 *
 * SEC: Security Template 준수
 * - HMAC 시그니처 검증 (raw body 기반)
 * - 페이로드 스키마 검증 (구조적 필수 필드)
 * - 엔드포인트 rate limiting (IP 기반 sliding window)
 * - 에러 메시지 정보 유출 방지 (내부 상세 → 제네릭 응답)
 * - 모든 DB write는 parameterized query
 */
const express = require('express');
const crypto = require('crypto');
const { config } = require('../config');
const { getDb } = require('../db');
const { entity } = require('../memory/manager');
const { client } = require('../shared/anthropic');

// ─── SEC-A: GitHub Signature Verification ───

function verifyGitHubSignature(payload, signature, secret) {
  if (!signature || !secret) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── SEC-B: Webhook Rate Limiter (IP 기반, 분당 30회) ───
const WEBHOOK_RATE_LIMIT = 30;
const WEBHOOK_RATE_WINDOW_MS = 60_000;
const webhookRateMap = new Map(); // IP → [timestamps]

const WEBHOOK_RATE_MAP_MAX_SIZE = 10000;

function checkWebhookRate(ip) {
  const now = Date.now();
  const cutoff = now - WEBHOOK_RATE_WINDOW_MS;
  let timestamps = webhookRateMap.get(ip) || [];
  timestamps = timestamps.filter(t => t > cutoff);
  timestamps.push(now);
  webhookRateMap.set(ip, timestamps);

  // Cap the rate map size to prevent unbounded growth
  if (webhookRateMap.size > WEBHOOK_RATE_MAP_MAX_SIZE) {
    const keysIter = webhookRateMap.keys();
    const toRemove = webhookRateMap.size - WEBHOOK_RATE_MAP_MAX_SIZE;
    for (let i = 0; i < toRemove; i++) {
      webhookRateMap.delete(keysIter.next().value);
    }
  }

  return timestamps.length <= WEBHOOK_RATE_LIMIT;
}

// 주기적 정리 (메모리 누수 방지)
const _cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - WEBHOOK_RATE_WINDOW_MS;
  for (const [ip, ts] of webhookRateMap.entries()) {
    const filtered = ts.filter(t => t > cutoff);
    if (filtered.length === 0) webhookRateMap.delete(ip);
    else webhookRateMap.set(ip, filtered);
  }
}, 60_000);
_cleanupTimer.unref();

// ─── SEC-A: Payload Validators ───

function validatePRPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'invalid payload';
  if (!payload.action || typeof payload.action !== 'string') return 'missing action';
  if (!payload.pull_request || typeof payload.pull_request !== 'object') return 'missing pull_request';
  if (!payload.repository || typeof payload.repository !== 'object') return 'missing repository';
  const pr = payload.pull_request;
  if (!pr.user || typeof pr.user.login !== 'string') return 'missing pull_request.user.login';
  if (typeof payload.repository.full_name !== 'string') return 'missing repository.full_name';
  if (typeof pr.number !== 'number') return 'missing pull_request.number';
  if (typeof pr.title !== 'string') return 'missing pull_request.title';
  return null;
}

function validatePushPayload(payload) {
  if (!payload || typeof payload !== 'object') return 'invalid payload';
  if (!payload.repository || typeof payload.repository !== 'object') return 'missing repository';
  if (typeof payload.repository.full_name !== 'string') return 'missing repository.full_name';
  return null;
}

/**
 * GitHub login → Slack user_id 매핑 헬퍼.
 */
async function resolveSlackUser(githubLogin) {
  const db = getDb();
  const mapping = await db.prepare('SELECT slack_user_id FROM user_mappings WHERE github_login = ?').get(githubLogin);
  return mapping?.slack_user_id || null;
}

/**
 * SEC: 문자열 새니타이즈 — DB 저장 전 길이 제한 + 제어문자 제거.
 */
function sanitizeString(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maxLen);
}

function startWebhookServer(slackClient) {
  const app = express();

  // SEC: raw body 보존 — HMAC 검증에 원본 바이트 필요
  app.use(express.json({
    limit: '1mb',  // SEC: 5mb → 1mb로 축소 (GitHub webhook 페이로드는 일반적으로 < 100KB)
    verify: (req, _res, buf) => { req.rawBody = buf; },
  }));

  // SEC: 보안 헤더
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.removeHeader('X-Powered-By');
    next();
  });

  app.post('/github/webhook', async (req, res) => {
    // SEC-B: Rate limit 체크
    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkWebhookRate(clientIp)) {
      console.warn(`[github] Rate limited: ${clientIp}`);
      return res.status(429).send('Too Many Requests');
    }

    // SEC-A: HMAC-SHA256 시그니처 검증 (raw body 기반) — secret is REQUIRED
    const signature = req.headers['x-hub-signature-256'];
    const secret = config?.github?.webhookSecret || process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.error('[github] Webhook secret not configured — rejecting request');
      return res.status(500).json({ error: 'Webhook secret not configured' });
    }
    if (!verifyGitHubSignature(req.rawBody.toString(), signature, secret)) {
      console.warn('[github] GitHub webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = req.headers['x-github-event'];
    if (!event || typeof event !== 'string') {
      return res.status(400).send('Missing event header');
    }

    const payload = req.body;

    try {
      await handleGitHubEvent(event, payload, slackClient);
      res.status(200).send('OK');
    } catch (err) {
      // SEC-D: 내부 에러 메시지를 클라이언트에 노출하지 않음
      console.error('[github] Webhook error:', err.message);
      res.status(500).send('Internal Error');
    }
  });

  app.get('/health', (_req, res) => res.send('OK'));

  // v5.1: OAuth2 Auth Routes — /auth/*
  try {
    const { authRouter } = require('../auth/routes');
    app.use(authRouter);
    console.log('[auth] OAuth routes mounted at /auth/*');
  } catch (authErr) {
    console.warn('[auth] Failed to mount:', authErr.message);
  }

  // v3.6.2: Dashboard UI — /dashboard/*
  try {
    const { dashboardRouter } = require('../dashboard/router');
    app.use('/dashboard', dashboardRouter);
    console.log('[dashboard] Mounted at /dashboard');
  } catch (dashErr) {
    console.warn('[dashboard] Failed to mount:', dashErr.message);
  }

  // SEC: 정의되지 않은 경로 차단
  app.use((_req, res) => res.status(404).send('Not Found'));

  const port = config.github?.webhookPort || config.gateway?.port || 3100;
  app.listen(port, () => {
    console.log(`[github] Webhook server listening on :${port}`);
  });
}

/**
 * GitHub 이벤트 핸들러.
 */
async function handleGitHubEvent(event, payload, slackClient) {
  if (event === 'pull_request') {
    await handlePR(payload, slackClient);
  } else if (event === 'push') {
    await handlePush(payload, slackClient);
  }
  // 추후 확장: pull_request_review, issues, etc.
}

/**
 * PR 이벤트 처리.
 */
async function handlePR(payload, slackClient) {
  const action = payload.action;
  if (!['opened', 'closed'].includes(action)) return;

  // SEC-A: 페이로드 스키마 검증
  const validationError = validatePRPayload(payload);
  if (validationError) {
    console.warn(`[github] PR payload validation failed: ${validationError}`);
    return;
  }

  if (action === 'closed' && !payload.pull_request.merged) return;

  const pr = payload.pull_request;
  const eventType = action === 'opened' ? 'pr_open' : 'pr_merge';
  const githubLogin = sanitizeString(pr.user.login, 100);
  const repo = sanitizeString(payload.repository.full_name, 200);

  const db = getDb();
  const slackUserId = await resolveSlackUser(githubLogin);

  // Haiku 요약 (PR 바디가 있으면)
  let prSummary = '';
  const bodyExists = pr.body && typeof pr.body === 'string' && pr.body.length > 30;
  if (bodyExists) {
    try {
      const response = await client.messages.create({
        model: config.anthropic.defaultModel,
        max_tokens: 150,
        system: 'PR 내용을 1~2문장으로 요약하세요. 한국어로.',
        messages: [{ role: 'user', content: `제목: ${sanitizeString(pr.title, 300)}\n내용: ${sanitizeString(pr.body, 2000)}` }],
      });
      prSummary = response.content[0]?.text || '';
    } catch (e) {
      prSummary = sanitizeString(pr.title, 300);
    }
  } else {
    prSummary = sanitizeString(pr.title, 300);
  }

  try {
    await db.prepare(`
      INSERT INTO github_events (event_type, repo, user_id, github_login, pr_number, pr_title, pr_summary, additions, deletions, files_changed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventType, repo, slackUserId, githubLogin, pr.number,
           sanitizeString(pr.title, 300), sanitizeString(prSummary, 1000),
           Math.max(0, parseInt(pr.additions) || 0),
           Math.max(0, parseInt(pr.deletions) || 0),
           Math.max(0, parseInt(pr.changed_files) || 0));
  } catch (dbErr) {
    console.error(`[github] Failed to insert github_event: ${dbErr.message}`, { eventType, repo, pr: pr.number });
  }

  if (slackUserId) {
    await entity.upsert('user', slackUserId, githubLogin, { github_login: githubLogin });
    await entity.addRelationship('user', slackUserId, 'repo', repo, 'contributes_to');
  }

  console.log(`[github] ${eventType}: ${githubLogin} → ${repo}#${pr.number}`);
}

/**
 * Push 이벤트 처리.
 */
async function handlePush(payload, slackClient) {
  // SEC-A: 페이로드 스키마 검증
  const validationError = validatePushPayload(payload);
  if (validationError) {
    console.warn(`[github] Push payload validation failed: ${validationError}`);
    return;
  }

  const githubLogin = sanitizeString(
    payload.pusher?.name || payload.sender?.login || 'unknown', 100
  );
  const repo = sanitizeString(payload.repository.full_name, 200);
  const commits = payload.commits || [];

  if (commits.length === 0) return;

  const db = getDb();
  const slackUserId = await resolveSlackUser(githubLogin);

  await db.prepare(`
    INSERT INTO github_events (event_type, repo, user_id, github_login, pr_number, pr_title, additions, deletions, files_changed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('push', repo, slackUserId, githubLogin, null,
         `${Math.min(commits.length, 9999)} commits`, 0, 0, 0);

  console.log(`[github] push: ${githubLogin} → ${repo} (${commits.length} commits)`);
}

/**
 * KPI 슬래시 커맨드 핸들러.
 */
async function getKPI(args) {
  // SEC: 입력 새니타이즈
  const safeArgs = sanitizeString(args, 200);
  const db = getDb();

  if (safeArgs.startsWith('@') || safeArgs.startsWith('<@')) {
    const userMatch = safeArgs.match(/<@([A-Z0-9]+)>/);
    const userId = userMatch ? userMatch[1] : safeArgs.replace('@', '').replace(/[^A-Za-z0-9_]/g, '');
    const events = await db.prepare(`
      SELECT event_type, COUNT(*) as cnt, SUM(additions) as adds, SUM(deletions) as dels
      FROM github_events WHERE user_id = ? AND created_at >= datetime('now', '-7 days')
      GROUP BY event_type
    `).all(userId);
    return events.length > 0
      ? events.map(e => `${e.event_type}: ${e.cnt}건 (+${e.adds || 0}/-${e.dels || 0})`).join('\n')
      : '최근 7일간 활동 없음';
  }

  if (safeArgs.includes('team') || safeArgs.includes('팀')) {
    const period = safeArgs.includes('month') ? '-30 days' : '-7 days';
    const events = await db.prepare(`
      SELECT github_login, event_type, COUNT(*) as cnt, SUM(additions) as adds, SUM(deletions) as dels
      FROM github_events WHERE created_at >= datetime('now', ?)
      GROUP BY github_login, event_type ORDER BY cnt DESC LIMIT 20
    `).all(period);
    if (events.length === 0) return '해당 기간 활동 없음';
    return events.map(e => `${e.github_login}: ${e.event_type} ${e.cnt}건 (+${e.adds || 0}/-${e.dels || 0})`).join('\n');
  }

  return '사용법: /kpi @user | /kpi team week | /kpi team month';
}

module.exports = { startWebhookServer, getKPI };
