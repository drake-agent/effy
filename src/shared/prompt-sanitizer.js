/**
 * prompt-sanitizer.js — Sanitize untrusted content before injection into system prompts.
 *
 * LLM-2 방어: 메모리/외부 데이터에서 온 콘텐츠가 시스템 프롬프트의 XML 태그 경계를
 * 탈출하지 못하도록 `</` 시퀀스를 이스케이프.
 *
 * 예: "</system>" → "<\/system>", "</user_profile>" → "<\/user_profile>"
 */

/**
 * Escape closing XML-like tags in untrusted content to prevent prompt boundary escape.
 * Replaces `</` with `<\/` so the content cannot close surrounding XML delimiters.
 *
 * @param {string} text - Untrusted content (memory, MCP response, etc.)
 * @returns {string} Sanitized text safe for prompt injection
 */
function sanitizeForPrompt(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(/<\//g, '<\\/');
}

module.exports = { sanitizeForPrompt };
