/**
 * utils.js — 공유 유틸리티 함수 (v4 Port).
 *
 * contentHash: 메모리 중복 방지용 SHA256 해시
 * estimateTokens: 한글/영문 혼합 토큰 추정
 * trimToBudget: 토큰 예산 내 아이템 자르기
 */
const crypto = require('crypto');

/**
 * 텍스트의 SHA256 해시 첫 32자 반환 (128bit collision resistance).
 * @param {string} text
 * @returns {string}
 */
function contentHash(text) {
  if (!text || typeof text !== 'string') return '';
  // HASH-1 fix: 16→32자 확장 — 128bit collision resistance (birthday bound ~2^64)
  return crypto.createHash('sha256').update(text).digest('hex').substring(0, 32);
}

/**
 * 텍스트의 예상 토큰 수 계산.
 * 한글: 1.5자당 1토큰, 영문: 4자당 1토큰.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;

  let tokenCount = 0;
  // LO-2: 완성형(AC00-D7A3) + 자모(3130-318F, 3200-321E) 포함
  for (const char of text) {
    const code = char.charCodeAt(0);
    if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3130 && code <= 0x318f) || (code >= 0x3200 && code <= 0x321e)) {
      tokenCount += 1 / 1.5;
    } else if (code <= 0x007f) {
      tokenCount += 1 / 4;
    } else {
      tokenCount += 1 / 1.5;
    }
  }
  return Math.ceil(tokenCount);
}

/**
 * 아이템 배열을 토큰 예산에 맞게 자르기.
 * @param {Array} items
 * @param {number} budgetTokens
 * @returns {Array}
 * @reserved Phase 2 context assembly에서 사용 예정
 */
function trimToBudget(items, budgetTokens) {
  if (!Array.isArray(items) || budgetTokens <= 0) return [];
  const result = [];
  let usedTokens = 0;
  for (const item of items) {
    const itemTokens = estimateTokens(item.content || String(item));
    if (usedTokens + itemTokens <= budgetTokens) {
      result.push(item);
      usedTokens += itemTokens;
    } else {
      break;
    }
  }
  return result;
}

/**
 * 비동기 지연.
 * @param {number} ms
 * @returns {Promise}
 * @reserved 재시도 로직/graceful shutdown에서 사용 예정
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 머신의 LAN IPv4 주소 반환. 못 찾으면 'localhost'.
 * @returns {string}
 */
function getLanIp() {
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

module.exports = { contentHash, estimateTokens, trimToBudget, sleep, getLanIp };
