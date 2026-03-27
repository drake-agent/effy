/**
 * hot-reload.js — 런타임 설정 핫 리로드 (SpaceBot ArcSwap 패턴 차용).
 *
 * config 파일 변경 시 프로세스 재시작 없이 원자적으로 교체.
 * fs.watch + debounce + atomic swap 패턴.
 *
 * 핫 리로드 가능:
 * - 모델 라우팅 설정
 * - 압축 임계값
 * - Identity 파일 (SOUL.md, IDENTITY.md, ROLE.md)
 * - 스킬 파일
 * - 버짓 설정
 *
 * 재시작 필요:
 * - LLM API 키
 * - 채널 어댑터 (Slack/Teams 토큰)
 * - 데이터베이스 경로
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('hot-reload');

class HotReloader {
  /**
   * @param {Object} opts
   * @param {string} opts.configPath - effy.config.yaml 경로
   * @param {number} [opts.debounceMs=2000] - 변경 감지 디바운스 (SpaceBot: 2초)
   * @param {Function} [opts.onReload] - 리로드 콜백 (newConfig) => void
   */
  constructor(opts = {}) {
    this.configPath = opts.configPath || './effy.config.yaml';
    this.debounceMs = opts.debounceMs || 2000;
    this.onReload = opts.onReload || null;

    /** @type {Object} 현재 활성 설정 (읽기 전용 스냅샷) */
    this._current = null;

    /** @type {Map<string, Function>} 섹션별 변경 리스너 */
    this._listeners = new Map();

    /** @type {FSWatcher|null} */
    this._watcher = null;
    this._debounceTimer = null;
    this._watchedDirs = new Map(); // dir → FSWatcher

    this._running = false;
  }

  /**
   * 핫 리로드 시작.
   * @param {Object} initialConfig - 초기 설정 객체
   */
  start(initialConfig) {
    if (this._running) return;
    this._running = true;

    this._current = Object.freeze({ ...initialConfig });

    // 메인 config 파일 감시
    this._watchFile(this.configPath, 'config');

    log.info('Hot-reloader started', { configPath: this.configPath, debounceMs: this.debounceMs });
  }

  /**
   * 핫 리로드 중지.
   */
  stop() {
    this._running = false;
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    for (const [, watcher] of this._watchedDirs) { watcher.close(); }
    this._watchedDirs.clear();
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    log.info('Hot-reloader stopped');
  }

  /**
   * 현재 설정 조회 (읽기 전용 스냅샷).
   * @returns {Object}
   */
  getCurrent() {
    return this._current;
  }

  /**
   * 설정의 특정 경로 값 조회.
   * @param {string} keyPath - dot-notation (예: 'modelRouter.defaultModel')
   * @param {*} defaultValue
   * @returns {*}
   */
  get(keyPath, defaultValue) {
    const keys = keyPath.split('.');
    let value = this._current;
    for (const key of keys) {
      if (value == null || typeof value !== 'object') return defaultValue;
      value = value[key];
    }
    return value !== undefined ? value : defaultValue;
  }

  /**
   * 디렉토리 감시 추가 (Identity 파일, 스킬 등).
   * @param {string} dir - 감시할 디렉토리
   * @param {string} category - 변경 카테고리 (identity, skill 등)
   */
  watchDirectory(dir, category) {
    if (!fs.existsSync(dir)) return;

    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        this._onFileChange(category, path.join(dir, filename || ''));
      });
      this._watchedDirs.set(dir, watcher);
      log.debug('Watching directory', { dir, category });
    } catch (err) {
      log.warn('Failed to watch directory', { dir, error: err.message });
    }
  }

  /**
   * 섹션별 변경 리스너 등록.
   * @param {string} section - 설정 섹션 이름 (예: 'modelRouter', 'compaction')
   * @param {Function} listener - (newValue, oldValue) => void
   */
  onSectionChange(section, listener) {
    this._listeners.set(section, listener);
  }

  /**
   * 수동 설정 업데이트 (테스트용).
   * @param {Object} newConfig
   */
  update(newConfig) {
    const oldConfig = this._current;
    this._current = Object.freeze({ ...newConfig });

    // 변경된 섹션에 대해 리스너 호출
    for (const [section, listener] of this._listeners) {
      const oldVal = oldConfig?.[section];
      const newVal = newConfig?.[section];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        try {
          listener(newVal, oldVal);
          log.info('Section reloaded', { section });
        } catch (err) {
          log.error('Section reload listener failed', { section, error: err.message });
        }
      }
    }

    if (this.onReload) {
      try { this.onReload(this._current); } catch {}
    }
  }

  /** @private */
  _watchFile(filePath, category) {
    try {
      this._watcher = fs.watch(filePath, (eventType) => {
        if (eventType === 'change') {
          this._onFileChange(category, filePath);
        }
      });
    } catch (err) {
      log.warn('Failed to watch config file', { filePath, error: err.message });
    }
  }

  /** @private */
  _onFileChange(category, filePath) {
    // 디바운스
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      log.info('File change detected', { category, filePath });
      this._reload(category, filePath);
    }, this.debounceMs);
  }

  /** @private */
  _reload(category, filePath) {
    try {
      if (category === 'config') {
        // YAML 설정 리로드
        const yaml = require('js-yaml');
        const raw = fs.readFileSync(filePath, 'utf-8');
        const newConfig = yaml.load(raw);

        // 핫 리로드 불가 섹션 보존
        const merged = {
          ...newConfig,
          // 재시작 필요 섹션은 기존 값 유지
          anthropic: this._current?.anthropic,
          channels: this._current?.channels,
          db: this._current?.db,
        };

        this.update(merged);
        log.info('Config hot-reloaded', { sections: Object.keys(newConfig).length });
      } else if (category === 'identity' || category === 'skill') {
        // Identity/Skill 파일 리로드 이벤트 발행
        for (const [section, listener] of this._listeners) {
          if (section === category) {
            try { listener(filePath, null); } catch {}
          }
        }
      }
    } catch (err) {
      log.error('Reload failed', { category, filePath, error: err.message });
    }
  }
}

module.exports = { HotReloader };
