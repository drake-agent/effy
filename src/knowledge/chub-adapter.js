/**
 * chub-adapter.js — Context Hub Library-Level Adapter for Effy v3.6.2.
 *
 * Context Hub의 핵심 모듈을 직접 import하여 Effy 에이전트에게 API 문서 검색 기능 제공.
 * MCP stdio 불필요 — 라이브러리 레벨 직접 호출 (5ms latency vs 200ms).
 *
 * 기능:
 * - searchDocs: BM25 + keyword hybrid 검색 (602 authors, 1,651 DOC.md)
 * - getDoc: 개별 문서 전문 조회 (CDN/cache fallback)
 * - annotate/getAnnotation: 에이전트 학습 노트 (세션 간 지속)
 * - addSource/removeSource/listSources: 사용자 커스텀 API 소스 CRUD
 */
const fs = require('fs');
const pathMod = require('path');
const { createLogger } = require('../shared/logger');
const log = createLogger('knowledge:chub');

// Vendor imports (ESM→CJS converted)
const { searchEntries, getEntry, listEntries, resolveDocPath, resolveEntryFile } = require('./vendor/registry');
const { fetchDoc, fetchDocFull, ensureRegistry, fetchAllRegistries, loadSourceRegistry } = require('./vendor/cache');
const { readAnnotation, writeAnnotation, listAnnotations, clearAnnotation } = require('./vendor/annotations');
const { getChubDir, loadConfig } = require('./vendor/config');
const { parseFrontmatter } = require('./vendor/frontmatter');

// ─── Singleton ───
let _instance = null;

class ChubAdapter {
  /**
   * @param {object} effyConfig - effy.config.yaml의 contextHub 섹션
   */
  constructor(effyConfig = {}) {
    this.initialized = false;
    this.initPromise = null;

    // Effy config → chub config 매핑
    this.cacheDir = effyConfig.cacheDir || './data/chub-cache';
    this.refreshInterval = effyConfig.refreshInterval || 21600; // 6h
    this.defaultLang = effyConfig.defaultLang || 'python';
    this.maxResults = effyConfig.maxResults || 10;

    // 사용자 커스텀 소스 저장 경로
    this.customSourcesPath = pathMod.join(this.cacheDir, 'custom-sources.json');
  }

  /**
   * Lazy init — 첫 호출 시 1회만 실행.
   * ensureRegistry()로 CDN에서 registry.json 다운로드 (캐시 있으면 skip).
   */
  async init() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        // CHUB_DIR 환경변수 설정
        process.env.CHUB_DIR = this.cacheDir;

        // 캐시 디렉토리 생성
        if (!fs.existsSync(this.cacheDir)) {
          fs.mkdirSync(this.cacheDir, { recursive: true });
        }

        // 커스텀 소스를 config에 병합
        this._mergeCustomSources();

        await ensureRegistry();
        this.initialized = true;
        log.info('ChubAdapter initialized', { cacheDir: this.cacheDir });
      } catch (err) {
        log.warn('ChubAdapter init failed (offline mode)', { error: err.message });
        // 오프라인에서도 로컬 캐시가 있으면 동작
        this.initialized = true;
      }
    })();

    return this.initPromise;
  }

  // ═══════════════════════════════════════════════════════
  // 핵심 API: 검색 + 조회
  // ═══════════════════════════════════════════════════════

  /**
   * API 문서 검색 — BM25 + keyword hybrid.
   *
   * @param {string} query - 검색 키워드 (예: "openai streaming")
   * @param {object} opts
   * @param {string} opts.lang - 언어 필터 (python, javascript, ...)
   * @param {string[]} opts.tags - 태그 필터
   * @param {number} opts.limit - 결과 수 (기본 5)
   * @returns {Array<{id, name, description, tags, type, source, score}>}
   */
  async searchDocs(query, opts = {}) {
    if (!this.initialized) await this.init();

    if (!query || query.trim().length < 2) {
      return [];
    }

    try {
      const filters = {};
      if (opts.tags) filters.tags = Array.isArray(opts.tags) ? opts.tags.join(',') : opts.tags;
      if (opts.lang) filters.lang = opts.lang;

      const results = searchEntries(query, filters);
      const limit = Math.min(opts.limit || 5, this.maxResults);

      return results.slice(0, limit).map(e => ({
        id: e.id,
        name: e.name || e.id,
        description: e.description || '',
        tags: e.tags || [],
        type: e._type || (e.languages ? 'doc' : 'skill'),
        source: e._source || 'default',
        score: e._score || 0,
      }));
    } catch (err) {
      log.warn('searchDocs failed', { query, error: err.message });
      return [];
    }
  }

  /**
   * 개별 API 문서 조회 — CDN/local cache fallback.
   *
   * @param {string} id - 문서 ID (예: "openai/chat")
   * @param {object} opts
   * @param {string} opts.lang - 언어 (기본: config.defaultLang)
   * @param {boolean} opts.full - 참조 파일 포함 여부
   * @returns {{ id, name, content, annotation, files? } | null}
   */
  async getDoc(id, opts = {}) {
    if (!this.initialized) await this.init();

    try {
      const result = getEntry(id);
      if (!result || !result.entry) {
        return null;
      }

      const entry = result.entry;
      const lang = opts.lang || this.defaultLang;
      const resolved = resolveDocPath(entry, lang);

      if (!resolved || resolved.needsLanguage || resolved.versionNotFound) {
        // 언어 지정 필요 또는 버전 없음
        return {
          id,
          name: entry.name || id,
          error: resolved?.needsLanguage
            ? `Language required. Available: ${resolved.available.join(', ')}`
            : resolved?.versionNotFound
              ? `Version not found. Available: ${resolved.available.join(', ')}`
              : 'Document path not resolved',
          availableLanguages: resolved?.available || [],
        };
      }

      const entryFile = resolveEntryFile(resolved, entry._type || 'doc');
      if (entryFile.error) {
        return { id, name: entry.name, error: entryFile.error };
      }

      // 메인 문서 조회
      const content = await fetchDoc(resolved.source, entryFile.filePath);

      // annotation 자동 append
      const annotation = readAnnotation(id);

      const doc = {
        id,
        name: entry.name || id,
        description: entry.description || '',
        content,
        annotation: annotation ? annotation.note : null,
      };

      // full 모드: 참조 파일도 포함
      if (opts.full && entryFile.files && entryFile.files.length > 0) {
        const additionalFiles = await fetchDocFull(
          resolved.source,
          entryFile.basePath,
          entryFile.files.filter(f => f !== 'DOC.md' && f !== 'SKILL.md')
        );
        doc.files = additionalFiles;
      }

      return doc;
    } catch (err) {
      log.warn('getDoc failed', { id, error: err.message });
      return { id, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Annotation API: 에이전트 학습 노트
  // ═══════════════════════════════════════════════════════

  /**
   * API 문서에 에이전트 학습 노트 추가.
   */
  annotate(id, note) {
    try {
      return writeAnnotation(id, note);
    } catch (err) {
      log.warn('annotate failed', { id, error: err.message });
      return null;
    }
  }

  /**
   * API 문서의 에이전트 학습 노트 조회.
   */
  getAnnotation(id) {
    return readAnnotation(id);
  }

  /**
   * 모든 annotation 목록.
   */
  getAllAnnotations() {
    return listAnnotations();
  }

  // ═══════════════════════════════════════════════════════
  // Custom Source API: 사용자 커스텀 API 소스 관리
  // ═══════════════════════════════════════════════════════

  /**
   * 사용자가 슬랙봇에서 커스텀 API 문서 소스 추가.
   *
   * @param {string} name - 소스 이름 (예: "internal-api", "stripe-custom")
   * @param {string} url - 소스 URL (registry.json이 있는 CDN 루트)
   * @param {object} opts
   * @param {string} opts.addedBy - 추가한 사용자 ID
   * @param {string} opts.description - 소스 설명
   * @returns {{ success, source?, error? }}
   */
  async addSource(name, url, opts = {}) {
    if (!name || !url) {
      return { success: false, error: 'name과 url은 필수입니다.' };
    }

    // SEC: URL 형식 검증
    if (!this._isValidSourceUrl(url)) {
      return { success: false, error: 'Invalid URL format. https:// URL만 허용됩니다.' };
    }

    // SEC: 소스 이름 검증 (알파벳, 숫자, 하이픈만)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/.test(name)) {
      return { success: false, error: 'Invalid source name. 알파벳/숫자/하이픈만, 1-50자.' };
    }

    const sources = this._loadCustomSources();

    // 중복 체크
    if (sources.find(s => s.name === name)) {
      return { success: false, error: `소스 '${name}'이(가) 이미 존재합니다. remove_api_source로 먼저 삭제하세요.` };
    }

    // 최대 소스 수 제한
    const MAX_CUSTOM_SOURCES = 20;
    if (sources.length >= MAX_CUSTOM_SOURCES) {
      return { success: false, error: `커스텀 소스는 최대 ${MAX_CUSTOM_SOURCES}개까지 추가 가능합니다.` };
    }

    const newSource = {
      name,
      url: url.replace(/\/+$/, ''), // trailing slash 제거
      addedBy: opts.addedBy || 'unknown',
      description: opts.description || '',
      addedAt: new Date().toISOString(),
    };

    // registry.json 접근 가능 여부 검증 (best-effort)
    try {
      const testUrl = `${newSource.url}/registry.json`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(testUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        return { success: false, error: `소스 URL에서 registry.json을 찾을 수 없습니다 (HTTP ${res.status}). URL을 확인하세요.` };
      }

      // 응답이 JSON인지 검증
      const text = await res.text();
      JSON.parse(text); // throws if invalid
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        return { success: false, error: '소스 URL 접근 시간 초과 (10초). URL을 확인하세요.' };
      }
      return { success: false, error: `소스 검증 실패: ${fetchErr.message}` };
    }

    sources.push(newSource);
    this._saveCustomSources(sources);

    // 레지스트리 캐시 무효화 → 다음 검색 시 새 소스 포함
    this._invalidateRegistryCache();

    log.info('Custom source added', { name, url: newSource.url, addedBy: newSource.addedBy });

    return {
      success: true,
      source: { name: newSource.name, url: newSource.url, description: newSource.description },
      message: `API 소스 '${name}' 추가 완료. 다음 검색부터 이 소스의 문서도 포함됩니다.`,
    };
  }

  /**
   * 커스텀 API 소스 제거.
   */
  removeSource(name) {
    const sources = this._loadCustomSources();
    const idx = sources.findIndex(s => s.name === name);
    if (idx === -1) {
      return { success: false, error: `커스텀 소스 '${name}'을(를) 찾을 수 없습니다.` };
    }

    const removed = sources.splice(idx, 1)[0];
    this._saveCustomSources(sources);
    this._invalidateRegistryCache();

    log.info('Custom source removed', { name, removedUrl: removed.url });
    return { success: true, message: `API 소스 '${name}' 제거 완료.` };
  }

  /**
   * 등록된 모든 API 소스 목록 (기본 + 커스텀).
   */
  listSources() {
    const config = loadConfig();
    const customSources = this._loadCustomSources();

    const allSources = [
      ...config.sources.map(s => ({
        name: s.name,
        url: s.url || s.path || '(local)',
        type: 'builtin',
        description: s.name === 'default' ? 'Context Hub 공식 레지스트리 (602 authors, 1,651 docs)' : '',
      })),
      ...customSources.map(s => ({
        name: s.name,
        url: s.url,
        type: 'custom',
        description: s.description || '',
        addedBy: s.addedBy,
        addedAt: s.addedAt,
      })),
    ];

    return allSources;
  }

  /**
   * 레지스트리 강제 새로고침 (캐시 무시).
   */
  async refreshRegistry() {
    if (!this.initialized) await this.init();
    try {
      this._invalidateRegistryCache();
      await fetchAllRegistries(true);
      log.info('Registry force-refreshed');
      return { success: true, message: '레지스트리 새로고침 완료.' };
    } catch (err) {
      return { success: false, error: `새로고침 실패: ${err.message}` };
    }
  }

  // ═══════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════

  /** 커스텀 소스 목록 로드 */
  _loadCustomSources() {
    try {
      if (fs.existsSync(this.customSourcesPath)) {
        return JSON.parse(fs.readFileSync(this.customSourcesPath, 'utf8'));
      }
    } catch (err) {
      log.warn('Failed to load custom sources', { error: err.message });
    }
    return [];
  }

  /** 커스텀 소스 목록 저장 */
  _saveCustomSources(sources) {
    const dir = pathMod.dirname(this.customSourcesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.customSourcesPath, JSON.stringify(sources, null, 2));
  }

  /** 커스텀 소스를 vendor/config.js의 _config에 병합 */
  _mergeCustomSources() {
    const customSources = this._loadCustomSources();
    if (customSources.length === 0) return;

    // loadConfig()를 호출한 뒤, 내부 캐시된 config.sources에 커스텀 소스 추가
    const config = loadConfig();
    for (const cs of customSources) {
      if (!config.sources.find(s => s.name === cs.name)) {
        config.sources.push({ name: cs.name, url: cs.url });
      }
    }
  }

  /** 레지스트리 인메모리 캐시 무효화 */
  _invalidateRegistryCache() {
    // vendor/registry.js의 _merged와 _searchIndex를 null로 리셋
    try {
      const reg = require('./vendor/registry');
      if (typeof reg._resetCache === 'function') {
        reg._resetCache();
      }
    } catch (_) { /* ignore */ }

    // vendor/config.js의 _config도 리셋
    try {
      const cfg = require('./vendor/config');
      if (typeof cfg._resetConfig === 'function') {
        cfg._resetConfig();
      }
    } catch (_) { /* ignore */ }
  }

  /** URL 형식 검증 + SSRF 보호 */
  _isValidSourceUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return false;
      }

      // SEC-1: IP range blocklist check
      const hostname = parsed.hostname;
      if (!hostname) return false;

      // Reject private/reserved IP ranges (IPv4 + IPv6)
      const ipBlacklist = [
        /^localhost$/i,
        /^127\./,                    // 127.x.x.x (localhost)
        /^10\./,                     // 10.x.x.x (private)
        /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16-31.x (private)
        /^192\.168\./,               // 192.168.x.x (private)
        /^169\.254\./,               // 169.254.x.x (link-local)
        /^0\./,                      // 0.x.x.x (current network)
        /^\[/,                       // SEC-1b: Any IPv6 in brackets ([::1], [::ffff:127.0.0.1], etc.)
        /^::1$/,                     // IPv6 localhost without brackets
        /^::ffff:/i,                 // IPv4-mapped IPv6
        /^fd[0-9a-f]{2}:/i,         // IPv6 ULA (fd00::/8)
        /^fe80:/i,                   // IPv6 link-local (fe80::/10)
        /^fc[0-9a-f]{2}:/i,         // IPv6 ULA (fc00::/7)
      ];

      for (const pattern of ipBlacklist) {
        if (pattern.test(hostname)) {
          return false;
        }
      }

      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 싱글톤 getter — Gateway/Runtime에서 공유.
 */
function getChubAdapter(effyConfig) {
  if (!_instance) {
    _instance = new ChubAdapter(effyConfig);
  }
  return _instance;
}

/**
 * 테스트용 싱글톤 리셋.
 */
function _resetChubAdapter() {
  _instance = null;
}

module.exports = { ChubAdapter, getChubAdapter, _resetChubAdapter };
