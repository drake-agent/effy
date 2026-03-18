/**
 * tier1-security.test.js — Security Template 준수 검증.
 *
 * SEC-A: Payload Validation
 * SEC-B: Webhook Rate Limiting
 * SEC-C: Input Sanitization
 * SEC-D: Secret Masking / No Leak
 * SEC-E: FTS5 Query Sanitization
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── SEC-A: Payload Validators ───
// webhook.js는 Express + DB 의존성이 깊어 단위 추출이 어렵기 때문에,
// 동일 로직을 인라인으로 테스트합니다. (모듈 추출 시 그대로 이관 가능)

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

function sanitizeString(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maxLen);
}

function checkWebhookRate(ip, rateMap, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const cutoff = now - windowMs;
  let timestamps = rateMap.get(ip) || [];
  timestamps = timestamps.filter(t => t > cutoff);
  timestamps.push(now);
  rateMap.set(ip, timestamps);
  return timestamps.length <= limit;
}

// ─── SEC-A: PR Payload Validation ───

describe('SEC-A: validatePRPayload', () => {
  const validPR = {
    action: 'opened',
    pull_request: { number: 42, title: 'feat: add auth', user: { login: 'drake' } },
    repository: { full_name: 'org/repo' },
  };

  it('should accept valid PR payload', () => {
    assert.strictEqual(validatePRPayload(validPR), null);
  });

  it('should reject null payload', () => {
    assert.ok(validatePRPayload(null) !== null);
  });

  it('should reject missing action', () => {
    const p = { ...validPR, action: undefined };
    assert.ok(validatePRPayload(p) !== null);
  });

  it('should reject non-string action', () => {
    const p = { ...validPR, action: 123 };
    assert.ok(validatePRPayload(p) !== null);
  });

  it('should reject missing pull_request', () => {
    const p = { ...validPR, pull_request: undefined };
    assert.ok(validatePRPayload(p) !== null);
  });

  it('should reject missing repository', () => {
    const p = { ...validPR, repository: undefined };
    assert.ok(validatePRPayload(p) !== null);
  });

  it('should reject missing pull_request.user.login', () => {
    const p = { ...validPR, pull_request: { ...validPR.pull_request, user: {} } };
    assert.ok(validatePRPayload(p) !== null);
  });

  it('should reject non-number pr.number', () => {
    const p = { ...validPR, pull_request: { ...validPR.pull_request, number: '42' } };
    assert.ok(validatePRPayload(p) !== null);
  });

  it('should reject non-string pr.title', () => {
    const p = { ...validPR, pull_request: { ...validPR.pull_request, title: 42 } };
    assert.ok(validatePRPayload(p) !== null);
  });
});

// ─── SEC-A: Push Payload Validation ───

describe('SEC-A: validatePushPayload', () => {
  it('should accept valid push payload', () => {
    assert.strictEqual(validatePushPayload({ repository: { full_name: 'org/repo' } }), null);
  });

  it('should reject null payload', () => {
    assert.ok(validatePushPayload(null) !== null);
  });

  it('should reject missing repository', () => {
    assert.ok(validatePushPayload({}) !== null);
  });

  it('should reject non-string full_name', () => {
    assert.ok(validatePushPayload({ repository: { full_name: 123 } }) !== null);
  });
});

// ─── SEC-B: Rate Limiter ───

describe('SEC-B: Webhook Rate Limiter', () => {
  it('should allow requests under limit', () => {
    const map = new Map();
    for (let i = 0; i < 30; i++) {
      assert.strictEqual(checkWebhookRate('1.2.3.4', map, 30), true);
    }
  });

  it('should block requests over limit', () => {
    const map = new Map();
    for (let i = 0; i < 30; i++) checkWebhookRate('1.2.3.4', map, 30);
    assert.strictEqual(checkWebhookRate('1.2.3.4', map, 30), false);
  });

  it('should track IPs independently', () => {
    const map = new Map();
    for (let i = 0; i < 30; i++) checkWebhookRate('1.1.1.1', map, 30);
    // 1.1.1.1 is full, but 2.2.2.2 should be fine
    assert.strictEqual(checkWebhookRate('2.2.2.2', map, 30), true);
    assert.strictEqual(checkWebhookRate('1.1.1.1', map, 30), false);
  });
});

// ─── SEC-C: Input Sanitization ───

describe('SEC-C: sanitizeString', () => {
  it('should return empty for null/undefined/non-string', () => {
    assert.strictEqual(sanitizeString(null), '');
    assert.strictEqual(sanitizeString(undefined), '');
    assert.strictEqual(sanitizeString(42), '');
  });

  it('should truncate to maxLen', () => {
    const long = 'a'.repeat(1000);
    assert.strictEqual(sanitizeString(long, 100).length, 100);
  });

  it('should strip control characters (null byte, backspace, etc.)', () => {
    const dirty = 'hello\x00world\x08\x0Btest\x1F';
    assert.strictEqual(sanitizeString(dirty), 'helloworldtest');
  });

  it('should preserve normal whitespace (\\n, \\r, \\t, space)', () => {
    const clean = 'hello\n\r\tworld';
    assert.strictEqual(sanitizeString(clean), 'hello\n\r\tworld');
  });

  it('should handle Korean text correctly', () => {
    const kr = '이것은 한국어 테스트입니다';
    assert.strictEqual(sanitizeString(kr), kr);
  });

  it('should handle empty string', () => {
    assert.strictEqual(sanitizeString(''), '');
  });
});

// ─── SEC-D: Secret Masking — config.js never logs secret values ───

describe('SEC-D: Config Secret Safety', () => {
  const fs = require('fs');
  const path = require('path');

  it('config.js should not contain console.log with token/key/secret values', () => {
    const configSrc = fs.readFileSync(path.resolve(__dirname, '../src/config.js'), 'utf-8');
    // 정규식: console.log 호출에서 apiKey, botToken, appToken, secret 의 "값"을 출력하는지 검사
    // 허용: errors.push('ANTHROPIC_API_KEY') — 문자열 리터럴 이름만 참조
    // 금지: console.log(config.anthropic.apiKey) — 실제 값 참조

    const logStatements = configSrc.match(/console\.(log|warn|error)\([^)]+\)/g) || [];
    const secretPatterns = /\.(apiKey|botToken|appToken|webhookSecret|password|credential)/;
    const leaks = logStatements.filter(stmt => secretPatterns.test(stmt));
    assert.strictEqual(leaks.length, 0, `Secret values in log statements: ${leaks.join(', ')}`);
  });

  it('anthropic.js should not log API key', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/shared/anthropic.js'), 'utf-8');
    assert.ok(!src.includes('console.log'), 'anthropic.js should have no console.log');
  });
});

// ─── SEC-E: FTS5 Query Sanitization ───

describe('SEC-E: FTS5 Query Sanitization', () => {
  const { sanitizeFtsQuery } = require('../src/shared/fts-sanitizer');

  it('should quote-escape FTS5 reserved operators so they are treated as literals', () => {
    const result = sanitizeFtsQuery('NOT test AND hello OR world NEAR something');
    assert.ok(result.words.length > 0);
    // 각 단어가 큰따옴표로 감싸져야 함 → FTS5 연산자가 아닌 리터럴로 처리
    for (const w of result.words) {
      assert.ok(result.query.includes(`"${w}"`), `word "${w}" should be quoted in query`);
    }
    // 쿼리 내 OR은 sanitizer가 삽입한 구분자 OR만 존재 (따옴표 밖)
    // 핵심: unquoted NOT, AND, NEAR가 없어야 함
    const unquoted = result.query.replace(/"[^"]*"/g, '');
    assert.ok(!unquoted.includes('NOT'), 'unquoted NOT should not exist');
    assert.ok(!unquoted.includes('AND'), 'unquoted AND should not exist');
    assert.ok(!unquoted.includes('NEAR'), 'unquoted NEAR should not exist');
  });

  it('should handle empty/whitespace-only input', () => {
    const result = sanitizeFtsQuery('   ');
    assert.strictEqual(result.words.length, 0);
  });

  it('should handle special characters', () => {
    const result = sanitizeFtsQuery('hello* "quoted phrase" column:value');
    // should not throw
    assert.ok(typeof result.query === 'string');
  });

  it('should return safe query for normal Korean text', () => {
    const result = sanitizeFtsQuery('프로젝트 배포 가이드');
    assert.ok(result.words.length >= 2);
    assert.ok(result.query.length > 0);
  });
});

// ─── SEC: Parameterized Query Check (static analysis) ───

describe('SEC: No raw string concatenation in SQL', () => {
  const fs = require('fs');
  const path = require('path');

  it('sqlite.js should use only parameterized queries (no template literals in exec/run/get/all)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/db/sqlite.js'), 'utf-8');
    // 허용: db.exec() with static SQL (CREATE TABLE, etc.) — 사용자 입력 없음
    // 검사: .prepare() 호출에서 ${} 템플릿 리터럴 사용 여부
    const prepareWithTemplate = src.match(/\.prepare\s*\(\s*`[^`]*\$\{/g);
    assert.strictEqual(prepareWithTemplate, null, 'Found .prepare() with template literal interpolation');
  });

  it('webhook.js should use only parameterized queries', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/github/webhook.js'), 'utf-8');
    const prepareWithTemplate = src.match(/\.prepare\s*\(\s*`[^`]*\$\{/g);
    assert.strictEqual(prepareWithTemplate, null, 'Found .prepare() with template literal interpolation');
  });
});
