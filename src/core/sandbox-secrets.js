/**
 * sandbox-secrets.js — Sandbox secret manager for safe secret injection.
 *
 * Manages secrets securely for use in sandbox environments.
 * Tracks access with audit logging.
 */
const { EventEmitter } = require('events');
const { createLogger } = require('../shared/logger');

const log = createLogger('core:sandbox-secrets');

class SandboxSecretManager extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {number} [opts.maxLogEntries=1000] - Maximum access log entries
   */
  constructor(opts = {}) {
    super();
    this._secrets = new Map(); // name -> { value, metadata, registeredAt }
    this._accessLog = []; // { action, name, agentId, timestamp, success }
    this.maxLogEntries = opts.maxLogEntries ?? 1000;

    log.info('SandboxSecretManager initialized', {
      maxLogEntries: this.maxLogEntries,
    });
  }

  /**
   * Register a secret with metadata
   * @param {string} name - Secret name (must be validated)
   * @param {string} value - Secret value
   * @param {Object} [metadata={}] - Metadata about the secret
   * @param {string} [metadata.description] - Human-readable description
   * @param {string} [metadata.scope] - Scope/purpose of secret
   * @param {number} [metadata.expiresAt] - Expiration timestamp
   */
  registerSecret(name, value, metadata = {}) {
    try {
      // Validate secret name
      if (!SandboxSecretManager.validateSecretName(name)) {
        log.warn('Invalid secret name', { name });
        return false;
      }

      if (!value || typeof value !== 'string') {
        log.warn('Invalid secret value', { name });
        return false;
      }

      this._secrets.set(name, {
        value,
        metadata: {
          description: metadata.description || '',
          scope: metadata.scope || 'default',
          expiresAt: metadata.expiresAt || null,
        },
        registeredAt: Date.now(),
      });

      // Log registration (without value)
      this._logAccess({
        action: 'register',
        name,
        agentId: null,
        success: true,
      });

      log.info('Secret registered', {
        name,
        scope: metadata.scope,
        hasExpiry: !!metadata.expiresAt,
      });

      return true;
    } catch (err) {
      log.error('Error registering secret', { error: err.message, name });
      return false;
    }
  }

  /**
   * Remove a secret
   * @param {string} name - Secret name
   * @returns {boolean} Success
   */
  removeSecret(name) {
    try {
      if (!this._secrets.has(name)) {
        log.warn('Secret not found for removal', { name });
        return false;
      }

      this._secrets.delete(name);

      this._logAccess({
        action: 'remove',
        name,
        agentId: null,
        success: true,
      });

      log.info('Secret removed', { name });
      return true;
    } catch (err) {
      log.error('Error removing secret', { error: err.message, name });
      return false;
    }
  }

  /**
   * Request a secret with audit logging
   * @param {string} name - Secret name
   * @param {Object} [context={}] - Access context
   * @param {string} [context.agentId] - Requesting agent ID
   * @param {string} [context.turnId] - Turn identifier
   * @param {string} [context.reason] - Access reason
   * @returns {string|null} Secret value or null if not found/authorized
   */
  requestSecret(name, context = {}) {
    try {
      const { agentId, reason } = context;

      // Check if secret exists
      if (!this._secrets.has(name)) {
        this._logAccess({
          action: 'request',
          name,
          agentId: agentId || null,
          success: false,
        });
        log.warn('Secret not found', { name, agentId });
        return null;
      }

      const secretData = this._secrets.get(name);

      // M-02: ACL check — if allowedAgents is configured for this secret, enforce it
      const allowedAgents = secretData.metadata.allowedAgents;
      if (allowedAgents && allowedAgents.length > 0) {
        if (!agentId || !allowedAgents.includes(agentId)) {
          this._logAccess({
            action: 'request',
            name,
            agentId: agentId || null,
            success: false,
          });
          log.warn('Secret access denied — agent not in allowedAgents', { name, agentId, allowedAgents });
          return null;
        }
      }

      // Check expiration
      if (secretData.metadata.expiresAt && Date.now() > secretData.metadata.expiresAt) {
        this._logAccess({
          action: 'request',
          name,
          agentId: agentId || null,
          success: false,
        });
        log.warn('Secret expired', { name, agentId });
        return null;
      }

      // Log access
      this._logAccess({
        action: 'request',
        name,
        agentId: agentId || null,
        success: true,
      });

      // Emit event for monitoring
      this.emit('secret:accessed', {
        name,
        agentId: agentId || null,
        reason: reason || 'unknown',
        timestamp: Date.now(),
      });

      return secretData.value;
    } catch (err) {
      log.error('Error requesting secret', { error: err.message, name });
      return null;
    }
  }

  /**
   * Log access event (internal)
   * @private
   */
  _logAccess(entry) {
    try {
      const logEntry = {
        ...entry,
        timestamp: Date.now(),
      };

      this._accessLog.push(logEntry);

      // Trim log if exceeds max
      if (this._accessLog.length > this.maxLogEntries) {
        this._accessLog = this._accessLog.slice(-this.maxLogEntries);
      }
    } catch (err) {
      log.error('Error logging access', { error: err.message });
    }
  }

  /**
   * Get filtered access log (no secret values)
   * @param {Object} [filter={}] - Filter options
   * @param {string} [filter.name] - Filter by secret name
   * @param {string} [filter.agentId] - Filter by agent ID
   * @param {number} [filter.since] - Filter by timestamp (milliseconds since epoch)
   * @param {string} [filter.action] - Filter by action
   * @returns {Array<Object>} Filtered access log entries
   */
  getAccessLog(filter = {}) {
    try {
      let log = this._accessLog;

      if (filter.name) {
        log = log.filter(entry => entry.name === filter.name);
      }

      if (filter.agentId) {
        log = log.filter(entry => entry.agentId === filter.agentId);
      }

      if (filter.since) {
        log = log.filter(entry => entry.timestamp >= filter.since);
      }

      if (filter.action) {
        log = log.filter(entry => entry.action === filter.action);
      }

      return log;
    } catch (err) {
      log.error('Error getting access log', { error: err.message });
      return [];
    }
  }

  /**
   * Get list of registered secrets (metadata only, no values)
   * @returns {Array<Object>} Array of secret metadata
   */
  getRegisteredSecrets() {
    try {
      const secrets = [];

      for (const [name, data] of this._secrets.entries()) {
        secrets.push({
          name,
          description: data.metadata.description,
          scope: data.metadata.scope,
          expiresAt: data.metadata.expiresAt,
          registeredAt: data.registeredAt,
        });
      }

      return secrets;
    } catch (err) {
      log.error('Error getting registered secrets', { error: err.message });
      return [];
    }
  }

  /**
   * Create a safe getter function for sandbox VM context
   * Returns a function that can be called from within the sandbox
   * @param {string} agentId - Requesting agent ID
   * @returns {Function} (name) => value | null
   */
  createSecretGetter(agentId) {
    return (name) => this.requestSecret(name, { agentId, reason: 'sandbox-exec' });
  }

  /**
   * Validate secret name format
   * Must be alphanumeric + underscore, 1-64 characters
   * @static
   * @param {string} name
   * @returns {boolean}
   */
  static validateSecretName(name) {
    if (!name || typeof name !== 'string') {
      return false;
    }

    if (name.length < 1 || name.length > 64) {
      return false;
    }

    // Allow alphanumeric, underscore, hyphen, dot
    return /^[a-zA-Z0-9_\-\.]+$/.test(name);
  }
}

module.exports = { SandboxSecretManager };
