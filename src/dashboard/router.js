/**
 * router.js — Dashboard Express Router.
 *
 * Express 앱에 마운트:
 *   app.use('/dashboard', dashboardRouter);
 *
 * Routes:
 *   GET /dashboard          → index.html (React SPA) — Admin only
 *   GET /dashboard/app.jsx  → 클라이언트 JSX — Admin only
 *   GET /dashboard/api/*    → Metrics API (JSON + SSE) — Admin only (별도 미들웨어)
 *
 * R3-INCOMPLETE-1: 전체 /dashboard/* 경로에 Admin 인증 적용.
 * 단, HTML/JSX 정적 파일은 API 키 없이도 접근 가능해야 하므로,
 * HTML은 허용하되 API 데이터는 별도 인증.
 * (UI를 숨기고 싶으면 아래 authGate 주석 해제)
 */
const { Router } = require('express');
const path = require('path');
const { router: apiRouter, inject, broadcastSSE } = require('./api/metrics');
const { isAdmin } = require('../shared/auth');

const dashboardRouter = Router();

// R3-INCOMPLETE-1: Dashboard 전체 인증 게이트
// HTML/JSX도 Admin만 접근 가능 (UI 존재 자체를 비공개)
dashboardRouter.use((req, res, next) => {
  // API 경로는 metrics.js 자체 미들웨어가 처리 (Bearer 토큰)
  if (req.path.startsWith('/api')) return next();

  // 정적 파일: adminUsers 비어있으면 모두 허용, 아니면 쿠키/헤더 체크
  const userId = req.headers['x-effy-user']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : null);

  if (!isAdmin(userId)) {
    return res.status(403).send('Access denied. Admin authentication required.');
  }
  next();
});

// ─── Static: HTML + JSX ──────────────────────────────

dashboardRouter.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

dashboardRouter.get('/app.jsx', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'app.jsx'));
});

// ─── API Routes ──────────────────────────────────────

dashboardRouter.use('/api', apiRouter);

module.exports = { dashboardRouter, injectDashboard: inject, broadcastSSE };
