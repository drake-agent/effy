/**
 * session-recovery.js — Session Recovery Manager for Effy v4.0
 *
 * 세션 복구: Effy 재시작 시 L1 워킹 메모리(in-memory Map) 손실을
 * L2 Episodic Memory(SQLite)에서 최근 메시지를 로드하여 복구하는 매니저.
 *
 * 복구 전략:
 * 1. On-demand 복구: 사용자의 워킹 메모리가 비어있을 때 자동 호출 (<500ms)
 * 2. Batch 복구: 시작 시 최근 활성 세션들의 메모리 미리 로드 (선택)
 * 3. Shutdown: 모든 활성 세션을 DB에 저장
 *
 * R1-010 fix: episodic를 모듈 싱글톤이 아닌 lazy require로 변경 (순환 의존 방지)
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('session-recovery');

/** R1-010 fix: lazy require로 순환 의존 방지 */
function _getEpisodic() {
  return require('../memory/manager').episodic;
}

class SessionRecoveryManager {
  constructor(gateway) {
    this._gateway = gateway;  // { workingMemory, sessions }
    this._recoveryInProgress = new Set(); // 중복 복구 방지
    this._batchRecoveryInProgress = false; // R1-004 fix: 중복 배치 복구 방지
  }

  /**
   * 단일 세션 온디맨드 복구 — 워킹 메모리가 비어있을 때 자동 호출.
   *
   * 사용 패턴: 재시작 후 사용자의 첫 메시지 도착 시
   * - 컨텍스트 조립 전에 호출
   * - 이미 메모리가 있으면 스킵 (idempotent)
   * - 초과 30초 복구는 로그하고 계속 진행 (soft timeout)
   *
   * @param {string} sessionKey - {agentId}:{userId}:{channelId}:{threadId|main}
   * @returns {Promise<number>} 복구된 메시지 수 (0 = 스킵됨)
   */
  async recoverSession(sessionKey) {
    // 중복 복구 방지
    if (this._recoveryInProgress.has(sessionKey)) {
      return 0;
    }

    const start = Date.now();
    this._recoveryInProgress.add(sessionKey);

    try {
      // 이미 데이터가 있으면 스킵 (idempotent)
      const existing = this._gateway.workingMemory.get(sessionKey);
      if (existing && existing.length > 0) {
        log.debug('Recovery skipped: working memory already has data', { sessionKey, count: existing.length });
        return 0;
      }

      // 복구할 메시지 수 설정 (기본 20개, 제한 없음으로 모두 로드 가능)
      const limit = 20;

      // L2 Episodic에서 최근 메시지 로드
      const history = await _getEpisodic().getHistory(sessionKey, limit);

      if (!history || history.length === 0) {
        log.debug('Recovery: no history found', { sessionKey });
        return 0;
      }

      // L1 WorkingMemory에 복구
      const entries = history.map(h => ({
        role: h.role,
        content: h.content,
        timestamp: new Date(h.created_at).getTime() || Date.now(),
      }));

      // 워킹 메모리에 직접 저장 (replace 사용 = TTL 타이머 포함)
      this._gateway.workingMemory.replace(sessionKey, entries);

      const elapsed = Date.now() - start;
      log.info('Session recovered', {
        sessionKey,
        count: entries.length,
        elapsedMs: elapsed,
      });

      // 복구 성능 경고 (500ms 초과)
      if (elapsed > 500) {
        log.warn('Slow recovery detected', { sessionKey, elapsedMs: elapsed });
      }

      return entries.length;
    } catch (err) {
      log.error('Recovery failed', { sessionKey, error: err.message });
      return 0;
    } finally {
      this._recoveryInProgress.delete(sessionKey);
    }
  }

  /**
   * 스타트업 배치 복구 — 최근 활성 세션들의 워킹 메모리 미리 로드.
   *
   * 시나리오: 재시작 후 빠른 응답성 제공
   * - 활성 세션 레지스트리에서 최근 세션 목록 가져오기
   * - 각 세션에 대해 병렬로 복구 시도
   * - 복구 순서: 가장 최근 활성부터 (lastActivity DESC)
   *
   * @param {number} [withinMs=3600000] - 최근 1시간(기본값) 내 활성 세션만 대상
   * @returns {Promise<number>} 복구된 세션 수
   */
  async recoverRecentSessions(withinMs = 3600000) {
    // R1-004 fix: 중복 배치 복구 방지
    if (this._batchRecoveryInProgress) {
      log.warn('Batch recovery already in progress, skipping');
      return 0;
    }
    this._batchRecoveryInProgress = true;

    const threshold = Date.now() - withinMs;

    // R1-009 fix: gateway.sessions public API 사용 (내부 Map 직접 접근 제거)
    const recentSessions = [];
    const sessionEntries = typeof this._gateway.sessions.getRecentSessions === 'function'
      ? this._gateway.sessions.getRecentSessions(threshold)
      : this._getSessionsFallback(threshold);

    recentSessions.push(...sessionEntries);

    if (recentSessions.length === 0) {
      log.debug('Batch recovery: no recent sessions found', { withinMs, threshold });
      return 0;
    }

    // 최근 활성순 정렬
    recentSessions.sort((a, b) => b.lastActivity - a.lastActivity);

    log.info('Batch recovery starting', {
      count: recentSessions.length,
      withinMs,
    });

    // 병렬 복구 (최대 10개 동시 복구)
    const batchSize = 10;
    let recovered = 0;

    for (let i = 0; i < recentSessions.length; i += batchSize) {
      const batch = recentSessions.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(({ sessionKey }) => this.recoverSession(sessionKey))
      );
      recovered += results.reduce((sum, count) => sum + count, 0);
    }

    this._batchRecoveryInProgress = false; // R1-004 fix

    log.info('Batch recovery completed', {
      sessionsProcessed: recentSessions.length,
      messagesRecovered: recovered,
    });

    return recentSessions.length;
  }

  /**
   * R1-009 fix: gateway.sessions 내부 Map 직접 접근 폴백.
   * sessions.getRecentSessions() public API가 없는 경우 사용.
   * @private
   */
  _getSessionsFallback(threshold) {
    const results = [];
    const sessionsMap = this._gateway.sessions.sessions;
    if (!sessionsMap || typeof sessionsMap.entries !== 'function') return results;
    for (const [sessionKey, sessionData] of sessionsMap.entries()) {
      if (sessionData.lastActivity && sessionData.lastActivity > threshold) {
        results.push({ sessionKey, lastActivity: sessionData.lastActivity });
      }
    }
    return results;
  }

  /**
   * 셧다운 — 모든 활성 세션을 DB에 저장.
   *
   * 용도: graceful shutdown 중에 호출
   * - L1 워킹 메모리 → L2 Episodic에 저장
   * - 이미 저장된 메시지는 중복 방지 (content_hash UNIQUE)
   * - 비동기: 타임아웃 없음 (shutdown 타임아웃에 의존)
   *
   * @returns {Promise<number>} 저장된 세션 수
   */
  async serializeAll() {
    // R1-009 fix: public API 우선 사용
    const sessionsMap = this._gateway.sessions.sessions;
    const sessionKeys = sessionsMap ? Array.from(sessionsMap.keys()) : [];

    if (sessionKeys.length === 0) {
      log.debug('Serialize: no active sessions');
      return 0;
    }

    log.info('Serializing all active sessions...', { count: sessionKeys.length });

    let serialized = 0;
    const errors = [];

    for (const sessionKey of sessionKeys) {
      try {
        // sessionKey 파싱: {agentId}:{userId}:{channelId}:{threadId|main}
        const parts = sessionKey.split(':');
        if (parts.length < 4) {
          log.warn('Invalid sessionKey format', { sessionKey });
          continue;
        }

        const [agentId, userId, channelId, threadPart] = parts;
        const threadId = threadPart === 'main' ? null : threadPart;

        // 워킹 메모리에서 메시지 가져오기
        const messages = this._gateway.workingMemory.get(sessionKey);
        if (!messages || messages.length === 0) {
          continue;
        }

        // 각 메시지를 episodic에 저장
        const ep = _getEpisodic(); // R1-010 fix: lazy require
        for (const msg of messages) {
          try {
            await ep.save(
              sessionKey,
              userId,
              channelId,
              threadId,
              msg.role,
              msg.content,
              agentId,
              '' // functionType — 저장 시 가용하지 않음
            );
          } catch (msgErr) {
            log.debug('Message save skipped', {
              sessionKey,
              role: msg.role,
              error: msgErr.message,
            });
          }
        }

        serialized++;
      } catch (err) {
        errors.push({ sessionKey, error: err.message });
      }
    }

    if (errors.length > 0) {
      log.warn('Serialization errors', { errors });
    }

    log.info('Serialization completed', {
      sessionsProcessed: serialized,
      errors: errors.length,
    });

    return serialized;
  }

  /**
   * 통계 조회 (모니터링용).
   * @returns {object}
   */
  getStats() {
    return {
      inProgressRecoveries: this._recoveryInProgress.size,
      activeSessions: this._gateway.sessions.sessions.size,
      workingMemorySize: this._gateway.workingMemory.size,
    };
  }
}

module.exports = { SessionRecoveryManager };
