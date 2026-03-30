/**
 * fts-sanitizer.js — FTS5 쿼리 안전 처리 유틸.
 *
 * 공통 사용: runtime.js (search_knowledge), context.js (searchSemantic).
 * B-3: FTS5 예약어(NOT, AND, OR, NEAR) 충돌 방지 — 큰따옴표 이스케이프.
 */

const FTS5_RESERVED = /^(AND|OR|NOT|NEAR|MATCH)$/i;

/**
 * 텍스트를 FTS5 안전 쿼리로 변환.
 *
 * 1. 특수문자 제거 (한글/영문/숫자/공백만 유지)
 * 2. 1자 이하 단어 제거
 * 3. FTS5 예약어 필터링
 * 4. 각 단어를 큰따옴표로 감싸서 OR 연결
 *
 * @param {string} text - 원본 쿼리 텍스트
 * @returns {{ words: string[], query: string }} words가 비어있으면 query도 빈 문자열
 */
function sanitizeFtsQuery(text) {
  if (!text || typeof text !== 'string') return { words: [], query: '' };
  const raw = text.replace(/[^\w\uAC00-\uD7AF\s]/g, '');
  const words = raw.split(/\s+/).filter(w => w.length > 1 && !FTS5_RESERVED.test(w));
  if (words.length === 0) return { words: [], query: '' };
  const query = words.map(w => `"${w}"`).join(' OR ');
  return { words, query };
}

module.exports = { sanitizeFtsQuery };
