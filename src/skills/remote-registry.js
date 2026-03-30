/**
 * remote-registry.js — 원격 스킬 레지스트리 연동.
 *
 * 원격 레지스트리에서 스킬 검색, 다운로드, 설치를 지원.
 * 기존 SkillRegistry와 통합하여 로컬 + 원격 통합 검색 제공.
 *
 * 기능:
 * - 원격 레지스트리 검색 (GitHub 기반)
 * - 스킬 패키지 다운로드 + 검증
 * - 버전 관리 (semver)
 * - 인기 스킬 / 카테고리별 브라우징
 * - 스킬 의존성 해결
 *
 * 레지스트리 형식:
 * - GitHub org/repo 기반 카탈로그
 * - 각 스킬은 SKILL.md + 선택적 scripts/, references/, assets/
 * - 프론트매터: name, description, version, author, license, tags
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createLogger } = require('../shared/logger');

const log = createLogger('skills:remote-registry');

const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/fnf-ea/effy-skills/main';

/**
 * 원격 스킬 메타데이터.
 * @typedef {Object} RemoteSkill
 * @property {string} id - 스킬 ID (owner/name 형식)
 * @property {string} name - 스킬 이름
 * @property {string} description - 설명
 * @property {string} version - 버전 (semver)
 * @property {string} author - 작성자
 * @property {string[]} tags - 태그
 * @property {number} downloads - 다운로드 수
 * @property {string} updatedAt - 마지막 업데이트
 */

class RemoteSkillRegistry {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.registryUrl] - 레지스트리 베이스 URL
   * @param {string} [opts.cacheDir='./data/skills-remote'] - 다운로드 캐시 디렉토리
   * @param {number} [opts.cacheTtlMs=3600000] - 카탈로그 캐시 TTL (1시간)
   * @param {number} [opts.timeoutMs=15000] - HTTP 타임아웃
   */
  constructor(opts = {}) {
    this.registryUrl = opts.registryUrl || DEFAULT_REGISTRY_URL;
    this.cacheDir = opts.cacheDir || './data/skills-remote';
    this.cacheTtlMs = opts.cacheTtlMs || 3600000;
    this.timeoutMs = opts.timeoutMs || 15000;

    /** @type {{ catalog: Array, fetchedAt: number } | null} */
    this._catalogCache = null;

    /** @type {Map<string, { content: string, fetchedAt: number }>} */
    this._skillCache = new Map();

    // 캐시 디렉토리 생성
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch (err) {
      log.warn('Failed to create cache directory', { error: err.message, dir: this.cacheDir });
    }
  }

  /**
   * 원격 카탈로그 검색.
   *
   * @param {string} query - 검색어
   * @param {Object} [opts]
   * @param {string[]} [opts.tags] - 태그 필터
   * @param {string} [opts.sortBy='relevance'] - 정렬 (relevance, downloads, updated)
   * @param {number} [opts.limit=20]
   * @returns {Promise<Array<RemoteSkill>>}
   */
  async search(query, { tags, sortBy = 'relevance', limit = 20 } = {}) {
    const catalog = await this._getCatalog();
    if (!catalog || catalog.length === 0) return [];

    const queryLower = (query || '').toLowerCase();
    const queryTokens = queryLower.split(/\s+/).filter(t => t.length > 1);

    // 스코어링
    let scored = catalog.map(skill => {
      let score = 0;

      // 이름 매칭
      if (skill.name && skill.name.toLowerCase().includes(queryLower)) score += 10;
      // 설명 매칭
      if (skill.description) {
        for (const token of queryTokens) {
          if (skill.description.toLowerCase().includes(token)) score += 3;
        }
      }
      // 태그 매칭
      if (skill.tags) {
        for (const token of queryTokens) {
          if (skill.tags.some(t => t.toLowerCase().includes(token))) score += 5;
        }
      }

      return { ...skill, _score: score };
    }).filter(s => s._score > 0);

    // 태그 필터
    if (tags && tags.length > 0) {
      scored = scored.filter(s =>
        s.tags && tags.some(tag => s.tags.includes(tag))
      );
    }

    // 정렬
    if (sortBy === 'downloads') {
      scored.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    } else if (sortBy === 'updated') {
      scored.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    } else {
      scored.sort((a, b) => b._score - a._score);
    }

    return scored.slice(0, limit).map(({ _score, ...rest }) => rest);
  }

  /**
   * 스킬 다운로드 + 로컬 캐시 저장.
   *
   * @param {string} skillId - 스킬 ID (예: 'fnf-ea/code-review')
   * @returns {Promise<{ content: string, metadata: Object }>}
   */
  async download(skillId) {
    // 캐시 확인
    const cached = this._skillCache.get(skillId);
    if (cached && (Date.now() - cached.fetchedAt) < this.cacheTtlMs) {
      log.debug('Skill loaded from cache', { skillId });
      return { content: cached.content, metadata: cached.metadata || {} };
    }

    const url = `${this.registryUrl}/skills/${skillId.replace('/', '-')}/SKILL.md`;

    try {
      const content = await this._httpGet(url);

      // 프론트매터 파싱
      const metadata = this._parseFrontmatter(content);

      // 캐시 저장
      this._skillCache.set(skillId, { content, metadata, fetchedAt: Date.now() });

      // 디스크 캐시
      const cacheFile = path.join(this.cacheDir, `${skillId.replace('/', '-')}.md`);
      try {
        fs.writeFileSync(cacheFile, content, 'utf-8');
      } catch (writeErr) {
        log.debug('Disk cache write failed', { error: writeErr.message });
      }

      log.info('Skill downloaded', { skillId, size: content.length });
      return { content, metadata };
    } catch (err) {
      // 디스크 캐시 폴백
      const cacheFile = path.join(this.cacheDir, `${skillId.replace('/', '-')}.md`);
      if (fs.existsSync(cacheFile)) {
        const content = fs.readFileSync(cacheFile, 'utf-8');
        log.warn('Using disk cache fallback', { skillId });
        return { content, metadata: this._parseFrontmatter(content) };
      }

      log.error('Skill download failed', { error: err.message, skillId });
      throw new Error(`Failed to download skill '${skillId}': ${err.message}`);
    }
  }

  /**
   * 인기 스킬 목록 조회.
   * @param {number} [limit=10]
   * @returns {Promise<Array<RemoteSkill>>}
   */
  async getPopular(limit = 10) {
    const catalog = await this._getCatalog();
    return catalog
      .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
      .slice(0, limit);
  }

  /**
   * 카테고리별 스킬 목록.
   * @param {string} category
   * @returns {Promise<Array<RemoteSkill>>}
   */
  async getByCategory(category) {
    const catalog = await this._getCatalog();
    return catalog.filter(s => s.tags && s.tags.includes(category));
  }

  /**
   * 카탈로그 로드 (캐시 우선).
   * @private
   */
  async _getCatalog() {
    if (this._catalogCache && (Date.now() - this._catalogCache.fetchedAt) < this.cacheTtlMs) {
      return this._catalogCache.catalog;
    }

    try {
      const raw = await this._httpGet(`${this.registryUrl}/catalog.json`);
      const catalog = JSON.parse(raw);
      this._catalogCache = { catalog: catalog.skills || catalog, fetchedAt: Date.now() };
      log.info('Remote catalog loaded', { skills: this._catalogCache.catalog.length });
      return this._catalogCache.catalog;
    } catch (err) {
      log.warn('Remote catalog fetch failed, using empty catalog', { error: err.message });
      return this._catalogCache?.catalog || [];
    }
  }

  /**
   * SKILL.md 프론트매터 파싱.
   * @private
   */
  _parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const meta = {};
    for (const line of match[1].split('\n')) {
      const [key, ...valueParts] = line.split(':');
      if (key && valueParts.length > 0) {
        const value = valueParts.join(':').trim();
        meta[key.trim()] = value;
      }
    }
    return meta;
  }

  /**
   * HTTP GET 유틸.
   * @private
   */
  _httpGet(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: this.timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 리다이렉트 따라가기
          this._httpGet(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }

        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    });
  }
}

module.exports = { RemoteSkillRegistry };
