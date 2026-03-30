/**
 * Anthropic error classification.
 * Parses error.type, error.error?.type, HTTP status codes.
 *
 * Known error types:
 * - overloaded_error (529) → rate_limit, retriable
 * - rate_limit_error (429) → rate_limit, retriable
 * - request_too_large (413) → context_overflow, not retriable
 * - authentication_error (401) → auth, not retriable
 * - permission_error (403) → auth, not retriable
 * - not_found_error (404) → model_unavailable, fallback allowed
 * - invalid_request_error (400) → invalid_request, not retriable
 * - api_error (500) → network, retriable
 */

function classifyAnthropic(error) {
  let errorType = error.type || error.error?.type || '';
  let status = error.status || 500;

  // Extract error code from various locations
  if (error.error && typeof error.error === 'object') {
    errorType = error.error.type || errorType;
    status = error.status || status;
  }

  // Rate limit errors
  if (
    errorType === 'rate_limit_error' ||
    errorType === 'overloaded_error' ||
    status === 429 ||
    status === 529
  ) {
    return {
      category: 'rate_limit',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 1000,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Rate limited by Anthropic API',
    };
  }

  // Context overflow
  if (
    errorType === 'request_too_large' ||
    status === 413 ||
    (error.message && error.message.includes('context'))
  ) {
    return {
      category: 'context_overflow',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Request exceeds context window',
    };
  }

  // Authentication errors
  if (
    errorType === 'authentication_error' ||
    errorType === 'invalid_api_key' ||
    status === 401
  ) {
    return {
      category: 'auth',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Authentication failed',
    };
  }

  // Permission errors
  if (errorType === 'permission_error' || status === 403) {
    return {
      category: 'auth',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Permission denied',
    };
  }

  // Model not found
  if (errorType === 'not_found_error' || status === 404) {
    return {
      category: 'model_unavailable',
      retriable: false,
      fallbackAllowed: true,
      suggestedBackoffMs: 0,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Model not found',
    };
  }

  // Invalid request
  if (errorType === 'invalid_request_error' || status === 400) {
    return {
      category: 'invalid_request',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Invalid request',
    };
  }

  // Server/network errors
  if (errorType === 'api_error' || status >= 500) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'anthropic',
      originalCode: errorType || `HTTP ${status}`,
      message: 'Server error',
    };
  }

  // Timeout
  if (
    errorType === 'timeout' ||
    (error.message && error.message.includes('timeout'))
  ) {
    return {
      category: 'timeout',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'anthropic',
      originalCode: errorType || 'TIMEOUT',
      message: 'Request timed out',
    };
  }

  // Unknown
  return {
    category: 'unknown',
    retriable: false,
    fallbackAllowed: false,
    suggestedBackoffMs: 0,
    provider: 'anthropic',
    originalCode: errorType || `HTTP ${status}`,
    message: 'Unknown error',
  };
}

module.exports = classifyAnthropic;
