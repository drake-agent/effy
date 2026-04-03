/**
 * OpenAI error classification.
 * Parses error.code, error.type, HTTP status.
 *
 * Known patterns:
 * - rate_limit_exceeded (429) → rate_limit, retriable
 * - context_length_exceeded → context_overflow, not retriable
 * - invalid_api_key (401) → auth, not retriable
 * - model_not_found → model_unavailable, fallback
 * - server_error (500/502/503) → network, retriable
 * - timeout → timeout, retriable
 */

function classifyOpenAI(error) {
  let code = error.code || '';
  let status = error.status || 500;
  let type = error.type || '';
  let message = error.message || '';

  // Rate limit
  if (
    code === 'rate_limit_exceeded' ||
    type === 'rate_limit_error' ||
    status === 429 ||
    message.includes('rate limit')
  ) {
    return {
      category: 'rate_limit',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 1000,
      provider: 'openai',
      originalCode: code || `HTTP ${status}`,
      message: 'Rate limited by OpenAI API',
    };
  }

  // Context length exceeded
  if (
    code === 'context_length_exceeded' ||
    (type === 'invalid_request_error' && (message.includes('context') || message.includes('token'))) ||
    message.includes('context_length')
  ) {
    return {
      category: 'context_overflow',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'openai',
      originalCode: code || 'context_length_exceeded',
      message: 'Request exceeds context window',
    };
  }

  // Authentication errors
  if (
    code === 'invalid_api_key' ||
    code === 'invalid_request_error' ||
    status === 401 ||
    message.includes('api_key') ||
    message.includes('authentication')
  ) {
    return {
      category: 'auth',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'openai',
      originalCode: code || `HTTP ${status}`,
      message: 'Authentication failed',
    };
  }

  // Model not found
  if (
    code === 'model_not_found' ||
    message.includes('model') ||
    message.includes('not found')
  ) {
    return {
      category: 'model_unavailable',
      retriable: false,
      fallbackAllowed: true,
      suggestedBackoffMs: 0,
      provider: 'openai',
      originalCode: code || 'model_not_found',
      message: 'Model not found or unavailable',
    };
  }

  // Invalid request
  if (
    type === 'invalid_request_error' ||
    status === 400 ||
    (message.includes('invalid') && !message.includes('api_key'))
  ) {
    return {
      category: 'invalid_request',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: 'openai',
      originalCode: code || `HTTP ${status}`,
      message: 'Invalid request',
    };
  }

  // Timeout
  if (
    code === 'timeout' ||
    type === 'timeout' ||
    message.includes('timeout') ||
    message.includes('timed out')
  ) {
    return {
      category: 'timeout',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'openai',
      originalCode: code || 'timeout',
      message: 'Request timed out',
    };
  }

  // Server errors (502/503)
  if (
    status === 502 ||
    status === 503 ||
    code === 'server_error' ||
    message.includes('server') ||
    message.includes('unavailable')
  ) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'openai',
      originalCode: code || `HTTP ${status}`,
      message: 'Server error or unavailable',
    };
  }

  // General server error
  if (status >= 500) {
    return {
      category: 'network',
      retriable: true,
      fallbackAllowed: false,
      suggestedBackoffMs: 500,
      provider: 'openai',
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
    provider: 'openai',
    originalCode: code || `HTTP ${status}`,
    message: 'Unknown error',
  };
}

module.exports = classifyOpenAI;
