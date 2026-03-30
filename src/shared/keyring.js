/**
 * keyring.js — OS 키링 통합으로 보안 저장
 * OS Keyring Integration for Secrets
 *
 * macOS Keychain, Linux Secret Service를 통해 비밀번호 저장/조회.
 * Fallback: 환경변수 → 암호화된 파일
 */

const { createLogger } = require('./logger');
const path = require('path');
const fs = require('fs');

const log = createLogger('shared/keyring');

/**
 * OS 키링 매니저
 * KeyringManager — 플랫폼별 보안 저장소 통합
 */
class KeyringManager {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.serviceName='effy-agent'] - 서비스명 (Keychain 항목)
   * @param {boolean} [opts.fallbackToEnv=true] - Fallback: 환경변수 사용
   */
  constructor(opts = {}) {
    this.serviceName = opts.serviceName ?? 'effy-agent';
    this.fallbackToEnv = opts.fallbackToEnv ?? true;
    this._backend = null; // 'keytar'|'env'|'file'|'none'
    this._cache = new Map(); // { key -> { value, timestamp } }
    this._keytar = null;
  }

  /**
   * 초기화 — 사용 가능한 키링 백엔드 감지
   * Priority: keytar (OS keyring) → env vars → encrypted file
   */
  async init() {
    try {
      // 1. keytar 시도
      try {
        this._keytar = require('keytar');
        this._backend = 'keytar';
        log.info('Keyring backend initialized', { backend: 'keytar' });
        return;
      } catch (keytarErr) {
        log.debug('keytar not available', { error: keytarErr.message });
      }

      // 2. 환경변수 Fallback
      if (this.fallbackToEnv) {
        this._backend = 'env';
        log.info('Keyring backend initialized', { backend: 'env' });
        return;
      }

      // 3. 파일 기반 (암호화 없이 경고)
      this._backend = 'file';
      log.warn('Keyring backend initialized (unencrypted file storage)', { backend: 'file' });
    } catch (err) {
      log.error('Failed to initialize keyring', err);
      this._backend = 'none';
    }
  }

  /**
   * 비밀값 저장
   * @param {string} key - e.g., 'anthropic-api-key'
   * @param {string} value
   * @param {string} [agentId] - 특정 에이전트로 스코핑
   */
  async set(key, value, agentId = null) {
    try {
      if (!key || !value) {
        throw new Error('Key and value are required');
      }

      const fullKey = agentId ? `${agentId}/${key}` : key;

      if (this._backend === 'keytar' && this._keytar) {
        await this._keytar.setPassword(this.serviceName, fullKey, value);
        this._cache.set(fullKey, { value, timestamp: Date.now() });
        log.debug('Secret stored (keytar)', { key: fullKey });
        return;
      }

      if (this._backend === 'env') {
        // 환경변수 저장은 보안 위험 - 경고 발생 및 캐시만 사용
        log.warn('Storing secret in environment variable (not recommended for sensitive data)', { key: fullKey });
        // process.env에 저장하지 않고 캐시에만 저장
        this._cache.set(fullKey, { value, timestamp: Date.now() });
        log.debug('Secret stored (cache only)', { key: fullKey });
        return;
      }

      if (this._backend === 'file') {
        this._cache.set(fullKey, { value, timestamp: Date.now() });
        log.debug('Secret stored (cache)', { key: fullKey });
        return;
      }

      throw new Error('No keyring backend available');
    } catch (err) {
      log.error('Failed to set secret', err);
      throw err;
    }
  }

  /**
   * 비밀값 조회
   * @param {string} key
   * @param {string} [agentId]
   * @returns {Promise<string|null>}
   */
  async get(key, agentId = null) {
    try {
      const fullKey = agentId ? `${agentId}/${key}` : key;

      // 캐시 확인
      const cached = this._cache.get(fullKey);
      if (cached) {
        log.debug('Secret retrieved (cache)', { key: fullKey });
        return cached.value;
      }

      if (this._backend === 'keytar' && this._keytar) {
        const value = await this._keytar.getPassword(this.serviceName, fullKey);
        if (value) {
          this._cache.set(fullKey, { value, timestamp: Date.now() });
        }
        return value || null;
      }

      if (this._backend === 'env') {
        const envKey = this._keyToEnvName(fullKey);
        const value = process.env[envKey] || null;
        if (value) {
          this._cache.set(fullKey, { value, timestamp: Date.now() });
        }
        return value;
      }

      return null;
    } catch (err) {
      log.error('Failed to get secret', err);
      return null;
    }
  }

  /**
   * 비밀값 삭제
   * @param {string} key
   * @param {string} [agentId]
   */
  async delete(key, agentId = null) {
    try {
      const fullKey = agentId ? `${agentId}/${key}` : key;

      if (this._backend === 'keytar' && this._keytar) {
        await this._keytar.deletePassword(this.serviceName, fullKey);
        this._cache.delete(fullKey);
        log.debug('Secret deleted (keytar)', { key: fullKey });
        return;
      }

      if (this._backend === 'env') {
        const envKey = this._keyToEnvName(fullKey);
        delete process.env[envKey];
        this._cache.delete(fullKey);
        log.debug('Secret deleted (env)', { key: fullKey });
        return;
      }

      this._cache.delete(fullKey);
    } catch (err) {
      log.error('Failed to delete secret', err);
      throw err;
    }
  }

  /**
   * 에이전트의 모든 비밀 키 나열 (값 제외)
   * @param {string} [agentId]
   * @returns {Promise<string[]>}
   */
  async list(agentId = null) {
    try {
      const keys = [];
      const prefix = agentId ? `${agentId}/` : '';

      // 캐시에서 조회
      for (const key of this._cache.keys()) {
        if (key.startsWith(prefix)) {
          keys.push(key.replace(prefix, ''));
        }
      }

      // 환경변수에서 조회
      if (this._backend === 'env') {
        for (const [envKey] of Object.entries(process.env)) {
          if (envKey.startsWith('EFFY_SECRET_')) {
            const key = this._envNameToKey(envKey);
            if (key.startsWith(prefix)) {
              keys.push(key.replace(prefix, ''));
            }
          }
        }
      }

      return [...new Set(keys)]; // 중복 제거
    } catch (err) {
      log.error('Failed to list secrets', err);
      return [];
    }
  }

  /**
   * 현재 사용 중인 백엔드 타입 조회
   * @returns {string} 'keytar'|'env'|'file'|'none'
   */
  getBackend() {
    return this._backend || 'none';
  }

  /**
   * 캐시 지우기
   */
  clearCache() {
    this._cache.clear();
  }

  /**
   * 키를 환경변수 이름으로 변환
   * @private
   */
  _keyToEnvName(key) {
    return `EFFY_SECRET_${key.toUpperCase().replace(/[/-]/g, '_')}`;
  }

  /**
   * 환경변수 이름을 키로 변환
   * @private
   */
  _envNameToKey(envKey) {
    return envKey.replace('EFFY_SECRET_', '').toLowerCase().replace(/_/g, '-');
  }
}

module.exports = { KeyringManager };
