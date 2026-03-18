/**
 * knowledge/index.js — Context Hub 통합 검색 Facade.
 *
 * Effy의 search_knowledge (팀 지식) + search_api_docs (API 문서)를
 * 단일 인터페이스로 통합.
 */
const { getChubAdapter } = require('./chub-adapter');

module.exports = { getChubAdapter };
