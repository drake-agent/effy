/**
 * registry.js — Skill Registry 싱글톤.
 *
 * 에이전트가 스킬을 검색, 설치, 활성화하는 진입점.
 *
 * 생명주기:
 * 1. init(config) — 카탈로그 로드 + pre-install 스킬 설치 + 로컬 스킬 복원
 * 2. search(query) — 카탈로그 검색
 * 3. install(skillId) — GitHub에서 다운로드 + 캐시
 * 4. registerLocal(skillId, rawSkillMd) — 대화형 스킬 빌더로 생성한 스킬 등록
 * 5. activate(skillId) — 파싱된 지시문 반환 (system prompt 주입용)
 * 6. getActiveSkills(agentId) — 에이전트에 활성화된 스킬 목록
 *
 * 도구:
 * - search_skills: 카탈로그 검색
 * - install_skill: 스킬 설치 (다운로드)
 * - create_skill: 대화형 스킬 빌더 (LLM으로 SKILL.md 생성 → 즉시 등록)
 * - list_skills: 설치된 스킬 목록
 * - activate_skill: 스킬 활성화 (에이전트 컨텍스트 주입)
 */
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../shared/logger');
const { searchCatalog, getCatalogEntry, getFullCatalog } = require('./catalog');
const { SkillResolver } = require('./resolver');
const { parseSkillMd, formatSkillPrompt } = require('./loader');

const LOCAL_SKILLS_DIR = './data/skills-local';

const log = createLogger('skills:registry');

class SkillRegistry {
  constructor() {
    this.resolver = null;
    this.initialized = false;

    /** @type {Map<string, { meta: object, body: string, installedAt: number }>} */
    this.installed = new Map();

    /** @type {Map<string, Set<string>>} — agentId → Set<skillId> */
    this.activeSkills = new Map();

    /** @type {Map<string, Promise>} — WARN-2 fix: 동시 install dedup */
    this._pendingInstalls = new Map();
  }

  /**
   * 레지스트리 초기화.
   * @param {object} config — config.skills 섹션
   */
  async init(config = {}) {
    if (this.initialized) {
      log.warn('Already initialized');
      return;
    }

    this.resolver = new SkillResolver({
      cacheDir: config.cacheDir,
      cacheTtlMs: config.cacheTtlMs,
      timeoutMs: config.timeoutMs,
    });

    // pre-install 스킬 (config에서 지정)
    const preInstall = config.preInstall || [];
    if (preInstall.length > 0) {
      log.info('Pre-installing skills', { count: preInstall.length });
      const results = await Promise.allSettled(
        preInstall.map(id => this.install(id))
      );
      const ok = results.filter(r => r.status === 'fulfilled' && r.value).length;
      const fail = results.length - ok;
      log.info('Pre-install complete', { ok, fail });
    }

    // 로컬 스킬 복원 (대화형 빌더로 생성된 스킬)
    this._restoreLocalSkills();

    // 에이전트별 기본 활성 스킬
    const agentSkills = config.agentSkills || {};
    for (const [agentId, skillIds] of Object.entries(agentSkills)) {
      for (const sid of skillIds) {
        this.activateFor(agentId, sid);
      }
    }

    this.initialized = true;
    log.info('SkillRegistry ready', { installed: this.installed.size });
  }

  /**
   * 카탈로그 검색.
   * @param {string} query — 검색 키워드
   * @param {object} options — { category, source, limit }
   * @returns {Array}
   */
  search(query, options = {}) {
    const results = searchCatalog(query, options);
    // 설치 상태 표시
    return results.map(s => ({
      ...s,
      installed: this.installed.has(s.id),
    }));
  }

  /**
   * 스킬 설치 (다운로드 + 파싱).
   * @param {string} skillId
   * @returns {Promise<{ success: boolean, meta?: object, error?: string }>}
   */
  async install(skillId) {
    // 이미 설치됨
    if (this.installed.has(skillId)) {
      return { success: true, meta: this.installed.get(skillId).meta, already: true };
    }

    // WARN-2 fix: 동일 skillId 동시 다운로드 방지
    if (this._pendingInstalls.has(skillId)) {
      return this._pendingInstalls.get(skillId);
    }

    const installPromise = this._doInstall(skillId);
    this._pendingInstalls.set(skillId, installPromise);
    try {
      return await installPromise;
    } finally {
      this._pendingInstalls.delete(skillId);
    }
  }

  /** @private — 실제 설치 로직 (dedup 래퍼에서 호출) */
  async _doInstall(skillId) {
    // 카탈로그에서 조회
    const entry = getCatalogEntry(skillId);
    if (!entry) {
      return { success: false, error: `카탈로그에 없음: ${skillId}. search_skills로 검색하세요.` };
    }

    if (!this.resolver) {
      return { success: false, error: 'SkillRegistry 미초기화. init()을 먼저 호출하세요.' };
    }

    // 다운로드
    const raw = await this.resolver.resolve(skillId, entry.repo, entry.path);
    if (!raw) {
      return { success: false, error: `다운로드 실패: ${entry.repo}/${entry.path}` };
    }

    // 파싱
    const parsed = parseSkillMd(raw);
    if (!parsed.body) {
      return { success: false, error: `SKILL.md 파싱 실패: body가 비어있음` };
    }

    // 카탈로그 메타 + 파싱 메타 병합
    const meta = {
      id: skillId,
      name: parsed.meta.name || entry.name,
      description: parsed.meta.description || entry.description,
      category: entry.category,
      source: entry.source,
      repo: entry.repo,
      tags: entry.tags,
    };

    this.installed.set(skillId, {
      meta,
      body: parsed.body,
      installedAt: Date.now(),
    });

    log.info('Installed', { skillId, name: meta.name });
    return { success: true, meta };
  }

  /**
   * 스킬 제거.
   * @param {string} skillId
   */
  uninstall(skillId) {
    this.installed.delete(skillId);
    // 모든 에이전트에서 비활성화
    for (const active of this.activeSkills.values()) {
      active.delete(skillId);
    }
    if (this.resolver) {
      this.resolver.evict(skillId);
    }
    // 로컬 스킬이면 디스크에서도 삭제
    this._deleteLocalSkill(skillId);
    log.info('Uninstalled', { skillId });
  }

  // ═══════════════════════════════════════════════════════
  // 대화형 스킬 빌더 — 로컬 스킬 등록/관리
  // ═══════════════════════════════════════════════════════

  /**
   * 로컬 스킬 등록 (대화형 빌더에서 생성한 SKILL.md를 직접 등록).
   * GitHub 다운로드 없이 메모리 + 디스크에 즉시 저장.
   *
   * @param {string} skillId  - 스킬 ID (예: "dashboard-summary")
   * @param {string} rawSkillMd - SKILL.md 원본 텍스트 (frontmatter + body)
   * @param {object} options
   * @param {string} options.category   - 카테고리 (기본 'custom')
   * @param {string[]} options.tags     - 태그 배열
   * @param {string} options.createdBy  - 생성자 (userId 또는 agentId)
   * @returns {{ success: boolean, meta?: object, error?: string }}
   */
  registerLocal(skillId, rawSkillMd, options = {}) {
    if (!skillId || typeof skillId !== 'string') {
      return { success: false, error: 'skillId가 필요합니다.' };
    }
    if (!rawSkillMd || typeof rawSkillMd !== 'string' || rawSkillMd.trim().length < 20) {
      return { success: false, error: 'SKILL.md 내용이 너무 짧습니다 (최소 20자).' };
    }

    // ID 정규화: 알파벳, 숫자, 하이픈만 허용
    const safeId = skillId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!safeId) {
      return { success: false, error: `유효하지 않은 skillId: ${skillId}` };
    }

    // 이미 같은 ID로 설치된 스킬이 있으면 덮어쓰기
    const overwrite = this.installed.has(safeId);

    // 파싱
    const parsed = parseSkillMd(rawSkillMd);
    if (!parsed.body) {
      return { success: false, error: 'SKILL.md 파싱 실패: body가 비어있음. frontmatter(---) 이후에 본문이 필요합니다.' };
    }

    const meta = {
      id: safeId,
      name: parsed.meta.name || safeId,
      description: parsed.meta.description || options.description || '',
      category: options.category || parsed.meta.category || 'custom',
      source: 'local',
      tags: options.tags || (parsed.meta.tags ? (Array.isArray(parsed.meta.tags) ? parsed.meta.tags : [parsed.meta.tags]) : []),
      createdBy: options.createdBy || 'conversation',
    };

    this.installed.set(safeId, {
      meta,
      body: parsed.body,
      installedAt: Date.now(),
    });

    // 디스크에 영구 저장
    this._saveLocalSkill(safeId, rawSkillMd, meta);

    log.info('Local skill registered', { skillId: safeId, name: meta.name, overwrite });
    return { success: true, meta, overwrite };
  }

  /** @private — 로컬 스킬을 디스크에 저장 */
  _saveLocalSkill(skillId, rawSkillMd, meta) {
    try {
      const dir = path.resolve(LOCAL_SKILLS_DIR);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const skillDir = path.join(dir, skillId);
      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rawSkillMd, 'utf-8');
      fs.writeFileSync(path.join(skillDir, 'meta.json'), JSON.stringify({
        ...meta,
        savedAt: Date.now(),
      }, null, 2), 'utf-8');
    } catch (err) {
      log.warn('Failed to save local skill to disk', { skillId, error: err.message });
    }
  }

  /** @private — 디스크에서 로컬 스킬 삭제 */
  _deleteLocalSkill(skillId) {
    try {
      const skillDir = path.resolve(LOCAL_SKILLS_DIR, skillId);
      if (fs.existsSync(skillDir)) {
        const files = fs.readdirSync(skillDir);
        for (const f of files) {
          fs.unlinkSync(path.join(skillDir, f));
        }
        fs.rmdirSync(skillDir);
        log.info('Local skill deleted from disk', { skillId });
      }
    } catch (_) { /* best-effort */ }
  }

  /** @private — 앱 시작 시 디스크의 로컬 스킬 복원 */
  _restoreLocalSkills() {
    try {
      const dir = path.resolve(LOCAL_SKILLS_DIR);
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let restored = 0;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillId = entry.name;
        const skillMdPath = path.join(dir, skillId, 'SKILL.md');
        const metaPath = path.join(dir, skillId, 'meta.json');

        if (!fs.existsSync(skillMdPath)) continue;

        try {
          const rawSkillMd = fs.readFileSync(skillMdPath, 'utf-8');
          const parsed = parseSkillMd(rawSkillMd);
          if (!parsed.body) continue;

          let meta = { id: skillId, name: skillId, source: 'local', category: 'custom' };
          if (fs.existsSync(metaPath)) {
            try {
              meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf-8')) };
            } catch (_) {}
          }

          this.installed.set(skillId, {
            meta,
            body: parsed.body,
            installedAt: meta.savedAt || Date.now(),
          });
          restored++;
        } catch (err) {
          log.warn('Failed to restore local skill', { skillId, error: err.message });
        }
      }

      if (restored > 0) {
        log.info('Local skills restored', { count: restored });
      }
    } catch (_) { /* data/skills-local/ 없으면 무시 */ }
  }

  /**
   * 에이전트에 스킬 활성화.
   * @param {string} agentId
   * @param {string} skillId
   * @returns {boolean}
   */
  activateFor(agentId, skillId) {
    if (!this.activeSkills.has(agentId)) {
      this.activeSkills.set(agentId, new Set());
    }
    this.activeSkills.get(agentId).add(skillId);
    return true;
  }

  /**
   * 에이전트에서 스킬 비활성화.
   * @param {string} agentId
   * @param {string} skillId
   */
  deactivateFor(agentId, skillId) {
    const active = this.activeSkills.get(agentId);
    if (active) active.delete(skillId);
  }

  /**
   * 에이전트에 활성화된 스킬 지시문 반환 (system prompt 주입용).
   * @param {string} agentId
   * @returns {string} — 스킬 지시문 결합 텍스트
   */
  getSkillPrompts(agentId) {
    const skillIds = this.activeSkills.get(agentId);
    if (!skillIds || skillIds.size === 0) return '';

    const prompts = [];
    for (const sid of skillIds) {
      const skill = this.installed.get(sid);
      if (skill) {
        prompts.push(formatSkillPrompt(sid, { meta: skill.meta, body: skill.body }));
      }
    }

    if (prompts.length === 0) return '';
    return `<active_skills>\n${prompts.join('\n\n')}\n</active_skills>`;
  }

  /**
   * 설치된 스킬 목록.
   * @param {string} agentId — (선택) 에이전트별 활성 상태 표시
   * @returns {Array}
   */
  listInstalled(agentId) {
    const activeSet = agentId ? (this.activeSkills.get(agentId) || new Set()) : new Set();
    const list = [];
    for (const [id, skill] of this.installed) {
      list.push({
        id,
        name: skill.meta.name,
        description: skill.meta.description,
        category: skill.meta.category,
        source: skill.meta.source,
        active: activeSet.has(id),
        installedAt: new Date(skill.installedAt).toISOString(),
      });
    }
    return list;
  }

  /**
   * 카탈로그 카테고리 목록.
   * @returns {Array<string>}
   */
  getCategories() {
    const cats = new Set(getFullCatalog().map(s => s.category));
    return [...cats].sort();
  }

  async destroy() {
    this.installed.clear();
    this.activeSkills.clear();
    this._pendingInstalls.clear();
    this.initialized = false;
    log.info('SkillRegistry destroyed');
  }
}

// ─── 싱글톤 ─────────────────────────────────────────

let _instance = null;

function getSkillRegistry() {
  if (!_instance) {
    _instance = new SkillRegistry();
  }
  return _instance;
}

function resetSkillRegistry() {
  if (_instance) {
    _instance.destroy().catch(() => {});
    _instance = null;
  }
}

module.exports = { SkillRegistry, getSkillRegistry, resetSkillRegistry };
