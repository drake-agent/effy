/**
 * rest-api.js — REST API 커넥터.
 *
 * 외부 REST API에 GET/POST 요청. KB, ERP, CRM 등 연동.
 *
 * Config 예시:
 *   datasources:
 *     erp-api:
 *       type: rest_api
 *       baseUrl: https://erp.company.com/api/v2
 *       auth:
 *         type: bearer          # bearer | basic | header | none
 *         token: ${ERP_TOKEN}
 *       headers:
 *         X-Tenant: acme-corp
 *       timeoutMs: 15000
 *       maxResults: 200
 *       agents: [ops, knowledge]
 */
const { BaseConnector } = require('../base-connector');

class RestApiConnector extends BaseConnector {
  constructor(id, options) {
    super(id, 'rest_api', options);
    this.baseUrl = (options.baseUrl || '').replace(/\/+$/, '');
    this.authConfig = options.auth || { type: 'none' };
    this.defaultHeaders = options.headers || {};
  }

  async init() {
    if (!this.baseUrl) throw new Error(`rest_api:${this.id} — baseUrl 필수`);
    // 연결 확인 (health check)
    try {
      const healthPath = this.options.healthPath || '/';
      await this.withTimeout(this._fetch(healthPath, 'GET'), 5000);
      this.ready = true;
      this.log.info('Connected', { baseUrl: this.baseUrl });
    } catch (e) {
      this.log.warn('Health check failed, marking ready anyway', { error: e.message });
      this.ready = true; // 헬스체크 실패해도 사용 가능하게 (lazy 연결)
    }
  }

  /**
   * REST API 조회.
   * @param {string} queryString — API 경로 (e.g. "/employees?dept=engineering")
   * @param {object} params — { method: 'GET'|'POST', body: object }
   */
  async query(queryString, params = {}) {
    if (!this.ready) throw new Error(`rest_api:${this.id} — 초기화되지 않음`);

    const method = (params.method || 'GET').toUpperCase();
    const rawPath = queryString.startsWith('/') ? queryString : `/${queryString}`;

    // SSRF 방어: path traversal 세그먼트 차단
    if (/(?:^|\/)\.\.(\/|$)/.test(rawPath)) {
      return { rows: [], metadata: { error: 'SSRF 방어: ".." 경로 세그먼트 불허', connector: this.id } };
    }
    // SEC-9 fix: Block protocol-relative URLs and host manipulation
    if (/^\/\//.test(rawPath) || /@/.test(rawPath) || /#/.test(rawPath)) {
      return { rows: [], metadata: { error: 'SSRF defense: invalid path characters', blocked: true } };
    }
    // Validate path only contains safe characters
    if (!/^[a-zA-Z0-9_\/\-\.%\?\&\=]+$/.test(rawPath)) {
      return { rows: [], metadata: { error: 'SSRF defense: path contains unsafe characters', blocked: true } };
    }
    const path = rawPath;

    // readOnly 모드에서는 GET만 허용
    if (method !== 'GET') {
      const blocked = this.guardReadOnly(method);
      if (blocked) return blocked;
    }

    const response = await this.withTimeout(
      this._fetch(path, method, params.body),
      params.timeoutMs
    );

    // 응답 정규화
    const rows = Array.isArray(response) ? response : (response?.data ?? response?.results ?? [response]);

    return {
      rows: this.truncateResults(rows),
      metadata: {
        connector: this.id,
        path,
        method,
        rowCount: rows.length,
        truncated: rows.length > this.maxResults,
      },
    };
  }

  async destroy() {
    await super.destroy();
    this.log.info('Disconnected');
  }

  // ─── 내부 ─────────────────────────────────────────

  async _fetch(path, method = 'GET', body = null) {
    const url = `${this.baseUrl}${path}`;
    const headers = { ...this._buildAuthHeaders(), ...this.defaultHeaders };

    if (body && typeof body === 'object') {
      headers['Content-Type'] = 'application/json';
    }

    // ARCH-004: Add default timeout with AbortController
    const controller = new AbortController();
    const defaultTimeoutMs = this.options.timeoutMs || 30000;
    const timeoutId = setTimeout(() => controller.abort(), defaultTimeoutMs);

    try {
      const options = {
        method,
        headers,
        signal: controller.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      };

      const res = await fetch(url, options);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return res.json();
      }
      return { text: await res.text() };
    } finally {
      clearTimeout(timeoutId);
      controller.abort();
    }
  }

  _buildAuthHeaders() {
    const { type, token, username, password, headerName, headerValue } = this.authConfig;
    switch (type) {
      case 'bearer': return { Authorization: `Bearer ${token}` };
      case 'basic': return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
      case 'header': return { [headerName]: headerValue };
      default: return {};
    }
  }
}

module.exports = { RestApiConnector };
