/**
 * tool-gap-detector.js — Self-Tooling MVP (v3.9).
 *
 * 에이전트가 작업 중 "할 수 없음"을 인식하고, 필요한 도구/커넥터를
 * 자동으로 식별 → 스텁 생성 → 관리자에게 승인 요청하는 시스템.
 *
 * Self-Tooling의 현실적 범위:
 * ┌──────────────────────────────────────────────────────┐
 * │ ✅ 가능한 것 (이 파일이 하는 것)                      │
 * │ 1. Tool gap 감지: 에이전트 응답에서 "못 했다" 패턴 탐지 │
 * │ 2. Gap 분류: 어떤 종류의 도구가 부족한지 카테고리화     │
 * │ 3. 커넥터 스텁 자동 생성: 표준 REST/API 커넥터 템플릿   │
 * │ 4. 관리자 승인 큐: 자동 실행은 안전하지 않으므로 큐에 쌓임│
 * │                                                      │
 * │ ⚠️ 제한적 (향후 확장)                                 │
 * │ - OAuth 인증이 필요한 서비스는 자동 연결 불가           │
 * │ - 복잡한 API는 스텁만 생성, 실제 구현은 수동           │
 * │ - LLM이 코드를 생성하여 자동 배포하는 것은 안전상 차단  │
 * └──────────────────────────────────────────────────────┘
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('tools:gap-detector');

/**
 * Tool gap 탐지 패턴.
 * 에이전트 응답에서 이 패턴이 감지되면 tool gap으로 분류.
 */
/** 입력 길이 제한 — ReDoS 방지 */
const MAX_INPUT_LENGTH = 500;

const GAP_PATTERNS = [
  // 직접적 불가 표현 — 단순화된 패턴 (ReDoS 방지: \w[\w\s]* → \w{1,50})
  { regex: /(?:don't|do not|cannot|can't|unable to) (?:have )?access to (\w[\w ]{0,50})/i, category: 'access' },
  { regex: /no (?:tool|integration|connector|plugin) (?:for|to) (\w[\w ]{0,50})/i, category: 'missing_tool' },
  { regex: /(?:couldn't|could not|wasn't able to) (?:find|get|fetch|retrieve|access) (\w[\w ]{0,50})/i, category: 'data_access' },

  // 외부 서비스 참조 — 정확한 서비스명 매칭 (backtracking 없음)
  { regex: /(?:need|require)s? (?:access to|integration with|a connector for) (\w[\w ]{0,50})/i, category: 'integration' },
  { regex: /\b(Jira|Confluence|Notion|GitHub|GitLab|Linear|Asana|Trello|Figma|Datadog|PagerDuty|Sentry)\b/i, category: 'external_service' },

  // 데이터 부족
  { regex: /(?:no|don't have) (?:data|information|records|logs|metrics) (?:about|on|for|from) (\w[\w ]{0,50})/i, category: 'data_source' },

  // 한국어 패턴
  { regex: /(?:접근|연동|연결|도구|커넥터)(?:이|가)\s*(?:없|불가|안 됨|필요)/i, category: 'missing_tool' },
  { regex: /(?:가져올|조회할|확인할)\s*수\s*없/i, category: 'data_access' },
];

/**
 * 카테고리 → 커넥터 템플릿 매핑.
 */
const CONNECTOR_TEMPLATES = {
  rest_api: {
    type: 'rest',
    template: (name, baseUrl) => ({
      id: `connector-${name.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'rest_api',
      name,
      baseUrl: baseUrl || `https://api.${name.toLowerCase()}.com`,
      auth: { type: 'bearer', tokenEnvVar: `${name.toUpperCase().replace(/\s+/g, '_')}_API_TOKEN` },
      endpoints: [
        { method: 'GET', path: '/api/v1/resource', description: `List ${name} resources` },
        { method: 'GET', path: '/api/v1/resource/:id', description: `Get ${name} resource by ID` },
      ],
      generatedAt: new Date().toISOString(),
      status: 'stub',
    }),
  },
  webhook: {
    type: 'webhook',
    template: (name) => ({
      id: `webhook-${name.toLowerCase().replace(/\s+/g, '-')}`,
      type: 'webhook',
      name,
      inboundUrl: `/webhooks/${name.toLowerCase()}`,
      events: ['created', 'updated', 'deleted'],
      generatedAt: new Date().toISOString(),
      status: 'stub',
    }),
  },
};

/**
 * 알려진 서비스 → 커넥터 정보 매핑.
 */
const KNOWN_SERVICES = {
  jira: { category: 'project_management', baseUrl: 'https://your-domain.atlassian.net', authType: 'oauth2' },
  confluence: { category: 'knowledge_base', baseUrl: 'https://your-domain.atlassian.net/wiki', authType: 'oauth2' },
  notion: { category: 'knowledge_base', baseUrl: 'https://api.notion.com', authType: 'bearer' },
  github: { category: 'code', baseUrl: 'https://api.github.com', authType: 'bearer' },
  gitlab: { category: 'code', baseUrl: 'https://gitlab.com/api/v4', authType: 'bearer' },
  linear: { category: 'project_management', baseUrl: 'https://api.linear.app', authType: 'bearer' },
  asana: { category: 'project_management', baseUrl: 'https://app.asana.com/api/1.0', authType: 'bearer' },
  figma: { category: 'design', baseUrl: 'https://api.figma.com', authType: 'bearer' },
  datadog: { category: 'monitoring', baseUrl: 'https://api.datadoghq.com', authType: 'api_key' },
  pagerduty: { category: 'incident', baseUrl: 'https://api.pagerduty.com', authType: 'bearer' },
  sentry: { category: 'error_tracking', baseUrl: 'https://sentry.io/api/0', authType: 'bearer' },
  google_calendar: { category: 'calendar', baseUrl: 'https://www.googleapis.com/calendar/v3', authType: 'oauth2' },
  google_docs: { category: 'document', baseUrl: 'https://docs.googleapis.com/v1', authType: 'oauth2' },
};

class ToolGapDetector {
  constructor(opts = {}) {
    this.db = opts.db || null;

    /** @type {Array<Object>} 감지된 gap 큐 (관리자 승인 대기) */
    this._gapQueue = [];
    /** @type {Map<string, number>} gap 중복 방지: key → last detected timestamp */
    this._dedupeMap = new Map();
    this._dedupeWindowMs = opts.dedupeWindowMs || 6 * 60 * 60 * 1000; // 6시간

    this._stats = { detected: 0, stubs_generated: 0, approved: 0, rejected: 0 };
  }

  /**
   * 에이전트 응답에서 tool gap 감지.
   *
   * @param {string} agentId - 응답한 에이전트
   * @param {string} response - 에이전트 응답 텍스트
   * @param {Object} [context] - { userId, channelId, query }
   * @returns {Object|null} 감지된 gap 또는 null
   */
  detect(agentId, response, context = {}) {
    if (!response || typeof response !== 'string') return null;

    // ReDoS 방지: 입력 길이 제한
    const input = response.length > MAX_INPUT_LENGTH ? response.substring(0, MAX_INPUT_LENGTH) : response;

    for (const pattern of GAP_PATTERNS) {
      const match = input.match(pattern.regex);
      if (match) {
        const serviceName = this._extractServiceName(match[0], match[1]);
        const dedupeKey = `${agentId}:${pattern.category}:${serviceName}`;

        // 중복 방지
        const lastDetected = this._dedupeMap.get(dedupeKey) || 0;
        if (Date.now() - lastDetected < this._dedupeWindowMs) {
          return null;
        }

        const gap = {
          id: `gap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          agentId,
          category: pattern.category,
          serviceName,
          matchedText: match[0].substring(0, 100),
          query: context.query || '',
          userId: context.userId || '',
          channelId: context.channelId || '',
          detectedAt: new Date().toISOString(),
          status: 'pending', // pending → stub_generated → approved → active | rejected
          stub: null,
        };

        this._dedupeMap.set(dedupeKey, Date.now());
        this._stats.detected++;

        // 알려진 서비스인 경우 자동 스텁 생성
        const known = this._matchKnownService(serviceName);
        if (known) {
          gap.stub = this._generateStub(known.name, known.info);
          gap.status = 'stub_generated';
          this._stats.stubs_generated++;
        }

        this._gapQueue.push(gap);
        log.info('Tool gap detected', {
          agentId,
          category: gap.category,
          service: serviceName,
          hasStub: !!gap.stub,
        });

        return gap;
      }
    }

    return null;
  }

  /**
   * 관리자 승인 대기 큐 조회.
   * @returns {Array<Object>}
   */
  getPendingGaps() {
    return this._gapQueue.filter(g => g.status === 'pending' || g.status === 'stub_generated');
  }

  /**
   * Gap 승인 → 커넥터 활성화 (향후 DataSource Registry에 등록).
   * @param {string} gapId
   * @returns {Object} 결과
   */
  approve(gapId) {
    const gap = this._gapQueue.find(g => g.id === gapId);
    if (!gap) return { success: false, error: 'gap_not_found' };

    gap.status = 'approved';
    gap.approvedAt = new Date().toISOString();
    this._stats.approved++;

    log.info('Tool gap approved', { gapId, service: gap.serviceName });
    return { success: true, gap };
  }

  /**
   * Gap 거부.
   * @param {string} gapId
   * @returns {Object}
   */
  reject(gapId) {
    const gap = this._gapQueue.find(g => g.id === gapId);
    if (!gap) return { success: false, error: 'gap_not_found' };

    gap.status = 'rejected';
    this._stats.rejected++;
    return { success: true };
  }

  // ─── 내부 메서드 ───

  /** @private 알려진 서비스 매칭 */
  _matchKnownService(name) {
    if (!name) return null;
    const lower = name.toLowerCase().replace(/\s+/g, '_');

    // 정확한 매칭
    if (KNOWN_SERVICES[lower]) {
      return { name: lower, info: KNOWN_SERVICES[lower] };
    }

    // 부분 매칭
    for (const [key, info] of Object.entries(KNOWN_SERVICES)) {
      if (lower.includes(key) || key.includes(lower)) {
        return { name: key, info };
      }
    }

    return null;
  }

  /** @private 커넥터 스텁 생성 */
  _generateStub(serviceName, serviceInfo) {
    const stub = CONNECTOR_TEMPLATES.rest_api.template(serviceName, serviceInfo.baseUrl);
    stub.auth.type = serviceInfo.authType || 'bearer';
    stub.category = serviceInfo.category;
    return stub;
  }

  /** @private 서비스 이름 추출 */
  _extractServiceName(fullMatch, capturedGroup) {
    // 알려진 서비스 이름이 fullMatch에 있으면 그것 사용
    for (const key of Object.keys(KNOWN_SERVICES)) {
      const regex = new RegExp(key.replace('_', '[\\s_]'), 'i');
      if (regex.test(fullMatch)) {
        return key;
      }
    }
    // captured group 사용
    return (capturedGroup || fullMatch).trim().substring(0, 50);
  }

  /** 통계 */
  getStats() {
    return {
      ...this._stats,
      pendingCount: this.getPendingGaps().length,
      totalInQueue: this._gapQueue.length,
    };
  }
}

module.exports = { ToolGapDetector, GAP_PATTERNS, KNOWN_SERVICES, CONNECTOR_TEMPLATES };
