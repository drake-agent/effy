/**
 * openclaw-client.js — OpenClaw Gateway HTTP 클라이언트.
 *
 * OpenAI 호환 /v1/chat/completions 엔드포인트를 호출해서
 * OpenClaw 에이전트에게 작업을 위임한다.
 *
 * Usage:
 *   const client = new OpenClawClient({
 *     baseUrl: 'http://localhost:18789',
 *     token: process.env.OPENCLAW_GATEWAY_TOKEN,
 *     defaultAgent: 'openclaw/main',
 *   });
 *   const reply = await client.chat({ message: '안녕', sessionKey: 'user123' });
 */

const { createLogger } = require('../shared/logger');
const log = createLogger('openclaw-client');

class OpenClawClient {
  constructor({ baseUrl, token, defaultAgent = 'openclaw/main', timeoutMs = 60000 }) {
    if (!baseUrl) throw new Error('OpenClawClient: baseUrl is required');
    if (!token) throw new Error('OpenClawClient: token is required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.defaultAgent = defaultAgent;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Send a chat message to OpenClaw and return the assistant's reply text.
   *
   * @param {object} opts
   * @param {string} opts.message - user message content
   * @param {string} [opts.agent] - model/agent id (default: this.defaultAgent)
   * @param {string} [opts.sessionKey] - stable session key for conversation continuity
   * @returns {Promise<string>} assistant reply text
   */
  async chat({ message, messages: msgArray, agent, sessionKey }) {
    // messages 배열 또는 단일 message 지원
    const chatMessages = msgArray || (message ? [{ role: 'user', content: message }] : null);
    if (!chatMessages || chatMessages.length === 0) {
      throw new Error('OpenClawClient.chat: message or messages is required');
    }

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    if (sessionKey) headers['x-openclaw-session-key'] = sessionKey;

    const body = JSON.stringify({
      model: agent || this.defaultAgent,
      messages: chatMessages,
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`OpenClaw API error: ${res.status} ${text}`);
      }

      const data = await res.json();
      const reply = data.choices?.[0]?.message?.content || '';
      log.debug('OpenClaw reply received', { length: reply.length, agent: body.model });
      return reply;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error(`OpenClaw request timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * List available models/agents from OpenClaw.
   * @returns {Promise<Array<{id: string}>>}
   */
  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`OpenClaw /v1/models error: ${res.status}`);
    const data = await res.json();
    return data.data || [];
  }

  /**
   * Quick health check — returns true if gateway is reachable and authorized.
   */
  async ping() {
    try {
      await this.listModels();
      return true;
    } catch (err) {
      log.warn('OpenClaw ping failed', { error: err.message });
      return false;
    }
  }
}

module.exports = { OpenClawClient };
