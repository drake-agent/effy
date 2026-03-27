/**
 * Google Gemini error classification.
 * Parses error.code, error.status, error.details.
 *
 * Known patterns:
 * - RESOURCE_EXHAUSTED (429) → rate_limit
 * - INVALID_ARGUMENT (400) → invalid_request
 * - UNAUTHENTICATED (401) → auth
 * - NOT_FOUND (404) → model_unavailable
 * - INTERNAL (500) → network
 * - UNAVAILABLE (503) → network
 */

function classifyGoogle(error) {
  let code = error.code || '';
  let status = error.status || 500;
  let details = error.details || '';
  let message = error.message || '';

  // Rate limit (RESOURCE_EXHAUSTED)
  if (
    code === 'RESOURCE_EXHAUSTED' ||
    code === '8' ||
    status === 429 ||
    message.includes('rate') ||
    message.includes('quota')
  ) {
    return {
      category: 'rate_limit',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 1000,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Rate limited or quota exceeded',
    };
  }

  // Invalid argument
  if (
    code === 'INVALID_ARGUMENT' ||
    code === '3' ||
    status === 400 ||
    message.includes('invalid')
  ) {
    return {
      category: 'invalid_request',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Invalid request',
    };
  }

  // Authentication errors
  if (
    code === 'UNAUTHENTICATED' ||
    code === '16' ||
    status === 401 ||
    message.includes('auth') ||
    message.includes('credential')
  ) {
    return {
      category: 'auth',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Authentication failed',
    };
  }

  // Not found
  if (
    code === 'NOT_FOUND' ||
    code === '5' ||
    status === 404 ||
    message.includes('not found')
  ) {
    return {
      category: 'model_unavailable',
      retriable: false,
      fallbackAllowed: true,
      suggestedBackoffMs: 0,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Model not found',
    };
  }

  // Internal errors (server error)
  if (
    code === 'INTERNAL' ||
    code === '13' ||
    status === 500 ||
    message.includes('internal')
  ) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Internal server error',
    };
  }

  // Unavailable
  if (
    code === 'UNAVAILABLE' ||
    code === '14' ||
    status === 503 ||
    message.includes('unavailable')
  ) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Service unavailable',
    };
  }

  // Timeout
  if (
    code === 'DEADLINE_EXCEEDED' ||
    code === '4' ||
    message.includes('timeout') ||
    message.includes('deadline')
  ) {
    return {
      category: 'timeout',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'google',
      originalCode: code || 'DEADLINE_EXCEEDED',
      message: 'Request timed out',
    };
  }

  // General server error
  if (status >= 500) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'google',
      originalCode: code || `HTTP ${status}`,
      message: 'Server error',
    };
  }

  // Unknown
  return {
    category: 'unknown',
    retriable: false,
    fallbackAllowed: false,
    suggestedBackoffMs: 0,
    provider: 'google',
    originalCode: code || `HTTP ${status}`,
    message: 'Unknown error',
  };
}

module.exports = classifyGoogle;
