/**
 * Effy v3.7 Tier 1 Modules Index
 * Modules for intelligent agent routing and lifecycle management
 * 각 모듈은 CommonJS 형식으로 require/module.exports 사용
 */

// Core modules — 라우팅 및 제어 계층
const { PromptComplexityScorer } = require('./core/prompt-scorer');
const { FallbackChain } = require('./core/fallback-chain');
const { PermissionGate } = require('./core/permission-gate');
const { ProcessSandbox } = require('./core/sandbox');

// Shared modules — 공유 인프라
const { createLogger } = require('./shared/logger');
const { AuditLogger } = require('./shared/audit-logger');

// Memory modules — 메모리 및 상태 관리
const { MemoryBulletin } = require('./memory/bulletin');

module.exports = {
  // Core
  PromptComplexityScorer,
  FallbackChain,
  PermissionGate,
  ProcessSandbox,

  // Shared
  createLogger,
  AuditLogger,

  // Memory
  MemoryBulletin
};
