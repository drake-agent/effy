/**
 * sanitize.js — Reflection 모듈 공통 새니타이즈 유틸리티.
 *
 * SEC-1~3 수정: LLM 출력 / 사용자 입력이 system prompt에 주입되기 전
 * XML 마커, 프롬프트 인젝션 패턴을 무력화한다.
 *
 * 공통화: engine.js, distiller.js, committee.js 에서 모두 사용.
 */

// ─── XML 속성값 이스케이프 (기존 skills/loader.js의 escapeXmlAttr과 동일) ───
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── 프롬프트 인젝션 패턴 제거 ───
// system/user/assistant 역할 위장, XML 태그 삽입 시도를 무력화
const INJECTION_PATTERNS = [
  /<\/?(?:system|user|assistant|human|claude|prompt|instruction|rule|override|ignore)[^>]*>/gi,
  /\[(?:SYSTEM|INST|SYS)\]/gi,
  /```(?:system|prompt)/gi,
];

function stripInjection(str) {
  let cleaned = String(str);
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, '[filtered]');
  }
  return cleaned;
}

/**
 * LLM 출력 또는 사용자 입력을 system prompt 주입 전에 정화.
 * escapeXml + stripInjection 조합.
 *
 * @param {string} str  - 원문
 * @param {number} maxLen - 최대 길이 (기본 500)
 * @returns {string}
 */
function sanitizeForPrompt(str, maxLen = 500) {
  if (!str || typeof str !== 'string') return '';
  return escapeXml(stripInjection(str.slice(0, maxLen)));
}

/**
 * LLM JSON 출력에서 허용된 필드만 추출.
 * 화이트리스트 기반 스키마 검증.
 *
 * @param {object} obj - 파싱된 JSON
 * @param {object} schema - { field: 'string'|'number'|'array'|'boolean', ... }
 * @param {object} defaults - 기본값
 * @returns {object} - 검증된 객체
 */
function validateSchema(obj, schema, defaults = {}) {
  if (!obj || typeof obj !== 'object') return { ...defaults };
  const result = {};
  for (const [key, expectedType] of Object.entries(schema)) {
    const val = obj[key];
    if (val === undefined || val === null) {
      result[key] = defaults[key] ?? null;
      continue;
    }
    switch (expectedType) {
      case 'string':
        result[key] = typeof val === 'string' ? val : String(val);
        break;
      case 'number':
        result[key] = typeof val === 'number' ? val : Number(val) || defaults[key] || 0;
        break;
      case 'array':
        result[key] = Array.isArray(val) ? val.map(String) : [];
        break;
      case 'boolean':
        result[key] = Boolean(val);
        break;
      default:
        result[key] = defaults[key] ?? null;
    }
  }
  return result;
}

module.exports = { escapeXml, stripInjection, sanitizeForPrompt, validateSchema };
