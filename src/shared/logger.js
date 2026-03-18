/**
 * logger.js — Structured Logger (v4 Port).
 *
 * 각 로그에 타임스탬프, 레벨, 컴포넌트 태그 포함.
 * 형식: [2024-01-01T00:00:00Z] [INFO ] [gateway] message {meta}
 *
 * 환경변수 LOG_LEVEL로 레벨 제어 (debug|info|warn|error).
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// LO-1: 런타임 레벨 변경 지원 — setLevel()로 동적 조정 가능
let currentLevel = LOG_LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LOG_LEVELS.info;

/**
 * 로그 포매팅.
 * @param {string} level
 * @param {string} component
 * @param {string|object} message
 * @param {object} meta
 * @returns {string}
 */
function formatLog(level, component, message, meta = {}) {
  const timestamp = new Date().toISOString();
  const levelStr = level.padEnd(5);
  const componentStr = component ? `[${component}]` : '';

  let msgStr;
  if (typeof message === 'object') {
    msgStr = JSON.stringify(message);
  } else {
    msgStr = message;
  }

  let result = `[${timestamp}] [${levelStr}] ${componentStr} ${msgStr}`;

  if (Object.keys(meta).length > 0) {
    result += ` ${JSON.stringify(meta)}`;
  }

  return result;
}

/**
 * 로거 인스턴스 생성.
 * @param {string} component - 컴포넌트 이름 (e.g., 'gateway', 'memory:graph')
 * @returns {object} { debug, info, warn, error }
 */
function createLogger(component) {
  return {
    debug(message, meta = {}) {
      if (currentLevel <= LOG_LEVELS.debug) {
        console.debug(formatLog('DEBUG', component, message, meta));
      }
    },
    info(message, meta = {}) {
      if (currentLevel <= LOG_LEVELS.info) {
        console.log(formatLog('INFO', component, message, meta));
      }
    },
    warn(message, meta = {}) {
      if (currentLevel <= LOG_LEVELS.warn) {
        console.warn(formatLog('WARN', component, message, meta));
      }
    },
    error(message, meta = {}) {
      if (currentLevel <= LOG_LEVELS.error) {
        console.error(formatLog('ERROR', component, message, meta));
      }
    },
  };
}

/** LO-1: 런타임 로그 레벨 변경. */
function setLevel(level) {
  const normalized = (level || 'info').toLowerCase();
  if (LOG_LEVELS[normalized] !== undefined) {
    currentLevel = LOG_LEVELS[normalized];
  }
}

module.exports = { createLogger, setLevel, LOG_LEVELS };
