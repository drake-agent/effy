/**
 * Generic HTTP status code based error classifier.
 * Fallback for unknown providers or when provider-specific classifier is unavailable.
 */

function classifyGeneric(error) {
  let status = error.status || error.code || 500;
  let message = error.message || '';

  // Convert numeric status to number
  if (typeof status === 'string') {
    status = parseInt(status, 10) || 500;
  }

  // Rate limit (429)
  if (status === 429 || message.includes('rate')) {
    return {
      category: 'rate_limit',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 1000,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Rate limited',
    };
  }

  // Quota exceeded
  if (status === 429 || message.includes('quota')) {
    return {
      category: 'quota_exceeded',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 1000,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Quota exceeded',
    };
  }

  // Invalid request (400)
  if (status === 400 || message.includes('invalid')) {
    return {
      category: 'invalid_request',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Invalid request',
    };
  }

  // Authentication (401, 403)
  if (
    status === 401 ||
    status === 403 ||
    message.includes('auth') ||
    message.includes('permission')
  ) {
    return {
      category: 'auth',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Authentication or permission error',
    };
  }

  // Not found (404)
  if (status === 404 || message.includes('not found')) {
    return {
      category: 'model_unavailable',
      retriable: false,
      fallbackAllowed: true,
      suggestedBackoffMs: 0,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Not found',
    };
  }

  // Request entity too large (413)
  if (status === 413 || message.includes('too large')) {
    return {
      category: 'context_overflow',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Request entity too large',
    };
  }

  // Timeout
  if (message.includes('timeout') || message.includes('timed out')) {
    return {
      category: 'timeout',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'generic',
      originalCode: 'TIMEOUT',
      message: 'Request timed out',
    };
  }

  // Server errors (5xx)
  if (status >= 500) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'generic',
      originalCode: `HTTP ${status}`,
      message: 'Server error',
    };
  }

  // Unknown
  return {
    category: 'unknown',
    retriable: false,
    fallbackAllowed: false,
    suggestedBackoffMs: 0,
    provider: 'generic',
    originalCode: `HTTP ${status}`,
    message: 'Unknown error',
  };
}

module.exports = classifyGeneric;
