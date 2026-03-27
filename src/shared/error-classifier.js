const { createLogger } = require('./logger');
const log = createLogger('shared:error-classifier');

/**
 * @typedef {Object} ErrorClassification
 * @property {'rate_limit'|'context_overflow'|'auth'|'invalid_request'|'model_unavailable'|'quota_exceeded'|'network'|'timeout'|'unknown'} category
 * @property {boolean} retriable
 * @property {boolean} fallbackAllowed
 * @property {number} suggestedBackoffMs - 0 if not retriable
 * @property {string} provider - which provider produced the error
 * @property {string} [originalCode] - original error code from provider
 * @property {string} [message] - human-readable summary
 */

class ErrorClassifier {
  constructor() {
    this._classifiers = new Map(); // provider -> classifyFn
    this._registerDefaults();
  }

  _registerDefaults() {
    // Register built-in classifiers
    try {
      this._classifiers.set(
        'anthropic',
        require('./error-classifiers/anthropic')
      );
    } catch (e) {
      log.warn('Failed to load anthropic classifier', { error: e.message });
    }

    try {
      this._classifiers.set('openai', require('./error-classifiers/openai'));
    } catch (e) {
      log.warn('Failed to load openai classifier', { error: e.message });
    }

    try {
      this._classifiers.set('google', require('./error-classifiers/google'));
    } catch (e) {
      log.warn('Failed to load google classifier', { error: e.message });
    }

    try {
      this._classifiers.set('generic', require('./error-classifiers/generic'));
    } catch (e) {
      log.warn('Failed to load generic classifier', { error: e.message });
    }
  }

  /**
   * Register a custom error classifier for a provider.
   * @param {string} provider - Provider name
   * @param {Function} classifyFn - Function that takes error and returns ErrorClassification
   */
  registerClassifier(provider, classifyFn) {
    if (typeof classifyFn !== 'function') {
      throw new TypeError('classifyFn must be a function');
    }
    this._classifiers.set(provider, classifyFn);
    log.debug(`Registered classifier for provider: ${provider}`);
  }

  /**
   * Classify an error from a specific provider.
   * @param {string} provider - Provider name (anthropic, openai, google, etc)
   * @param {Error|Object} error - The error to classify
   * @returns {ErrorClassification}
   */
  classify(provider, error) {
    if (!error) {
      return {
        category: 'unknown',
        retriable: false,
        fallbackAllowed: false,
        suggestedBackoffMs: 0,
        provider: provider || 'unknown',
        originalCode: 'NULL_ERROR',
        message: 'Null error object',
      };
    }

    // Try provider-specific classifier first
    const classifyFn = this._classifiers.get(provider);
    if (classifyFn) {
      try {
        const classification = classifyFn(error);
        return classification;
      } catch (e) {
        log.warn(`Classifier for ${provider} threw error`, {
          error: e.message,
        });
      }
    }

    // Fallback to generic classifier
    const genericClassify = this._classifiers.get('generic');
    if (genericClassify) {
      try {
        return genericClassify(error);
      } catch (e) {
        log.warn('Generic classifier failed', { error: e.message });
      }
    }

    // Ultimate fallback
    return {
      category: 'unknown',
      retriable: false,
      fallbackAllowed: false,
      suggestedBackoffMs: 0,
      provider: provider || 'unknown',
      originalCode: error.code || 'UNKNOWN',
      message: error.message || 'Unknown error',
    };
  }

  /**
   * Check if an error classification indicates the operation should be retried.
   * @param {ErrorClassification} classification
   * @returns {boolean}
   */
  shouldRetry(classification) {
    return !!classification.retriable;
  }

  /**
   * Check if an error classification allows fallback to another provider.
   * @param {ErrorClassification} classification
   * @returns {boolean}
   */
  shouldFallback(classification) {
    return !!classification.fallbackAllowed;
  }

  /**
   * Compute exponential backoff with jitter.
   * Base: 100ms, multiplier: 2, jitter: ±10%, max: 30000ms
   * Rate limit starts at 1000ms, network at 500ms.
   * @param {number} attempts - Number of attempts so far (0-based)
   * @param {ErrorClassification} classification
   * @returns {number} Backoff time in milliseconds
   */
  computeBackoff(attempts, classification) {
    if (!classification.retriable) {
      return 0;
    }

    // Determine base backoff by category
    let baseMs = 100;
    if (classification.category === 'rate_limit') {
      baseMs = 1000;
    } else if (classification.category === 'network') {
      baseMs = 500;
    } else if (classification.category === 'timeout') {
      baseMs = 500;
    }

    // Exponential backoff: base * (2 ^ attempts)
    const backoffMs = baseMs * Math.pow(2, attempts);

    // Add jitter: ±10%
    const jitter = backoffMs * 0.1;
    const minJitter = backoffMs - jitter;
    const maxJitter = backoffMs + jitter;
    const withJitter =
      minJitter + Math.random() * (maxJitter - minJitter);

    // Cap at 30 seconds
    return Math.min(withJitter, 30000);
  }

  /**
   * Get maximum number of retries for an error classification.
   * @param {ErrorClassification} classification
   * @returns {number}
   */
  maxRetries(classification) {
    switch (classification.category) {
      case 'rate_limit':
        return 5;
      case 'network':
        return 3;
      case 'timeout':
        return 2;
      case 'context_overflow':
        return 0;
      case 'auth':
        return 0;
      case 'invalid_request':
        return 0;
      case 'model_unavailable':
        return 0;
      case 'quota_exceeded':
        return 5;
      case 'unknown':
      default:
        return 0;
    }
  }
}

// Singleton instance
let _instance = null;

/**
 * Get or create the ErrorClassifier singleton.
 * @returns {ErrorClassifier}
 */
function getErrorClassifier() {
  if (!_instance) {
    _instance = new ErrorClassifier();
  }
  return _instance;
}

module.exports = {
  ErrorClassifier,
  getErrorClassifier,
};
