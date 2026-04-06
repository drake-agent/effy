/**
 * vault.js — Encrypted secret management (v4.0 Security).
 *
 * AES-256-GCM 암호화로 비밀 값을 저장.
 * 마스터 키는 VAULT_MASTER_KEY 환경변수 또는 첫 부팅 시 자동 생성.
 *
 * 각 비밀은 ACL (allowedAgents), TTL, 소유자 정보를 가짐.
 * 만료된 비밀은 자동 정리.
 *
 * Export: Vault (singleton)
 */
const crypto = require('crypto');
const { createLogger } = require('../shared/logger');

const log = createLogger('security:vault');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1분

class Vault {
  constructor() {
    this._secrets = new Map();
    this._masterKey = this._deriveMasterKey();
    this._cleanupTimer = null;
    this._startCleanup();
  }

  /**
   * 마스터 키 유도.
   * VAULT_MASTER_KEY 환경변수가 있으면 사용, 없으면 자동 생성.
   * @returns {Buffer}
   */
  _deriveMasterKey() {
    const envKey = process.env.VAULT_MASTER_KEY;

    if (envKey) {
      // Derive a 256-bit key from the env var using PBKDF2
      // H-04: Per-deployment salt derived from master key itself (deterministic but unique per key)
      const salt = crypto.createHash('sha256').update('effy-vault-salt:' + envKey).digest();
      return crypto.pbkdf2Sync(envKey, salt, 100000, KEY_LENGTH, 'sha256');
    }

    // Auto-generate on first boot (ephemeral — secrets won't survive restart)
    log.warn('VAULT_MASTER_KEY not set — auto-generating ephemeral key. Secrets will not persist across restarts.');
    return crypto.randomBytes(KEY_LENGTH);
  }

  /**
   * 값 암호화.
   * @param {string} plaintext
   * @returns {{ encrypted: string, iv: string, authTag: string }}
   */
  _encrypt(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this._masterKey, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex'),
    };
  }

  /**
   * 값 복호화.
   * @param {{ encrypted: string, iv: string, authTag: string }} data
   * @returns {string}
   */
  _decrypt(data) {
    const iv = Buffer.from(data.iv, 'hex');
    const authTag = Buffer.from(data.authTag, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this._masterKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  /**
   * 비밀 등록.
   * @param {string} name - 비밀 이름
   * @param {string} value - 비밀 값 (평문)
   * @param {object} options
   * @param {string} options.scope - 'global' | 'agent' | 'session'
   * @param {string[]} options.allowedAgents - 접근 허용 에이전트 ID 목록
   * @param {number} options.ttl - TTL (밀리초), 0 = 무기한
   * @param {string} options.ownerId - 등록자 ID
   * @returns {{ success: boolean, message: string }}
   */
  registerSecret(name, value, { scope = 'global', allowedAgents = [], ttl = 0, ownerId = 'system' } = {}) {
    if (!name || typeof value !== 'string') {
      return { success: false, message: 'Invalid secret name or value.' };
    }

    const encryptedData = this._encrypt(value);
    const expiresAt = ttl > 0 ? Date.now() + ttl : null;

    this._secrets.set(name, {
      encryptedData,
      scope,
      allowedAgents: allowedAgents.length > 0 ? new Set(allowedAgents) : null,
      ownerId,
      expiresAt,
      createdAt: Date.now(),
      accessLog: [],
    });

    log.info('Secret registered', { name, scope, hasAcl: allowedAgents.length > 0, hasTtl: ttl > 0 });
    return { success: true, message: `Secret '${name}' registered.` };
  }

  /**
   * 비밀 요청 (복호화).
   * ACL 확인 후 복호화된 값 반환.
   * @param {string} name - 비밀 이름
   * @param {string} agentId - 요청자 에이전트 ID
   * @returns {{ success: boolean, value?: string, message: string }}
   */
  requestSecret(name, agentId) {
    const secret = this._secrets.get(name);

    if (!secret) {
      log.debug('Secret not found', { name, agentId });
      return { success: false, message: `Secret '${name}' not found.` };
    }

    // TTL 만료 확인
    if (secret.expiresAt && Date.now() > secret.expiresAt) {
      this._secrets.delete(name);
      log.info('Secret expired and removed on access', { name });
      return { success: false, message: `Secret '${name}' has expired.` };
    }

    // ACL 확인
    if (secret.allowedAgents && !secret.allowedAgents.has(agentId)) {
      log.warn('Secret access denied by ACL', { name, agentId });
      secret.accessLog.push({
        agentId,
        action: 'denied',
        timestamp: Date.now(),
      });
      if (secret.accessLog.length > 1000) {
        secret.accessLog = secret.accessLog.slice(-500);
      }
      return { success: false, message: `Access denied: agent '${agentId}' not in ACL for '${name}'.` };
    }

    // 접근 로그
    secret.accessLog.push({
      agentId,
      action: 'granted',
      timestamp: Date.now(),
    });
    if (secret.accessLog.length > 1000) {
      secret.accessLog = secret.accessLog.slice(-500);
    }

    const value = this._decrypt(secret.encryptedData);
    log.debug('Secret accessed', { name, agentId });
    return { success: true, value, message: 'Access granted.' };
  }

  /**
   * 비밀 제거. 소유자 또는 admin만 가능.
   * @param {string} name - 비밀 이름
   * @param {string} requesterId - 요청자 ID
   * @param {boolean} isAdmin - 요청자가 admin인지
   * @returns {{ success: boolean, message: string }}
   */
  removeSecret(name, requesterId, isAdmin = false) {
    const secret = this._secrets.get(name);

    if (!secret) {
      return { success: false, message: `Secret '${name}' not found.` };
    }

    if (secret.ownerId !== requesterId && !isAdmin) {
      log.warn('Secret removal denied', { name, requesterId, ownerId: secret.ownerId });
      return { success: false, message: 'Only the owner or an admin can remove this secret.' };
    }

    this._secrets.delete(name);
    log.info('Secret removed', { name, requesterId });
    return { success: true, message: `Secret '${name}' removed.` };
  }

  /**
   * 비밀 존재 여부 확인.
   * @param {string} name
   * @returns {boolean}
   */
  hasSecret(name) {
    const secret = this._secrets.get(name);
    if (!secret) return false;
    if (secret.expiresAt && Date.now() > secret.expiresAt) {
      this._secrets.delete(name);
      return false;
    }
    return true;
  }

  /**
   * 등록된 비밀 목록 (값 제외).
   * @returns {object[]}
   */
  listSecrets() {
    const result = [];
    for (const [name, secret] of this._secrets.entries()) {
      if (secret.expiresAt && Date.now() > secret.expiresAt) {
        this._secrets.delete(name);
        continue;
      }
      result.push({
        name,
        scope: secret.scope,
        ownerId: secret.ownerId,
        hasAcl: !!secret.allowedAgents,
        expiresAt: secret.expiresAt,
        createdAt: secret.createdAt,
        accessCount: secret.accessLog.length,
      });
    }
    return result;
  }

  /**
   * 만료된 비밀 자동 정리.
   */
  _cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;
    for (const [name, secret] of this._secrets.entries()) {
      if (secret.expiresAt && now > secret.expiresAt) {
        this._secrets.delete(name);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug('Expired secrets cleaned up', { count: cleaned });
    }
  }

  /**
   * 자동 정리 타이머 시작.
   */
  _startCleanup() {
    this._cleanupTimer = setInterval(() => this._cleanupExpired(), CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref();
  }

  /**
   * 정리 타이머 중지 (테스트용).
   */
  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }
}

// ─── Singleton ───
let _instance = null;

function getVault() {
  if (!_instance) {
    _instance = new Vault();
  }
  return _instance;
}

module.exports = {
  Vault,
  getVault,
};
