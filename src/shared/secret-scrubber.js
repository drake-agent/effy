/**
 * secret-scrubber.js — 시크릿 패턴 탐지 + 출력 스크러빙 미들웨어.
 *
 * SpaceBot 차용: LLM 응답에서 API 키, 비밀번호 패턴을 자동 탐지하고
 * 스크러빙한 후 채널로 전달. 시크릿 유출 방지 레이어.
 *
 * 탐지 대상:
 * - API 키 패턴 (sk_, pk_, ghp_, xoxb- 등)
 * - Bearer/Basic 토큰
 * - AWS 자격증명 (AKIA...)
 * - 비밀번호 패턴 (password=, secret= 등)
 * - Private 키 (-----BEGIN)
 * - Base64 인코딩된 시크릿
 * - IP:Port 패턴 (내부 네트워크)
 * - 데이터베이스 연결 문자열
 */
const { createLogger } = require('./logger');

const log = createLogger('secret-scrubber');

// ─── 시크릿 패턴 정의 ───

const SECRET_PATTERNS = [
  // API 키 패턴
  { name: 'anthropic_key', pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g, replacement: '[ANTHROPIC_KEY_REDACTED]' },
  { name: 'openai_key', pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g, replacement: '[OPENAI_KEY_REDACTED]' },
  { name: 'github_pat', pattern: /\bghp_[a-zA-Z0-9]{36,}\b/g, replacement: '[GITHUB_PAT_REDACTED]' },
  { name: 'github_token', pattern: /\bgho_[a-zA-Z0-9]{36,}\b/g, replacement: '[GITHUB_TOKEN_REDACTED]' },
  { name: 'slack_token', pattern: /\bxox[bpras]-[a-zA-Z0-9-]{10,}\b/g, replacement: '[SLACK_TOKEN_REDACTED]' },
  { name: 'stripe_key', pattern: /\b[sr]k_(live|test)_[a-zA-Z0-9]{10,}\b/g, replacement: '[STRIPE_KEY_REDACTED]' },
  { name: 'aws_access_key', pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: '[AWS_ACCESS_KEY_REDACTED]' },
  { name: 'aws_secret_key', pattern: /\b[A-Za-z0-9/+=]{40}\b/g, replacement: null }, // context-dependent, checked separately

  // Bearer/Basic 토큰
  { name: 'bearer_token', pattern: /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/gi, replacement: 'Bearer [TOKEN_REDACTED]' },
  { name: 'basic_auth', pattern: /\bBasic\s+[a-zA-Z0-9+/=]{10,}\b/gi, replacement: 'Basic [CREDENTIALS_REDACTED]' },

  // 비밀번호 패턴
  { name: 'password_assign', pattern: /(?:password|passwd|pwd|secret|token|api_?key|apikey)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi, replacement: '[PASSWORD_REDACTED]' },

  // Private 키
  { name: 'private_key', pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[PRIVATE_KEY_REDACTED]' },
  { name: 'certificate', pattern: /-----BEGIN\s+CERTIFICATE-----[\s\S]*?-----END\s+CERTIFICATE-----/g, replacement: '[CERTIFICATE_REDACTED]' },

  // 데이터베이스 연결 문자열
  { name: 'db_connection', pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s'"]+/gi, replacement: '[DATABASE_URL_REDACTED]' },

  // 내부 IP:Port (사설 네트워크)
  { name: 'private_ip', pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):\d{2,5}\b/g, replacement: '[INTERNAL_ENDPOINT_REDACTED]' },

  // JWT 토큰
  { name: 'jwt_token', pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g, replacement: '[JWT_REDACTED]' },

  // 환경 변수 노출 패턴
  { name: 'env_var', pattern: /\b[A-Z_]{3,30}_(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|API)\s*=\s*[^\s]{8,}/g, replacement: '[ENV_VAR_REDACTED]' },
];

/**
 * 텍스트에서 시크릿 패턴 탐지.
 *
 * @param {string} text - 검사할 텍스트
 * @returns {{ found: boolean, detections: Array<{name: string, count: number}>, count: number }}
 */
function detectSecrets(text) {
  if (!text || typeof text !== 'string') {
    return { found: false, detections: [], count: 0 };
  }

  const detections = [];
  let totalCount = 0;

  for (const { name, pattern } of SECRET_PATTERNS) {
    if (!pattern) continue;

    // Reset regex state (global flag)
    pattern.lastIndex = 0;
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      detections.push({ name, count: matches.length });
      totalCount += matches.length;
    }
  }

  return {
    found: totalCount > 0,
    detections,
    count: totalCount,
  };
}

/**
 * 텍스트에서 시크릿 패턴 스크러빙 (치환).
 *
 * @param {string} text - 스크러빙할 텍스트
 * @param {Object} [opts]
 * @param {boolean} [opts.logDetections=true] - 탐지 로깅 여부
 * @param {string} [opts.context=''] - 로그용 컨텍스트 정보
 * @returns {{ scrubbed: string, detected: boolean, detections: Array }}
 */
function scrubSecrets(text, opts = {}) {
  const { logDetections = true, context = '' } = opts;

  if (!text || typeof text !== 'string') {
    return { scrubbed: text || '', detected: false, detections: [] };
  }

  let scrubbed = text;
  const detections = [];
  let totalScrubbed = 0;

  for (const { name, pattern, replacement } of SECRET_PATTERNS) {
    if (!pattern || !replacement) continue;

    // Reset regex state
    pattern.lastIndex = 0;
    const matches = scrubbed.match(pattern);
    if (matches && matches.length > 0) {
      scrubbed = scrubbed.replace(pattern, replacement);
      detections.push({ name, count: matches.length });
      totalScrubbed += matches.length;
    }
  }

  if (totalScrubbed > 0 && logDetections) {
    log.warn('Secrets scrubbed from output', {
      context,
      totalScrubbed,
      patterns: detections.map(d => d.name),
    });
  }

  return {
    scrubbed,
    detected: totalScrubbed > 0,
    detections,
  };
}

/**
 * Express 미들웨어 — LLM 응답 스크러빙.
 * Gateway의 reply 파이프라인에 삽입.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.enabled=true]
 * @param {boolean} [opts.blockOnDetection=false] - true면 시크릿 포함 시 전송 차단
 * @returns {Function} middleware
 */
function scrubMiddleware(opts = {}) {
  const { enabled = true, blockOnDetection = false } = opts;

  return function secretScrubMiddleware(responseText, context = {}) {
    if (!enabled) return { text: responseText, scrubbed: false };

    const result = scrubSecrets(responseText, {
      logDetections: true,
      context: `channel=${context.channelId || 'unknown'} user=${context.userId || 'unknown'}`,
    });

    if (result.detected && blockOnDetection) {
      log.error('Response blocked due to secret detection', {
        detections: result.detections,
        context,
      });
      return {
        text: '⚠️ 응답에 민감한 정보가 포함되어 전송이 차단되었습니다. 관리자에게 문의하세요.',
        scrubbed: true,
        blocked: true,
        detections: result.detections,
      };
    }

    return {
      text: result.scrubbed,
      scrubbed: result.detected,
      blocked: false,
      detections: result.detections,
    };
  };
}

module.exports = { detectSecrets, scrubSecrets, scrubMiddleware, SECRET_PATTERNS };
