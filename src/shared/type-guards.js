/**
 * type-guards.js — 런타임 타입 가드 유틸리티.
 * TypeScript 없이 안전한 타입 검증 제공.
 */

// ===== Basic Type Guards =====

function isString(v) {
  return typeof v === 'string';
}

function isNumber(v) {
  return typeof v === 'number' && !Number.isNaN(v);
}

function isBoolean(v) {
  return typeof v === 'boolean';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isArray(v) {
  return Array.isArray(v);
}

function isFunction(v) {
  return typeof v === 'function';
}

function isNonEmptyString(v) {
  return isString(v) && v.length > 0;
}

function isPositiveNumber(v) {
  return isNumber(v) && v > 0;
}

function isNonNegativeNumber(v) {
  return isNumber(v) && v >= 0;
}

// ===== Domain-Specific Type Guards =====

function isToolResult(v) {
  return isObject(v) && 'success' in v && 'output' in v;
}

function isMemoryEvent(v) {
  return (
    isObject(v) &&
    'type' in v &&
    'content' in v &&
    ['episodic', 'semantic', 'procedural', 'working'].includes(v.type)
  );
}

function isErrorResponse(v) {
  return isObject(v) && 'error' in v && (v.success === false || v.ok === false);
}

function isLLMResponse(v) {
  return isObject(v) && ('content' in v || 'choices' in v);
}

function isAnthropicResponse(v) {
  return isLLMResponse(v) && 'content' in v && isArray(v.content);
}

function isOpenAIResponse(v) {
  return isLLMResponse(v) && 'choices' in v && isArray(v.choices);
}

function isToolCall(v) {
  return isObject(v) && isString(v.name) && 'input' in v;
}

function isAgentRequest(v) {
  return isObject(v) && isNonEmptyString(v.agentId) && isNonEmptyString(v.content);
}

// ===== Assertion Functions =====

function assertString(v, name = 'value') {
  if (!isString(v)) {
    throw new TypeError(`${name} must be a string, got ${typeof v}`);
  }
  return v;
}

function assertNumber(v, name = 'value') {
  if (!isNumber(v)) {
    throw new TypeError(`${name} must be a number, got ${typeof v}`);
  }
  return v;
}

function assertObject(v, name = 'value') {
  if (!isObject(v)) {
    throw new TypeError(`${name} must be an object`);
  }
  return v;
}

function assertArray(v, name = 'value') {
  if (!isArray(v)) {
    throw new TypeError(`${name} must be an array`);
  }
  return v;
}

function assertNonEmptyString(v, name = 'value') {
  if (!isNonEmptyString(v)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return v;
}

module.exports = {
  isString,
  isNumber,
  isBoolean,
  isObject,
  isArray,
  isFunction,
  isNonEmptyString,
  isPositiveNumber,
  isNonNegativeNumber,
  isToolResult,
  isMemoryEvent,
  isErrorResponse,
  isLLMResponse,
  isAnthropicResponse,
  isOpenAIResponse,
  isToolCall,
  isAgentRequest,
  assertString,
  assertNumber,
  assertObject,
  assertArray,
  assertNonEmptyString,
};
