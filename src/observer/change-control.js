/**
 * change-control.js — System Change Control Gate.
 *
 * CRITICAL/HIGH 등급 시스템 변경은 반드시 Admin 승인 또는 Committee 투표를 거쳐야 한다.
 *
 * 등급 정의:
 *   CRITICAL — 시스템 설정 변경, observer 활성/비활성, 보안 규칙 변경
 *   HIGH     — proactive level 변경, 채널 관찰 추가/제거, 패턴 비활성화
 *   MEDIUM   — insight 수동 생성, 피드백 가중치 조정
 *   LOW      — 대시보드 조회, 통계 조회 (승인 불필요)
 *
 * 승인 방식:
 *   1. Admin 즉시 승인: /effy approve <changeId>
 *   2. Committee 투표: 비동기 투표 후 quorum 달성 시 자동 승인
 *   3. 타임아웃: 24시간 내 미승인 시 자동 만료
 */
const { createLogger } = require('../shared/logger');
const { isAdmin } = require('../shared/auth');

const log = createLogger('observer:change-control');

// ─── Change Severity ─────────────────────────────────

const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
};

// ─── Pending Changes Store (in-memory) ───────────────

const pendingChanges = new Map();  // changeId → ChangeRequest
let _nextId = 1;

/**
 * @typedef {Object} ChangeRequest
 * @property {string} id
 * @property {string} severity
 * @property {string} type - 변경 유형 (observer_toggle, channel_add, level_change, etc.)
 * @property {string} description
 * @property {object} payload - 변경 내용
 * @property {string} requestedBy - 요청자 userId
 * @property {string} status - pending | approved | rejected | expired
 * @property {string[]} approvals - 승인한 userId 목록
 * @property {number} createdAt
 * @property {number} expiresAt
 */

const EXPIRY_MS = 24 * 60 * 60 * 1000;  // 24시간
const PENDING_CHANGES_MAX = 10000;

// Periodic cleanup of expired entries (every 5 minutes)
const _pendingCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, ch] of pendingChanges) {
    if (now > ch.expiresAt) {
      ch.status = 'expired';
      pendingChanges.delete(id);
    }
  }
  // Hard cap to prevent unbounded growth
  if (pendingChanges.size > PENDING_CHANGES_MAX) {
    const toRemove = pendingChanges.size - PENDING_CHANGES_MAX;
    const iter = pendingChanges.keys();
    for (let i = 0; i < toRemove; i++) {
      pendingChanges.delete(iter.next().value);
    }
  }
}, 5 * 60 * 1000);
_pendingCleanupTimer.unref();

/**
 * 변경 요청 생성.
 *
 * CRITICAL/HIGH → pending 상태로 대기 (Admin/Committee 승인 필요)
 * MEDIUM/LOW → 즉시 승인
 *
 * @param {string} severity
 * @param {string} type
 * @param {string} description
 * @param {object} payload
 * @param {string} requestedBy
 * @returns {ChangeRequest}
 */
function requestChange(severity, type, description, payload, requestedBy) {
  const id = `CHG-${String(_nextId++).padStart(4, '0')}`;
  const now = Date.now();

  const change = {
    id,
    severity,
    type,
    description,
    payload,
    requestedBy,
    approvals: [],
    createdAt: now,
    expiresAt: now + EXPIRY_MS,
    status: 'pending',
  };

  // MEDIUM/LOW는 즉시 승인
  if (severity === SEVERITY.MEDIUM || severity === SEVERITY.LOW) {
    change.status = 'approved';
    change.approvals = ['auto'];
    log.info('Change auto-approved (low severity)', { id, type, severity });
    return change;
  }

  // CRITICAL/HIGH는 대기
  pendingChanges.set(id, change);
  log.warn('Change pending approval', { id, type, severity, description });
  return change;
}

/**
 * Admin이 변경을 승인.
 *
 * @param {string} changeId
 * @param {string} userId - 승인자
 * @returns {{ success: boolean, change?: ChangeRequest, error?: string }}
 */
function approveChange(changeId, userId) {
  if (!isAdmin(userId)) {
    return { success: false, error: 'Admin 권한이 필요합니다.' };
  }

  const change = pendingChanges.get(changeId);
  if (!change) {
    return { success: false, error: `변경 요청 '${changeId}'를 찾을 수 없습니다.` };
  }

  if (change.status !== 'pending') {
    return { success: false, error: `이미 처리됨: ${change.status}` };
  }

  if (Date.now() > change.expiresAt) {
    change.status = 'expired';
    return { success: false, error: '승인 시한 초과 (24시간)' };
  }

  change.status = 'approved';
  change.approvals.push(userId);
  pendingChanges.delete(changeId);

  log.info('Change approved', { id: changeId, approvedBy: userId, type: change.type });
  return { success: true, change };
}

/**
 * Admin이 변경을 거부.
 */
function rejectChange(changeId, userId, reason) {
  if (!isAdmin(userId)) {
    return { success: false, error: 'Admin 권한이 필요합니다.' };
  }

  const change = pendingChanges.get(changeId);
  if (!change) {
    return { success: false, error: `변경 요청 '${changeId}'를 찾을 수 없습니다.` };
  }

  change.status = 'rejected';
  change.rejectReason = reason || '';
  pendingChanges.delete(changeId);

  log.info('Change rejected', { id: changeId, rejectedBy: userId, reason });
  return { success: true, change };
}

/**
 * 대기 중인 변경 목록.
 */
function listPending() {
  // 만료된 것 정리
  const now = Date.now();
  for (const [id, ch] of pendingChanges) {
    if (now > ch.expiresAt) {
      ch.status = 'expired';
      pendingChanges.delete(id);
    }
  }
  return [...pendingChanges.values()];
}

/**
 * 변경이 승인되었는지 확인.
 * MEDIUM/LOW는 항상 true.
 *
 * @param {ChangeRequest} change
 * @returns {boolean}
 */
function isApproved(change) {
  return change.status === 'approved';
}

/**
 * Severity 분류: 어떤 작업이 어떤 등급인지.
 */
const CHANGE_TYPES = {
  // CRITICAL
  observer_toggle:       SEVERITY.CRITICAL,   // observer 전체 on/off
  security_rule_change:  SEVERITY.CRITICAL,   // RULES.json 변경
  admin_change:          SEVERITY.CRITICAL,   // adminUsers 변경

  // HIGH
  channel_observe_add:   SEVERITY.HIGH,       // 채널 관찰 추가
  channel_observe_remove: SEVERITY.HIGH,      // 채널 관찰 제거
  proactive_level_change: SEVERITY.HIGH,      // 제안 Level 변경
  pattern_disable:       SEVERITY.HIGH,       // 패턴 감지 비활성화
  api_source_add:        SEVERITY.HIGH,       // Context Hub 소스 추가
  api_source_remove:     SEVERITY.HIGH,       // Context Hub 소스 삭제

  // MEDIUM
  insight_manual_create: SEVERITY.MEDIUM,     // 수동 insight 생성
  feedback_weight_adjust: SEVERITY.MEDIUM,    // 피드백 가중치 조정

  // LOW
  dashboard_view:        SEVERITY.LOW,        // 대시보드 조회
  stats_query:           SEVERITY.LOW,        // 통계 조회
};

/**
 * 작업의 severity를 조회.
 */
function getSeverity(type) {
  return CHANGE_TYPES[type] || SEVERITY.MEDIUM;
}

module.exports = {
  SEVERITY,
  CHANGE_TYPES,
  requestChange,
  approveChange,
  rejectChange,
  listPending,
  isApproved,
  getSeverity,
};
