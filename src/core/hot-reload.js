/**
 * hot-reload.js — 무중단 설정 변경 (Atomic Swap 패턴).
 * chokidar/fs.watch로 설정 파일 감시 → 런타임 교체.
 *
 * Hot-reload configuration without downtime using fs.watch.
 * Monitors effy.config.yaml and .env for changes with debouncing.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const yaml = require('yaml');
const { createLogger } = require('../shared/logger');

const log = createLogger('core:hot-reload');

/**
 * HotReloadWatcher — 설정 파일 감시 + 런타임 리로드
 * Watches config files and triggers reload on changes
 */
class HotReloadWatcher extends EventEmitter {
  constructor(opts = {}) {
    super();

    /**
     * 감시 중인 파일 경로들
     * @type {string[]}
     */
    this.watchedFiles = [];

    /**
     * 현재 설정
     * @type {Object}
     */
    this.currentConfig = null;

    /**
     * 이전 설정 (롤백용)
     * @type {Object}
     */
    this.previousConfig = null;

    /**
     * fs.watch 리스너들
     * @type {Map<string, Function>}
     */
    this.watchers = new Map();

    /**
     * 리로드 디바운스 타이머
     * @type {NodeJS.Timeout|null}
     */
    this.debounceTimer = null;

    /**
     * 디바운스 대기 시간 (ms)
     * @type {number}
     */
    this.debounceMs = opts.debounceMs || 500;

    /**
     * 스키마 검증 함수 (사용자가 제공)
     * @type {Function|null}
     */
    this.validator = opts.validator || null;

    /**
     * 리로드 콜백들
     * @type {Function[]}
     */
    this.reloadCallbacks = [];

    log.info('HotReloadWatcher initialized', {
      debounceMs: this.debounceMs,
    });
  }

  /**
   * 설정 파일들 감시 시작
   * Start watching config files for changes
   *
   * @param {string|string[]} filePaths - 감시할 파일 경로들 (effy.config.yaml, .env 등)
   */
  watch(filePaths) {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

    for (const filePath of paths) {
      if (this.watchedFiles.includes(filePath)) {
        log.warn('File already watched', { filePath });
        continue;
      }

      this.watchedFiles.push(filePath);

      // fs.watch 시작 (chokidar 대신 fs.watch 사용)
      try {
        const watcher = fs.watch(filePath, (eventType, filename) => {
          if (eventType === 'change') {
            log.debug('File changed detected', { filePath, eventType });
            this._debounceReload();
          }
        });

        this.watchers.set(filePath, watcher);
        log.info('Now watching file', { filePath });
      } catch (err) {
        log.error('Failed to watch file', err);
      }
    }
  }

  /**
   * 리로드를 디바운스 처리 (연속 변경 방지)
   * Debounce reload to prevent multiple triggers
   *
   * @private
   */
  _debounceReload() {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this._performReload();
    }, this.debounceMs);
  }

  /**
   * 실제 리로드 수행
   * Perform the actual config reload
   *
   * @private
   */
  _performReload() {
    try {
      log.info('Reloading configuration...');

      // YAML 파일 다시 읽기
      let newConfig = {};
      for (const filePath of this.watchedFiles) {
        if (!filePath.endsWith('.yaml')) continue;
        if (!fs.existsSync(filePath)) continue;

        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const parsed = yaml.parse(raw);
          newConfig = this._deepMerge(newConfig, parsed);
        } catch (err) {
          log.error('Failed to parse YAML file', err);
          return;
        }
      }

      // 스키마 검증
      if (!this._validateConfig(newConfig)) {
        log.warn('Config validation failed, rolling back');
        return;
      }

      // 변경 사항 추적
      const changes = this._diffConfig(this.currentConfig, newConfig);

      // 리로드 불가능한 섹션 확인
      const nonReloadableSections = ['database', 'port', 'secrets'];
      const requiresRestart = changes.some(
        (change) =>
          nonReloadableSections.some((section) => change.startsWith(section))
      );

      if (requiresRestart) {
        log.warn('Config changes require restart', {
          changedSections: changes,
        });
        this.emit('config:requires-restart', {
          changes,
        });
        return;
      }

      // 이전 설정 저장
      this.previousConfig = this.currentConfig;

      // 새 설정 적용
      this.currentConfig = newConfig;

      log.info('Config reloaded successfully', {
        changedKeys: changes,
      });

      // 콜백 실행
      for (const callback of this.reloadCallbacks) {
        try {
          callback(newConfig, changes);
        } catch (err) {
          log.error('Reload callback failed', err);
        }
      }

      // 이벤트 발생
      this.emit('config:reloaded', {
        config: newConfig,
        changes,
      });
    } catch (err) {
      log.error('Config reload failed', err);
      this.emit('config:error', { error: err });
    }
  }

  /**
   * 현재 설정 반환 (원자적 읽기)
   * Get current config (atomic read)
   *
   * @returns {Object|null} 현재 설정 객체
   */
  getConfig() {
    return this.currentConfig ? { ...this.currentConfig } : null;
  }

  /**
   * 리로드 리스너 등록
   * Register a reload listener callback
   *
   * @param {Function} callback - (newConfig, changedKeys) => void
   */
  onReload(callback) {
    if (typeof callback === 'function') {
      this.reloadCallbacks.push(callback);
    }
  }

  /**
   * 설정 스키마 검증
   * Validate config against schema
   *
   * @private
   * @param {Object} newConfig - 검증할 설정
   * @returns {boolean} 유효하면 true
   */
  _validateConfig(newConfig) {
    if (!newConfig || typeof newConfig !== 'object') {
      log.error('Config validation failed: not an object');
      return false;
    }

    // 사용자 정의 검증 함수가 있으면 사용
    if (this.validator && typeof this.validator === 'function') {
      try {
        return this.validator(newConfig);
      } catch (err) {
        log.error('Custom validator failed', err);
        return false;
      }
    }

    // 기본 검증 (필수 섹션 확인)
    const requiredSections = [];
    for (const section of requiredSections) {
      if (!(section in newConfig)) {
        log.warn('Missing required config section', { section });
      }
    }

    return true;
  }

  /**
   * 두 설정 비교하여 변경된 키들 반환
   * Diff two configs and return changed keys
   *
   * @private
   * @param {Object|null} oldConfig - 이전 설정
   * @param {Object} newConfig - 새 설정
   * @returns {string[]} 변경된 키들 (dot notation)
   */
  _diffConfig(oldConfig, newConfig) {
    const changes = [];

    if (!oldConfig) {
      return Object.keys(newConfig);
    }

    // 깊은 비교 (dot notation 사용)
    const collectChanges = (obj1, obj2, prefix = '') => {
      for (const key of Object.keys(obj2)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const val1 = obj1?.[key];
        const val2 = obj2[key];

        if (JSON.stringify(val1) !== JSON.stringify(val2)) {
          changes.push(fullKey);

          // 깊은 객체면 재귀
          if (val2 && typeof val2 === 'object' && !Array.isArray(val2)) {
            collectChanges(val1 || {}, val2, fullKey);
          }
        }
      }
    };

    collectChanges(oldConfig, newConfig);
    return changes;
  }

  /**
   * 깊은 병합
   * Deep merge two objects
   *
   * @private
   * @param {Object} base - 기본 객체
   * @param {Object} override - 오버라이드 객체
   * @returns {Object} 병합된 객체
   */
  _deepMerge(base, override) {
    if (!override || typeof override !== 'object') return base;
    const result = { ...base };

    for (const key of Object.keys(override)) {
      const ov = override[key];
      if (
        ov &&
        typeof ov === 'object' &&
        !Array.isArray(ov) &&
        typeof result[key] === 'object' &&
        !Array.isArray(result[key])
      ) {
        result[key] = this._deepMerge(result[key], ov);
      } else {
        result[key] = ov;
      }
    }

    return result;
  }

  /**
   * 감시 중지
   * Stop watching all files
   */
  unwatch() {
    for (const [filePath, watcher] of this.watchers) {
      try {
        watcher.close();
        log.info('Stopped watching file', { filePath });
      } catch (err) {
        log.error('Failed to close watcher', err);
      }
    }
    this.watchers.clear();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  /**
   * 정리
   * Clean up and close watchers
   */
  destroy() {
    this.unwatch();
    this.reloadCallbacks = [];
    this.removeAllListeners();
    log.info('HotReloadWatcher destroyed');
  }
}

module.exports = { HotReloadWatcher };
