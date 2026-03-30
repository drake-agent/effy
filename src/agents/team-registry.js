/**
 * team-registry.js — 팀 에이전트 발견 및 능력 등록.
 *
 * 각 에이전트의 capabilities, dataSources, 담당 channels를 등록하고
 * 질문 주제에 맞는 에이전트를 자동으로 찾아준다.
 *
 * 사용 예:
 * - registry.findByCapability('oncall')      → ['ops']
 * - registry.findByTopic('마케팅 Q1 일정')     → ['marketing', 'general']
 * - registry.getAgentProfile('ops')           → { capabilities, dataSources, status }
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('agents:team-registry');

/**
 * @typedef {Object} AgentProfile
 * @property {string} agentId
 * @property {string[]} capabilities - 에이전트가 처리 가능한 주제 키워드
 * @property {string[]} dataSources - 접근 가능한 데이터 소스 (pagerduty, jira, gdrive 등)
 * @property {string[]} channels - 담당 채널 목록
 * @property {string} description - 에이전트 설명 (사람이 읽을 수 있는)
 * @property {'online'|'offline'|'busy'} status
 * @property {number} lastActiveAt
 */

class TeamRegistry {
  constructor() {
    /** @type {Map<string, AgentProfile>} */
    this._agents = new Map();

    /** @type {Map<string, Set<string>>} — capability → Set<agentId> (역인덱스) */
    this._capabilityIndex = new Map();

    /** @type {Map<string, Set<string>>} — dataSource → Set<agentId> */
    this._dataSourceIndex = new Map();
  }

  /**
   * 에이전트 프로필 등록/갱신.
   *
   * @param {string} agentId
   * @param {Object} profile
   * @param {string[]} [profile.capabilities=[]]
   * @param {string[]} [profile.dataSources=[]]
   * @param {string[]} [profile.channels=[]]
   * @param {string} [profile.description='']
   */
  register(agentId, profile = {}) {
    const existing = this._agents.get(agentId);

    // 기존 인덱스 제거
    if (existing) {
      this._removeFromIndex(agentId, existing);
    }

    const entry = {
      agentId,
      capabilities: (profile.capabilities || []).map(c => c.toLowerCase()),
      dataSources: (profile.dataSources || []).map(d => d.toLowerCase()),
      channels: profile.channels || [],
      description: profile.description || '',
      status: 'online',
      lastActiveAt: Date.now(),
      registeredAt: existing ? existing.registeredAt : Date.now(),
    };

    this._agents.set(agentId, entry);
    this._buildIndex(agentId, entry);

    log.info('Agent registered', { agentId, capabilities: entry.capabilities.length });
  }

  /**
   * capability 키워드로 에이전트 검색.
   *
   * @param {string} capability
   * @returns {string[]} 매칭된 에이전트 ID 목록
   */
  findByCapability(capability) {
    const key = capability.toLowerCase();
    const exact = this._capabilityIndex.get(key);
    if (exact && exact.size > 0) {
      return Array.from(exact).filter(id => this._agents.get(id)?.status !== 'offline');
    }

    // 부분 매칭 폴백 — "schedule" → "schedules", "scheduling" 등
    const results = new Set();
    for (const [cap, agents] of this._capabilityIndex) {
      if (cap.includes(key) || key.includes(cap)) {
        for (const a of agents) {
          if (this._agents.get(a)?.status !== 'offline') results.add(a);
        }
      }
    }
    return Array.from(results);
  }

  /**
   * 자유 텍스트 주제로 에이전트 검색 (keyword splitting + scoring).
   *
   * @param {string} topic - 자연어 질문/주제
   * @returns {Array<{ agentId: string, score: number, matchedOn: string[] }>}
   */
  findByTopic(topic) {
    if (!topic || topic.trim().length === 0) return [];

    const words = topic.toLowerCase().split(/[\s,.\-_/]+/).filter(w => w.length > 1);
    const scores = new Map(); // agentId → { score, matchedOn }

    for (const word of words) {
      // capability 매칭
      for (const [cap, agents] of this._capabilityIndex) {
        if (cap.includes(word) || word.includes(cap)) {
          for (const agentId of agents) {
            if (this._agents.get(agentId)?.status === 'offline') continue;
            if (!scores.has(agentId)) scores.set(agentId, { score: 0, matchedOn: [] });
            const entry = scores.get(agentId);
            entry.score += cap === word ? 3 : 1; // 정확 매칭 가산
            if (!entry.matchedOn.includes(cap)) entry.matchedOn.push(cap);
          }
        }
      }

      // dataSource 매칭
      for (const [ds, agents] of this._dataSourceIndex) {
        if (ds.includes(word) || word.includes(ds)) {
          for (const agentId of agents) {
            if (this._agents.get(agentId)?.status === 'offline') continue;
            if (!scores.has(agentId)) scores.set(agentId, { score: 0, matchedOn: [] });
            const entry = scores.get(agentId);
            entry.score += 2;
            if (!entry.matchedOn.includes(ds)) entry.matchedOn.push(ds);
          }
        }
      }

      // description 매칭
      for (const [agentId, profile] of this._agents) {
        if (profile.status === 'offline') continue;
        if (profile.description.toLowerCase().includes(word)) {
          if (!scores.has(agentId)) scores.set(agentId, { score: 0, matchedOn: [] });
          scores.get(agentId).score += 0.5;
        }
      }
    }

    return Array.from(scores.entries())
      .map(([agentId, { score, matchedOn }]) => ({ agentId, score, matchedOn }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 에이전트 프로필 조회.
   * @param {string} agentId
   * @returns {AgentProfile|null}
   */
  getAgentProfile(agentId) {
    return this._agents.get(agentId) || null;
  }

  /**
   * 모든 등록된 에이전트 목록.
   * @returns {Array<AgentProfile>}
   */
  listAgents() {
    return Array.from(this._agents.values());
  }

  /**
   * 에이전트 상태 업데이트.
   * @param {string} agentId
   * @param {'online'|'offline'|'busy'} status
   */
  setStatus(agentId, status) {
    const profile = this._agents.get(agentId);
    if (profile) {
      profile.status = status;
      profile.lastActiveAt = Date.now();
    }
  }

  /**
   * 에이전트 활동 기록 (heartbeat).
   * @param {string} agentId
   */
  touch(agentId) {
    const profile = this._agents.get(agentId);
    if (profile) {
      profile.lastActiveAt = Date.now();
      if (profile.status === 'offline') profile.status = 'online';
    }
  }

  /**
   * 설정에서 레지스트리 초기화.
   * @param {Array<Object>} agentConfigs - [{ id, capabilities, dataSources, channels, description }]
   */
  loadFromConfig(agentConfigs = []) {
    for (const cfg of agentConfigs) {
      this.register(cfg.id || cfg.agentId, cfg);
    }
    log.info('TeamRegistry loaded from config', { agents: this._agents.size });
  }

  // ─── Internal ───

  /** @private */
  _buildIndex(agentId, entry) {
    for (const cap of entry.capabilities) {
      if (!this._capabilityIndex.has(cap)) this._capabilityIndex.set(cap, new Set());
      this._capabilityIndex.get(cap).add(agentId);
    }
    for (const ds of entry.dataSources) {
      if (!this._dataSourceIndex.has(ds)) this._dataSourceIndex.set(ds, new Set());
      this._dataSourceIndex.get(ds).add(agentId);
    }
  }

  /** @private */
  _removeFromIndex(agentId, entry) {
    for (const cap of entry.capabilities) {
      const set = this._capabilityIndex.get(cap);
      if (set) { set.delete(agentId); if (set.size === 0) this._capabilityIndex.delete(cap); }
    }
    for (const ds of entry.dataSources) {
      const set = this._dataSourceIndex.get(ds);
      if (set) { set.delete(agentId); if (set.size === 0) this._dataSourceIndex.delete(ds); }
    }
  }
}

// ─── 싱글톤 ─────────────────────────────────────────

let _instance = null;

function getTeamRegistry() {
  if (!_instance) _instance = new TeamRegistry();
  return _instance;
}

function resetTeamRegistry() {
  _instance = null;
}

module.exports = { TeamRegistry, getTeamRegistry, resetTeamRegistry };
