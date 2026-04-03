/**
 * cortex.js — Cortex 시스템 감독자.
 *
 * 모든 대화를 크로스-체크하고 주기적 메모리 브리핑을 생성.
 * 기존 MemoryBulletin을 확장하여 시스템 수준 감독 기능 추가.
 *
 * 역할:
 * 1. 주기적 메모리 브리핑 생성 (전체 채널 크로스)
 * 2. 에이전트 간 정보 공유 (중요 결정사항 전파)
 * 3. 메모리 모순 감지 + 정리 (주기적 무결성 검사)
 * 4. 활동 요약 보고서 (일간/주간)
 * 5. 메모리 중요도 자동 조정 (접근 빈도 기반 decay)
 *
 * 타이머 기반 주기적 실행 — Gateway에서 cortex.start()로 활성화.
 */
const { createLogger } = require('../shared/logger');

const log = createLogger('cortex');

class Cortex {
  /**
   * @param {Object} opts
   * @param {Object} opts.graph - MemoryGraph 인스턴스
   * @param {Object} opts.search - MemorySearch 인스턴스
   * @param {Object} [opts.bulletin] - MemoryBulletin 인스턴스
   * @param {Object} [opts.anthropicClient] - Anthropic SDK 클라이언트
   * @param {Object} [opts.config] - Cortex 설정
   */
  constructor(opts = {}) {
    this.graph = opts.graph;
    this.search = opts.search;
    this.bulletin = opts.bulletin;
    this.anthropicClient = opts.anthropicClient;

    const cortexConfig = opts.config || {};
    this.enabled = cortexConfig.enabled !== false;
    this.briefingIntervalMs = cortexConfig.briefingIntervalMs || 3600000;    // 1시간
    this.integrityIntervalMs = cortexConfig.integrityIntervalMs || 21600000; // 6시간
    this.decayIntervalMs = cortexConfig.decayIntervalMs || 86400000;         // 24시간
    this.model = cortexConfig.model || 'claude-haiku-4-5-20251001';

    /** @type {Map<string, { briefing: string, generatedAt: number }>} */
    this._briefings = new Map();
    this._maxBriefings = 1000;

    /** @type {NodeJS.Timeout[]} */
    this._timers = [];

    this._running = false;
  }

  /**
   * Cortex 시작 — 주기적 작업 활성화.
   */
  start() {
    if (!this.enabled || this._running) return;
    this._running = true;

    log.info('Cortex started', {
      briefingInterval: `${this.briefingIntervalMs / 60000}m`,
      integrityInterval: `${this.integrityIntervalMs / 3600000}h`,
      decayInterval: `${this.decayIntervalMs / 3600000}h`,
    });

    // 1. 주기적 브리핑 생성
    this._timers.push(
      setInterval(() => this._generateCrossBriefing().catch(err =>
        log.error('Cross-briefing failed', { error: err.message })
      ), this.briefingIntervalMs)
    );

    // 2. 메모리 무결성 검사
    this._timers.push(
      setInterval(() => this._integrityCheck().catch(err =>
        log.error('Integrity check failed', { error: err.message })
      ), this.integrityIntervalMs)
    );

    // 3. 중요도 decay
    this._timers.push(
      setInterval(() => this._importanceDecay().catch(err =>
        log.error('Importance decay failed', { error: err.message })
      ), this.decayIntervalMs)
    );

    // 시작 직후 1회 실행
    setTimeout(() => {
      this._importanceDecay().catch(() => {});
    }, 5000);
  }

  /**
   * Cortex 중지.
   */
  stop() {
    this._running = false;
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];
    log.info('Cortex stopped');
  }

  /**
   * 크로스-채널 브리핑 생성.
   * 모든 채널의 최근 결정사항/이벤트를 수집하여 전체 브리핑 생성.
   * @private
   */
  async _generateCrossBriefing() {
    if (!this.graph || !this.anthropicClient) return;

    try {
      const { getDb } = require('../db/sqlite');
      const db = getDb();

      // 최근 1시간 이내 생성된 중요 메모리 수집
      const cutoff = new Date(Date.now() - this.briefingIntervalMs).toISOString();
      const recentMemories = db.prepare(`
        SELECT type, content, source_channel, importance
        FROM memories
        WHERE created_at >= ? AND archived = 0 AND importance >= 0.5
        ORDER BY importance DESC
        LIMIT 20
      `).all(cutoff);

      if (recentMemories.length === 0) {
        log.debug('No recent important memories for cross-briefing');
        return;
      }

      // 채널별 그룹핑
      const byChannel = {};
      for (const mem of recentMemories) {
        const ch = mem.source_channel || 'global';
        if (!byChannel[ch]) byChannel[ch] = [];
        byChannel[ch].push(mem);
      }

      // 전체 브리핑 생성
      const channelSummaries = Object.entries(byChannel).map(([ch, mems]) => {
        const items = mems.map(m => `[${m.type}] ${m.content.slice(0, 150)}`).join('\n');
        return `채널 ${ch}:\n${items}`;
      }).join('\n\n');

      const response = await this.anthropicClient.messages.create({
        model: this.model,
        max_tokens: 300,
        system: '여러 채널의 최근 활동을 종합하여 3~5문장 브리핑을 생성하세요. 중요 결정, 진행 상황, 주목할 사항을 포함하세요.',
        messages: [{ role: 'user', content: `최근 활동 요약:\n\n${channelSummaries}` }],
      });

      const briefing = response.content[0]?.type === 'text' ? response.content[0].text : '';

      if (this._briefings.size >= this._maxBriefings) {
        const oldest = this._briefings.keys().next().value;
        this._briefings.delete(oldest);
      }
      this._briefings.set('global', {
        briefing,
        generatedAt: Date.now(),
        channelCount: Object.keys(byChannel).length,
        memoryCount: recentMemories.length,
      });

      log.info('Cross-briefing generated', {
        channels: Object.keys(byChannel).length,
        memories: recentMemories.length,
        briefingLen: briefing.length,
      });

      // 기존 bulletin에도 전파
      if (this.bulletin) {
        this.bulletin.clear(); // 캐시 무효화하여 다음 조회 시 갱신
      }
    } catch (err) {
      log.error('Cross-briefing generation failed', { error: err.message });
    }
  }

  /**
   * 메모리 무결성 검사.
   * contradicts 엣지가 있는 메모리 쌍 검사 + 오래된 모순 정리.
   * @private
   */
  async _integrityCheck() {
    if (!this.graph) return;

    try {
      const { getDb } = require('../db/sqlite');
      const db = getDb();

      // 1. 모순 엣지가 있는 메모리 쌍 조회
      const contradictions = db.prepare(`
        SELECT e.source_id, e.target_id, e.created_at,
               s.content as source_content, s.importance as source_importance,
               t.content as target_content, t.importance as target_importance
        FROM memory_edges e
        INNER JOIN memories s ON s.id = e.source_id
        INNER JOIN memories t ON t.id = e.target_id
        WHERE e.relation = 'contradicts'
          AND s.archived = 0 AND t.archived = 0
        ORDER BY e.created_at DESC
        LIMIT 50
      `).all();

      let resolved = 0;
      let deduped = 0;

      // Wrap all DELETE/UPDATE operations in a transaction for atomicity
      const runIntegrity = db.transaction(() => {
        for (const c of contradictions) {
          // 더 오래된 + 낮은 중요도 메모리 아카이브
          const olderIsSource = new Date(c.created_at).getTime() < Date.now() - 86400000;
          if (olderIsSource && c.source_importance < c.target_importance) {
            db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(c.source_id);
            resolved++;
          } else if (olderIsSource && c.target_importance < c.source_importance) {
            db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(c.target_id);
            resolved++;
          }
        }

        // 2. 중복 콘텐츠 검사 (동일 content_hash)
        const duplicates = db.prepare(`
          SELECT content_hash, COUNT(*) as cnt
          FROM memories
          WHERE archived = 0
          GROUP BY content_hash
          HAVING cnt > 1
        `).all();

        for (const dup of duplicates) {
          const rows = db.prepare(`
            SELECT id, importance, created_at
            FROM memories
            WHERE content_hash = ? AND archived = 0
            ORDER BY importance DESC, created_at DESC
          `).all(dup.content_hash);

          // 가장 중요한 것만 남기고 나머지 아카이브
          for (let i = 1; i < rows.length; i++) {
            db.prepare('UPDATE memories SET archived = 1 WHERE id = ?').run(rows[i].id);
            deduped++;
          }
        }
      });
      runIntegrity();

      if (resolved > 0 || deduped > 0) {
        log.info('Integrity check completed', { contradictions: contradictions.length, resolved, deduped });
      } else {
        log.debug('Integrity check: no issues found');
      }
    } catch (err) {
      log.error('Integrity check failed', { error: err.message });
    }
  }

  /**
   * 메모리 중요도 시간 감쇠.
   * 오래 접근되지 않은 메모리의 importance를 점진적으로 낮춤.
   * @private
   */
  async _importanceDecay() {
    try {
      const { getDb } = require('../db/sqlite');
      const db = getDb();

      // 7일 이상 미접근 + importance > 0.3인 메모리 decay
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      const result = db.prepare(`
        UPDATE memories
        SET importance = MAX(0.1, importance * 0.95)
        WHERE archived = 0
          AND last_accessed_at < ?
          AND importance > 0.3
          AND type NOT IN ('identity', 'goal')
      `).run(cutoff);

      if (result.changes > 0) {
        log.info('Importance decay applied', { affected: result.changes });
      }
    } catch (err) {
      // last_accessed_at 컬럼이 없을 수 있음 (v4 마이그레이션 전)
      log.debug('Importance decay skipped', { error: err.message });
    }
  }

  /**
   * 글로벌 브리핑 조회.
   * @returns {string}
   */
  getGlobalBriefing() {
    const entry = this._briefings.get('global');
    if (!entry) return '';
    // 2시간 이내 브리핑만 유효
    if (Date.now() - entry.generatedAt > this.briefingIntervalMs * 2) return '';
    return entry.briefing;
  }

  /**
   * Cortex 상태 요약.
   * @returns {Object}
   */
  getStatus() {
    return {
      running: this._running,
      briefings: this._briefings.size,
      lastBriefing: this._briefings.get('global')?.generatedAt || null,
      timers: this._timers.length,
    };
  }
}

module.exports = { Cortex };
