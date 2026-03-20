/**
 * webhook-outbound.js — Effy 이벤트를 외부 시스템에 실시간 푸시.
 *
 * 지원 이벤트:
 * - decision_detected: 의사결정 감지 시
 * - task_created: 태스크 생성 시
 * - incident_created: 인시던트 생성 시
 * - task_completed: 태스크 완료 시
 * - workflow_completed: 워크플로우 완료 시
 *
 * Config:
 *   webhooks:
 *     - id: jira-sync
 *       url: https://your-jira.atlassian.net/rest/webhooks/1/...
 *       events: [task_created, task_completed]
 *       headers: { Authorization: "Bearer xxx" }
 *       retries: 3
 *
 *     - id: calendar-sync
 *       url: https://www.googleapis.com/calendar/v3/...
 *       events: [decision_detected]
 */
const { config } = require('../config');
const { createLogger } = require('../shared/logger');

const log = createLogger('features:webhook-outbound');

class WebhookOutbound {
  constructor() {
    this.hooks = (config.webhooks || []).map(h => ({
      id: h.id,
      url: h.url,
      events: new Set(h.events || ['*']),
      headers: h.headers || {},
      retries: h.retries ?? 3,
      secret: h.secret || '',
    }));
    this.enabled = this.hooks.length > 0;

    // 통계
    this.stats = { sent: 0, failed: 0, retries: 0 };

    if (this.enabled) {
      log.info('Webhook outbound initialized', { hooks: this.hooks.length });
    }
  }

  /**
   * 이벤트 발생 시 매칭되는 webhook에 전송.
   *
   * @param {string} event - 이벤트 이름
   * @param {object} payload - 이벤트 데이터
   */
  async emit(event, payload) {
    if (!this.enabled) return;

    const matching = this.hooks.filter(h => h.events.has('*') || h.events.has(event));
    if (matching.length === 0) return;

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      source: 'effy',
      version: '3.6.3',
      data: payload,
    });

    const promises = matching.map(hook => this._send(hook, body, event));
    await Promise.allSettled(promises);
  }

  /**
   * 단일 webhook 전송 (재시도 포함).
   */
  async _send(hook, body, event) {
    for (let attempt = 0; attempt <= hook.retries; attempt++) {
      try {
        const headers = {
          'Content-Type': 'application/json',
          'User-Agent': 'Effy/3.6.3',
          'X-Effy-Event': event,
          ...hook.headers,
        };

        // HMAC 서명 (secret 있으면)
        if (hook.secret) {
          const crypto = require('crypto');
          const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
          headers['X-Effy-Signature'] = `sha256=${sig}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(hook.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.ok) {
          this.stats.sent++;
          log.debug('Webhook sent', { hook: hook.id, event, status: res.status });
          return;
        }

        // 4xx는 재시도 안 함
        if (res.status >= 400 && res.status < 500) {
          this.stats.failed++;
          log.warn('Webhook rejected', { hook: hook.id, event, status: res.status });
          return;
        }

        // 5xx는 재시도
        if (attempt < hook.retries) {
          this.stats.retries++;
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        this.stats.failed++;
        log.warn('Webhook failed after retries', { hook: hook.id, event, attempts: attempt + 1 });
      } catch (err) {
        if (attempt < hook.retries) {
          this.stats.retries++;
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        this.stats.failed++;
        log.warn('Webhook error', { hook: hook.id, event, error: err.message });
      }
    }
  }

  getStats() { return this.stats; }
}

// 싱글톤
let _instance = null;
function getWebhookOutbound() {
  if (!_instance) _instance = new WebhookOutbound();
  return _instance;
}

module.exports = { WebhookOutbound, getWebhookOutbound };
