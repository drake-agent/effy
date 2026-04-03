/**
 * middleware.js — 미들웨어 파이프라인.
 * BotFilter → Auth → RateLimit → Logging → Tracing
 */

// ─── Rate Limiter (in-memory sliding window) ───
class RateLimiter {
  constructor(maxPerMinute = 30) {
    this.maxPerMinute = maxPerMinute;
    this.windows = new Map(); // userId → [timestamps]
    this.cleanupInterval = setInterval(() => this._cleanup(), 60000);
    this.cleanupInterval.unref(); // 프로세스 종료 방해 방지
  }

  check(userId) {
    const now = Date.now();
    const cutoff = now - 60_000;
    let timestamps = this.windows.get(userId) || [];
    timestamps = timestamps.filter(t => t > cutoff);
    // R3-BUG-1: 배열 상한 — 메모리 누수 방지
    if (timestamps.length > this.maxPerMinute * 3) {
      timestamps = timestamps.slice(-this.maxPerMinute);
    }
    timestamps.push(now);
    // R3-BUG-1 fix: Cap array to prevent growth from rapid-fire rejected requests.
    // Without cap, a user hammering 1000 req/min keeps 1000 entries even when rate-limited.
    if (timestamps.length > this.maxPerMinute * 3) {
      timestamps = timestamps.slice(-this.maxPerMinute);
    }
    this.windows.set(userId, timestamps);
    return timestamps.length <= this.maxPerMinute;
  }

  _cleanup() {
    const now = Date.now();
    const cutoff = now - 60_000;
    for (const [userId, timestamps] of this.windows.entries()) {
      const filtered = timestamps.filter(t => t > cutoff);
      if (filtered.length === 0) {
        this.windows.delete(userId);
      } else if (filtered.length < timestamps.length) {
        this.windows.set(userId, filtered);
      }
    }
  }

  close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

const crypto = require('crypto');
const { config } = require('../config');
const rateLimiter = new RateLimiter(config.rateLimit?.maxPerMinute || 30);

/**
 * 미들웨어 파이프라인 실행.
 * @param {object} event - Slack 이벤트
 * @returns {{ pass: boolean, reason?: string, traceId: string }}
 */
function runMiddleware(event) {
  const traceId = `t-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // 1. BotFilter — 봇 메시지 무시
  if (event.bot_id || event.subtype === 'bot_message') {
    return { pass: false, reason: 'bot_message', traceId };
  }

  // 2. Auth — 차단 유저 (추후 DB에서 로드)
  // const blockedUsers = new Set();
  // if (blockedUsers.has(event.user)) {
  //   return { pass: false, reason: 'blocked_user', traceId };
  // }

  // 3. RateLimit
  if (event.user && !rateLimiter.check(event.user)) {
    return { pass: false, reason: 'rate_limited', traceId };
  }

  // 4. Logging — SEC: 프로덕션에서는 메시지 본문 로깅 생략 (PII 보호)
  const channelId = event.channel || event.channel_id || '?';
  if (process.env.NODE_ENV === 'production') {
    console.log(`[${traceId}] user=${event.user} ch=${channelId} len=${(event.text || '').length}`);
  } else {
    console.log(`[${traceId}] user=${event.user} ch=${channelId} len=${(event.text || '').length}`);
  }

  return { pass: true, traceId };
}

module.exports = { runMiddleware, RateLimiter };
