/**
 * model-router.js — 4-Tier Agent-Level Model Routing.
 *
 * v3.6.2: 에이전트별 tier range + 4단계 복잡도 기반 동적 모델 선택.
 *
 * 모델 Tier 체계:
 *   tier1: Haiku     — 빠른 응답, 단순 질의
 *   tier2: Sonnet    — 균형잡힌 추론, 코딩
 *   tier3: Opus      — 깊은 추론, 전략적 분석
 *   tier4: Opus+ET   — Extended Thinking, 최고 수준 추론
 *
 * 라우팅 5단계:
 *   Stage 1: Agent config → tier range 결정 (min ~ max)
 *   Stage 2: 프로세스 타입 기본값 (에이전트 config 없을 때 폴백)
 *   Stage 3: 복잡도 분석 → LIGHT / STANDARD / HEAVY / CRITICAL → tier 매핑
 *   Stage 4: tier → 실제 모델 ID 해석
 *   Stage 5: Fallback — deprioritized 모델 대체
 */
const { config } = require('../config');
const { getTierDefinitions } = require('../shared/model-config');

// ─── 복잡도 감지 키워드 ───

const COMPLEXITY_TECH_KEYWORDS = [
  'api', 'function', 'class', 'error', 'bug', 'deploy', 'merge',
  'pr', 'database', 'schema', 'migration', 'auth', 'token',
  '배포', '코드', '에러', '버그',
];

const COMPLEXITY_CRITICAL_KEYWORDS = [
  'architecture', 'system design', 'trade-off', 'tradeoff', 'okr',
  'roadmap', 'postmortem', 'post-mortem', 'rfc', 'design doc',
  'migration plan', '아키텍처', '설계', '로드맵', '포스트모템',
  '의사결정', '전략', '트레이드오프', '마이그레이션',
];

// ─── Tier 순서 ───

const TIER_ORDER = ['tier1', 'tier2', 'tier3', 'tier4'];

class ModelRouter {
  constructor() {
    const routerCfg = config.modelRouter || {};
    const anthropicCfg = config.anthropic || {};

    // Tier 정의는 공통 유틸에서 해석해 drift를 방지한다.
    this.tierDefs = getTierDefinitions(anthropicCfg);

    // 프로세스 타입 기본 (tier 이름 또는 모델 ID)
    this.processDefaults = routerCfg.processDefaults || {
      channel: 'tier1',
      worker: 'tier1',
      indexer: 'tier1',
    };

    // 에이전트별 model config 캐시 (init 시 빌드)
    this.agentModels = this._buildAgentModelMap();

    // 복잡도 승격 활성화 여부
    this.complexityUpgrade = routerCfg.complexityUpgrade !== false;

    // Fallback chain (tier 이름 기반)
    this.fallbacks = routerCfg.fallbacks || {
      tier4: ['tier3', 'tier2', 'tier1'],
      tier3: ['tier2', 'tier1'],
      tier2: ['tier1'],
      tier1: [],
    };

    this.deprioritizeCooldownMs = routerCfg.deprioritizeCooldownMs || 900000;

    /** @type {Map<string, number>} modelId → deprioritizedUntil timestamp */
    this._deprioritized = new Map();
  }

  /**
   * 5단계 라우팅.
   *
   * @param {{ processType: string, agentId: string, functionType: string, text: string }} params
   * @returns {{ model: string, tier: string, budgetHint: string, extendedThinking: object|null }}
   */
  route({ processType, agentId, functionType, text }) {
    // Stage 1: Agent config → tier range
    const agentModel = this.agentModels.get(agentId);
    let minTier, maxTier;

    if (agentModel) {
      minTier = agentModel.minTier;
      maxTier = agentModel.maxTier;
    } else {
      // Stage 2: 에이전트 config 없으면 processDefaults 사용
      const defaultTier = this.processDefaults[processType] || 'tier1';
      minTier = defaultTier;
      maxTier = defaultTier;
    }

    // Stage 3: 복잡도 분석 → 범위 내에서 tier 선택
    const complexity = this._analyzeComplexity(text);
    let selectedTier;

    if (!this.complexityUpgrade) {
      selectedTier = minTier;
    } else {
      selectedTier = this._mapComplexityToTier(complexity, minTier, maxTier);
    }

    // Budget hint
    const budgetHint = this._complexityToBudget(complexity);

    // Stage 4: tier → 실제 모델 정보 해석
    // Stage 5: Fallback — deprioritized 모델이면 대체
    const resolvedTier = this._getAvailableTier(selectedTier);
    const resolvedDef = this.tierDefs[resolvedTier] || this.tierDefs.tier1;
    const modelId = resolvedDef.id;

    // Extended Thinking 정보
    const extendedThinking = resolvedDef.extendedThinking && resolvedDef.extendedThinking.enabled
      ? resolvedDef.extendedThinking
      : null;

    // maxTokens: tier별 설정값, 없으면 전역 config fallback
    const configuredTierDef = config.anthropic?.models?.[resolvedTier];
    const maxTokens = configuredTierDef
      ? (configuredTierDef.maxTokens || config.anthropic?.maxTokens || 4096)
      : (resolvedDef.maxTokens || config.anthropic?.maxTokens || 4096);

    return {
      model: modelId,
      tier: resolvedTier,
      maxTokens,
      budgetHint,
      extendedThinking,
    };
  }

  /** 모델 에러 기록 → deprioritize. */
  recordModelError(model) {
    this._deprioritized.set(model, Date.now() + this.deprioritizeCooldownMs);
  }

  /** tier 기반 fallback: deprioritized 모델이면 하위 tier로 이동. */
  _getAvailableTier(preferredTier) {
    const def = this.tierDefs[preferredTier];
    if (!def) return 'tier1';

    const until = this._deprioritized.get(def.id);
    if (!until || until <= Date.now()) {
      if (until) this._deprioritized.delete(def.id);
      return preferredTier;
    }

    // Fallback chain 순회
    const chain = this.fallbacks[preferredTier] || [];
    for (const fbTier of chain) {
      const fbDef = this.tierDefs[fbTier];
      if (!fbDef) continue;
      const fbUntil = this._deprioritized.get(fbDef.id);
      if (!fbUntil || fbUntil <= Date.now()) {
        return fbTier;
      }
    }
    return preferredTier; // 모든 fallback도 deprioritized → 원래 tier
  }

  /**
   * 텍스트 복잡도 분석 — 4단계.
   * @returns {'LIGHT'|'STANDARD'|'HEAVY'|'CRITICAL'}
   */
  _analyzeComplexity(text) {
    if (!text) return 'STANDARD';
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // LIGHT: 10단어 이하 + 인사/감사/확인 패턴
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount <= 10) {
      if (/^(안녕|hi|hello|hey|thanks|감사|고마워|네|ㅇㅇ|ok|확인|ㅎㅇ|ㄳ|ㄱㅅ)/i.test(trimmed)) {
        return 'LIGHT';
      }
    }

    // CRITICAL: 아키텍처/전략 키워드 2개+ 또는 명시적 "깊이 분석" 요청
    const criticalCount = COMPLEXITY_CRITICAL_KEYWORDS.filter(k => lower.includes(k)).length;
    if (criticalCount >= 2) return 'CRITICAL';
    if (/깊이\s*분석|심층\s*분석|deep\s*analysis|thorough|comprehensive/i.test(trimmed)) return 'CRITICAL';

    // HEAVY: 코드블록, 3문장+기술키워드 5+
    const hasCodeBlock = trimmed.includes('`');
    const sentenceCount = trimmed.split(/[.!?\n]/).filter(s => s.trim().length > 0).length;
    const techKeywordCount = COMPLEXITY_TECH_KEYWORDS.filter(k => lower.includes(k)).length;

    if (hasCodeBlock || (sentenceCount >= 3 && techKeywordCount >= 5)) return 'HEAVY';

    return 'STANDARD';
  }

  /**
   * 복잡도 → tier range 내에서 적절한 tier 선택.
   *
   * range가 [tier1, tier3]이면:
   *   LIGHT    → tier1 (min)
   *   STANDARD → tier1 (min)
   *   HEAVY    → tier2 (중간, 또는 min+1)
   *   CRITICAL → tier3 (max)
   */
  _mapComplexityToTier(complexity, minTier, maxTier) {
    const minIdx = TIER_ORDER.indexOf(minTier);
    const maxIdx = TIER_ORDER.indexOf(maxTier);

    if (minIdx === -1 || maxIdx === -1 || minIdx >= maxIdx) {
      // 범위가 1개이거나 잘못된 경우 → min 반환
      return minTier;
    }

    const span = maxIdx - minIdx; // 사용 가능 tier 수 - 1

    switch (complexity) {
      case 'LIGHT':
        return TIER_ORDER[minIdx];
      case 'STANDARD':
        return TIER_ORDER[minIdx];
      case 'HEAVY':
        // 범위의 중간 tier (올림)
        return TIER_ORDER[minIdx + Math.ceil(span / 2)];
      case 'CRITICAL':
        return TIER_ORDER[maxIdx];
      default:
        return TIER_ORDER[minIdx];
    }
  }

  /** 복잡도 → budget hint 매핑. */
  _complexityToBudget(complexity) {
    switch (complexity) {
      case 'LIGHT': return 'LIGHT';
      case 'STANDARD': return 'STANDARD';
      case 'HEAVY': return 'DEEP';
      case 'CRITICAL': return 'DEEP';
      default: return 'STANDARD';
    }
  }

  /** agents.list에서 model.range 정보를 Map으로 빌드. */
  _buildAgentModelMap() {
    const map = new Map();
    const agents = config.agents?.list || [];

    for (const agent of agents) {
      if (!agent.model || !agent.model.range) continue;

      const range = agent.model.range;
      if (!Array.isArray(range) || range.length !== 2) continue;

      const [minTier, maxTier] = range;
      if (TIER_ORDER.indexOf(minTier) === -1 || TIER_ORDER.indexOf(maxTier) === -1) continue;

      map.set(agent.id, { minTier, maxTier });
    }

    return map;
  }

  /** 현재 tier 정의 조회 (외부 참조용). */
  getTierDefs() {
    return { ...this.tierDefs };
  }

  /** 에이전트별 모델 범위 조회 (외부 참조용). */
  getAgentModelRange(agentId) {
    return this.agentModels.get(agentId) || null;
  }

  /** tier 이름으로 모델 ID 조회. */
  resolveModelId(tier) {
    const def = this.tierDefs[tier];
    return def ? def.id : null;
  }
}

module.exports = { ModelRouter };
