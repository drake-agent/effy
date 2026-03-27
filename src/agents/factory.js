/**
 * factory.js — 런타임 에이전트 생성 팩토리 + 프리셋 시스템.
 * 대화 중에 새 에이전트를 프리셋 기반으로 생성.
 *
 * Agent Factory with runtime preset system for creating agents on-the-fly.
 * Supports built-in presets and custom runtime registration.
 */
const { createLogger } = require('../shared/logger');
const { config } = require('../config');

const log = createLogger('agents:factory');

/**
 * 기본 에이전트 프리셋들
 * Built-in agent presets with configurations
 */
const BUILTIN_PRESETS = {
  'code-reviewer': {
    name: 'Code Reviewer',
    description: '코드 리뷰 전문가 - Pull Request, 코드 품질, 버그 분석',
    systemPrompt: 'You are a code review expert. Analyze code for quality, performance, security, and best practices. Provide constructive feedback.',
    tools: ['file-read', 'git-diff', 'syntax-check', 'linter'],
    tierRange: { min: 'tier2', max: 'tier3' },
    thinkingEffort: 'medium',
    identity: {
      role: 'code-reviewer',
      expertise: 'software-engineering',
    },
  },
  'researcher': {
    name: 'Researcher',
    description: '조사 전문가 - 정보 수집, 분석, 보고서 작성',
    systemPrompt: 'You are a research specialist. Gather information, analyze findings, and synthesize insights into comprehensive reports.',
    tools: ['web-search', 'database-query', 'data-analysis'],
    tierRange: { min: 'tier2', max: 'tier4' },
    thinkingEffort: 'high',
    identity: {
      role: 'researcher',
      expertise: 'research-analysis',
    },
  },
  'ops-monitor': {
    name: 'Operations Monitor',
    description: '운영 모니터 - 시스템 상태, 알림, 메트릭 수집',
    systemPrompt: 'You are an operations monitor. Track system health, collect metrics, and provide status updates.',
    tools: ['metrics-query', 'log-read', 'alert-check', 'status-report'],
    tierRange: { min: 'tier1', max: 'tier2' },
    thinkingEffort: 'low',
    identity: {
      role: 'ops-monitor',
      expertise: 'operations',
    },
  },
  'writer': {
    name: 'Writer',
    description: '작가 - 문서 작성, 블로그, 마크다운 콘텐츠',
    systemPrompt: 'You are a professional writer. Create well-structured, engaging content in multiple formats.',
    tools: ['file-write', 'template-render'],
    tierRange: { min: 'tier1', max: 'tier2' },
    thinkingEffort: 'medium',
    identity: {
      role: 'writer',
      expertise: 'content-creation',
    },
  },
  'translator': {
    name: 'Translator',
    description: '번역가 - 다국어 번역, 로컬라이제이션',
    systemPrompt: 'You are a professional translator. Translate content accurately while preserving tone and context.',
    tools: ['translate', 'terminology-check'],
    tierRange: { min: 'tier1', max: 'tier2' },
    thinkingEffort: 'low',
    identity: {
      role: 'translator',
      expertise: 'languages',
    },
  },
  'data-analyst': {
    name: 'Data Analyst',
    description: '데이터 분석가 - 데이터 쿼리, 시각화, 통계',
    systemPrompt: 'You are a data analyst. Query databases, perform statistical analysis, and create visualizations.',
    tools: ['sql-query', 'data-visualization', 'statistics', 'data-export'],
    tierRange: { min: 'tier2', max: 'tier3' },
    thinkingEffort: 'medium',
    identity: {
      role: 'data-analyst',
      expertise: 'data-science',
    },
  },
};

/**
 * AgentFactory — 런타임 에이전트 생성
 * Factory class for creating agent configurations from presets
 */
class AgentFactory {
  constructor(opts = {}) {
    /**
     * 등록된 프리셋들
     * @type {Map<string, Object>}
     */
    this.presets = new Map();

    /**
     * 생성된 에이전트 설정들 (세션 생명 주기)
     * @type {Map<string, Object>}
     */
    this.createdAgents = new Map();

    /**
     * 카운터 (고유 에이전트 ID 생성용)
     * @type {number}
     */
    this.agentCounter = 0;

    // 기본 프리셋 로드
    this._loadBuiltinPresets();

    // 설정 파일에서 커스텀 프리셋 로드
    this._loadConfigPresets();

    log.info('AgentFactory initialized', {
      builtinPresets: this.presets.size,
    });
  }

  /**
   * 기본 프리셋들을 메모리에 로드
   * Load built-in presets into memory
   *
   * @private
   */
  _loadBuiltinPresets() {
    for (const [key, preset] of Object.entries(BUILTIN_PRESETS)) {
      this.presets.set(key, { ...preset, _builtin: true });
    }
  }

  /**
   * 설정 파일(effy.config.yaml)에서 커스텀 프리셋 로드
   * Load custom presets from config file
   *
   * @private
   */
  _loadConfigPresets() {
    const agentPresets = config.agents?.presets || {};
    for (const [key, preset] of Object.entries(agentPresets)) {
      if (!this.presets.has(key)) {
        this.presets.set(key, { ...preset, _builtin: false });
        log.debug('Loaded custom preset from config', { preset: key });
      }
    }
  }

  /**
   * 프리셋에서 에이전트 생성
   * Create an agent configuration from a preset with optional overrides
   *
   * @param {string} presetName - 프리셋 이름 (e.g., 'code-reviewer')
   * @param {Object} [overrides={}] - 오버라이드 설정들
   * @returns {Object} 생성된 에이전트 설정 객체 (agentId, name, config 등)
   * @throws {Error} 프리셋을 찾을 수 없으면 에러
   */
  createAgent(presetName, overrides = {}) {
    const preset = this.presets.get(presetName);
    if (!preset) {
      const err = new Error(`Preset not found: ${presetName}`);
      log.error('Failed to create agent', err);
      throw err;
    }

    // 고유 에이전트 ID 생성
    const agentId = `${presetName}-${++this.agentCounter}`;

    // 프리셋 + 오버라이드 병합
    const agentConfig = {
      agentId,
      preset: presetName,
      name: overrides.name || preset.name,
      description: overrides.description || preset.description,
      systemPrompt: overrides.systemPrompt || preset.systemPrompt,
      tools: overrides.tools || preset.tools,
      tierRange: overrides.tierRange || preset.tierRange,
      thinkingEffort: overrides.thinkingEffort || preset.thinkingEffort,
      identity: overrides.identity
        ? { ...preset.identity, ...overrides.identity }
        : preset.identity,
      createdAt: new Date().toISOString(),
    };

    // 메모리에 저장
    this.createdAgents.set(agentId, agentConfig);

    log.info('Agent created from preset', {
      agentId,
      preset: presetName,
      overridesApplied: Object.keys(overrides).length > 0,
    });

    return agentConfig;
  }

  /**
   * 모든 사용 가능한 프리셋 목록 반환
   * List all available presets with descriptions
   *
   * @returns {Array<{ name: string, description: string, preset: string, builtin: boolean }>}
   */
  listPresets() {
    const list = [];
    for (const [key, preset] of this.presets) {
      list.push({
        preset: key,
        name: preset.name,
        description: preset.description,
        builtin: preset._builtin === true,
        tierRange: preset.tierRange,
        tools: preset.tools,
      });
    }
    return list;
  }

  /**
   * 런타임에 커스텀 프리셋 등록
   * Register a custom preset at runtime
   *
   * @param {string} name - 프리셋 이름 (e.g., 'my-custom-agent')
   * @param {Object} config - 프리셋 설정
   * @throws {Error} 이미 존재하는 프리셋이면 에러
   */
  registerPreset(name, config) {
    if (this.presets.has(name)) {
      const err = new Error(`Preset already exists: ${name}`);
      log.error('Failed to register preset', err);
      throw err;
    }

    const preset = {
      ...config,
      _builtin: false,
    };

    this.presets.set(name, preset);
    log.info('Custom preset registered', { preset: name });
  }

  /**
   * 프리셋 이름/설명 검색 (퍼지 매칭)
   * Search presets by name or description (fuzzy matching)
   *
   * @param {string} query - 검색어
   * @returns {Array<{ preset: string, name: string, description: string }>}
   */
  searchPresets(query) {
    const q = query.toLowerCase();
    const results = [];

    for (const [key, preset] of this.presets) {
      const nameMatch = preset.name.toLowerCase().includes(q);
      const descMatch = preset.description.toLowerCase().includes(q);
      const keyMatch = key.toLowerCase().includes(q);

      if (nameMatch || descMatch || keyMatch) {
        results.push({
          preset: key,
          name: preset.name,
          description: preset.description,
          matchScore: nameMatch ? 3 : keyMatch ? 2 : 1,
        });
      }
    }

    // 매치 스코어로 정렬
    results.sort((a, b) => b.matchScore - a.matchScore);
    return results;
  }

  /**
   * 단일 프리셋의 전체 설정 조회
   * Get a single preset's full configuration
   *
   * @param {string} name - 프리셋 이름
   * @returns {Object|null} 프리셋 설정 또는 null
   */
  getPreset(name) {
    return this.presets.get(name) || null;
  }

  /**
   * 생성된 에이전트 조회
   * Get a created agent configuration by agentId
   *
   * @param {string} agentId - 에이전트 ID
   * @returns {Object|null} 에이전트 설정 또는 null
   */
  getAgent(agentId) {
    return this.createdAgents.get(agentId) || null;
  }

  /**
   * 생성된 모든 에이전트 목록
   * List all created agents in this session
   *
   * @returns {Array<Object>} 생성된 에이전트들
   */
  listCreatedAgents() {
    return Array.from(this.createdAgents.values());
  }

  /**
   * 에이전트 설정 제거 (세션 종료 시)
   * Remove a created agent from memory
   *
   * @param {string} agentId - 에이전트 ID
   */
  removeAgent(agentId) {
    const removed = this.createdAgents.delete(agentId);
    if (removed) {
      log.debug('Agent removed from factory', { agentId });
    }
  }
}

module.exports = { AgentFactory, BUILTIN_PRESETS };
