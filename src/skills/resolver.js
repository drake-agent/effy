/**
 * resolver.js — Skill Resolver.
 *
 * GitHub에서 SKILL.md를 다운로드하고 로컬 캐시에 저장.
 * 캐시 히트 시 네트워크 요청 생략 (TTL 기반).
 *
 * 다운로드 순서:
 * 1. {repo}/{path}/SKILL.md (공식 skills 레포 구조)
 * 2. {repo}/SKILL.md (단일 스킬 레포)
 * 3. {repo}/README.md (fallback)
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../shared/logger');

const log = createLogger('skills:resolver');

const DEFAULT_CACHE_DIR = './data/skills-cache';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024; // 2MB — SKILL.md 최대 크기

class SkillResolver {
  /**
   * @param {object} options
   * @param {string} options.cacheDir — 캐시 디렉터리
   * @param {number} options.cacheTtlMs — 캐시 TTL (밀리초)
   * @param {number} options.timeoutMs — 다운로드 타임아웃
   */
  constructor(options = {}) {
    this.cacheDir = path.resolve(options.cacheDir || DEFAULT_CACHE_DIR);
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? 15000;

    // 캐시 디렉터리 생성
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * BUG-1 fix: skillId → 안전한 파일명 변환.
   * path traversal(../) 및 특수문자 방어.
   * @param {string} skillId
   * @returns {string}
   */
  _safeFileName(skillId) {
    const raw = String(skillId);
    // 원본에서 path traversal 패턴 거부
    if (!raw || raw === '.' || raw === '..' || /[/\\]/.test(raw) || /\.\./.test(raw)) {
      throw new Error(`Invalid skillId: ${skillId}`);
    }
    // 알파벳, 숫자, 하이픈, 언더스코어만 허용
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (!safe) {
      throw new Error(`Invalid skillId: ${skillId}`);
    }
    return safe;
  }

  /**
   * 스킬 SKILL.md를 resolve (캐시 → 다운로드).
   * @param {string} skillId — 스킬 ID
   * @param {string} repo — GitHub repo (owner/repo)
   * @param {string} skillPath — 레포 내 경로 (e.g. 'skills/docx')
   * @returns {Promise<string|null>} — SKILL.md 텍스트 또는 null
   */
  async resolve(skillId, repo, skillPath = '.') {
    // 1. 캐시 확인
    const cached = this._readCache(skillId);
    if (cached) {
      log.info('Cache hit', { skillId });
      return cached;
    }

    // 2. GitHub에서 다운로드 시도
    const content = await this._downloadSkill(repo, skillPath);
    if (content) {
      this._writeCache(skillId, content);
      log.info('Downloaded and cached', { skillId, repo });
      return content;
    }

    log.warn('Resolve failed', { skillId, repo });
    return null;
  }

  /**
   * 캐시에서 직접 읽기 (TTL 무시).
   * @param {string} skillId
   * @returns {string|null}
   */
  getCached(skillId) {
    const safe = this._safeFileName(skillId);
    const filePath = path.join(this.cacheDir, `${safe}.md`);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * 특정 스킬 캐시 삭제.
   * @param {string} skillId
   */
  evict(skillId) {
    const safe = this._safeFileName(skillId);
    const filePath = path.join(this.cacheDir, `${safe}.md`);
    const metaPath = path.join(this.cacheDir, `${safe}.meta.json`);
    try { fs.unlinkSync(filePath); } catch (_) {}
    try { fs.unlinkSync(metaPath); } catch (_) {}
  }

  /**
   * 전체 캐시 삭제.
   */
  clearCache() {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const f of files) {
        fs.unlinkSync(path.join(this.cacheDir, f));
      }
    } catch (_) {}
  }

  // ─── 내부 ─────────────────────────────────────────

  _readCache(skillId) {
    const safe = this._safeFileName(skillId);
    const filePath = path.join(this.cacheDir, `${safe}.md`);
    const metaPath = path.join(this.cacheDir, `${safe}.meta.json`);

    if (!fs.existsSync(filePath) || !fs.existsSync(metaPath)) return null;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const age = Date.now() - (meta.cachedAt || 0);
      if (age > this.cacheTtlMs) {
        log.info('Cache expired', { skillId, ageMs: age });
        return null;
      }
      return fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      return null;
    }
  }

  _writeCache(skillId, content) {
    const safe = this._safeFileName(skillId);
    const filePath = path.join(this.cacheDir, `${safe}.md`);
    const metaPath = path.join(this.cacheDir, `${safe}.meta.json`);
    fs.writeFileSync(filePath, content, 'utf-8');
    fs.writeFileSync(metaPath, JSON.stringify({ cachedAt: Date.now(), skillId }), 'utf-8');
  }

  /**
   * GitHub raw content에서 SKILL.md 다운로드.
   * 시도 순서:
   * 1. {path}/SKILL.md
   * 2. SKILL.md (루트)
   * 3. README.md (fallback)
   */
  async _downloadSkill(repo, skillPath) {
    const base = `https://raw.githubusercontent.com/${repo}/main`;
    const candidates = [];

    if (skillPath && skillPath !== '.') {
      candidates.push(`${base}/${skillPath}/SKILL.md`);
    }
    candidates.push(`${base}/SKILL.md`);
    candidates.push(`${base}/README.md`);

    for (const url of candidates) {
      try {
        const content = await this._fetch(url);
        if (content && content.length > 50) {
          return content;
        }
      } catch (e) {
        log.info('Download attempt failed', { url, error: e.message });
      }
    }

    return null;
  }

  async _fetch(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Effy-SkillResolver/1.0' },
      });
      if (!res.ok) return null;

      // WARN-1 fix: Content-Length 사전 검증 + 스트리밍 크기 제한
      const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
      if (contentLength > MAX_DOWNLOAD_BYTES) {
        log.warn('Download rejected: too large', { url, bytes: contentLength, max: MAX_DOWNLOAD_BYTES });
        return null;
      }

      const text = await res.text();
      if (text.length > MAX_DOWNLOAD_BYTES) {
        log.warn('Downloaded content exceeds limit', { url, bytes: text.length, max: MAX_DOWNLOAD_BYTES });
        return null;
      }
      return text;
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new Error(`Timeout: ${this.timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { SkillResolver };
