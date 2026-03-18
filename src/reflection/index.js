/**
 * reflection/index.js — Self-Improvement 모듈 진입점.
 *
 * 5개 컴포넌트를 싱글톤으로 관리:
 * 1. ReflectionEngine  — 교정 감지 + Lesson 승격
 * 2. OutcomeTracker    — 응답 품질 추적 + 성과 리포트
 * 3. NightlyDistiller  — 주기적 메모리 증류
 * 4. Committee         — 하이브리드 위원회 의사결정 (AI + 인간, 가중치 투표)
 * 5. VoteNotifier      — 인간 투표 플랫폼 추상화 (Slack, Webhook, etc.)
 *
 * 초기화 순서: app.js → initReflection() → Gateway에서 사용
 */
const { ReflectionEngine } = require('./engine');
const { OutcomeTracker } = require('./outcome-tracker');
const { NightlyDistiller } = require('./distiller');
const { Committee } = require('./committee');
const { createLogger } = require('../shared/logger');

const log = createLogger('reflection');

// ─── 싱글톤 ───
let _reflection = null;
let _outcomeTracker = null;
let _distiller = null;
let _committee = null;
let _initialized = false;

/**
 * Self-Improvement 모듈 초기화.
 *
 * @param {object} deps
 * @param {object} deps.semantic    - L3 Semantic Memory
 * @param {object} deps.episodic    - L2 Episodic Memory
 * @param {object} deps.entity      - L4 Entity Memory
 * @param {object} deps.runLogger   - RunLogger 인스턴스 (Gateway와 공유)
 * @param {object} deps.agentLoader - AgentLoader (Committee용 SOUL.md 로딩)
 * @param {object} deps.notifier    - VoteNotifier 인스턴스 (nullable — 인간 투표 플랫폼)
 * @param {object} deps.config      - reflection config section from YAML
 */
function initReflection({ semantic, episodic, entity, runLogger, agentLoader, notifier = null, config: reflectionConfig = {} }) {
  if (_initialized) {
    log.warn('Reflection module already initialized');
    return { reflection: _reflection, outcomeTracker: _outcomeTracker, distiller: _distiller, committee: _committee };
  }

  // 1. ReflectionEngine
  _reflection = new ReflectionEngine({
    semantic,
    episodic,
    entity,
    runLogger,
    config: reflectionConfig,
  });

  // 2. OutcomeTracker (reflection 필드 제거 — 불필요한 순환 참조 방지)
  _outcomeTracker = new OutcomeTracker({
    runLogger,
  });

  // 3. Committee (VoteNotifier 기반 플랫폼 추상화)
  _committee = new Committee({
    agentLoader,
    semantic,
    notifier,
    config: reflectionConfig.committee || {},
  });

  // 4. NightlyDistiller (Committee 주입 — 승격 판단을 위원회에 위임)
  _distiller = new NightlyDistiller({
    semantic,
    episodic,
    entity,
    committee: _committee,
    config: reflectionConfig.distillation || {},
  });

  // Nightly 스케줄링
  if (reflectionConfig.nightly?.enabled !== false) {
    const hourKST = reflectionConfig.nightly?.hourKST ?? 23.5;
    _distiller.schedule(hourKST);
  }

  _initialized = true;

  const humanCount = _committee.humanMembers.length;
  const platform = notifier ? notifier.platform : 'none';
  log.info(`Reflection initialized (engine + tracker + distiller + committee[AI:${_committee.aiMembers.map(m => m.id).join(',')}${humanCount > 0 ? ` + Human:${humanCount}(${platform})` : ''}])`);

  return { reflection: _reflection, outcomeTracker: _outcomeTracker, distiller: _distiller, committee: _committee };
}

/**
 * 싱글톤 접근자.
 */
function getReflection() { return _reflection; }
function getOutcomeTracker() { return _outcomeTracker; }
function getDistiller() { return _distiller; }
function getCommittee() { return _committee; }

/**
 * 전체 정리 (graceful shutdown).
 */
function destroyReflection() {
  if (_reflection) { _reflection.destroy(); _reflection = null; }
  if (_outcomeTracker) { _outcomeTracker.reset(); _outcomeTracker = null; }
  if (_distiller) { _distiller.destroy(); _distiller = null; }
  if (_committee) { _committee.destroy(); _committee = null; }
  _initialized = false;
  log.info('Reflection module destroyed');
}

module.exports = {
  initReflection,
  getReflection,
  getOutcomeTracker,
  getDistiller,
  getCommittee,
  destroyReflection,
};
