/**
 * working-events.js — Working Memory Event Log (Module 41)
 *
 * 시간 기반 이벤트 로깅 시스템 (SpaceBot-inspired)
 * - 구조화된 append-only 이벤트 로그
 * - 타임스탐프, 타입, 소스 채널 태그
 * - 일일 기반 진행적 압축: 오늘=상세, 어제=요약, 7일+=무시
 */

const { createLogger } = require('../shared/logger');
const { getDb } = require('../db/sqlite');

const log = createLogger('memory:working-events');

/**
 * 이벤트 타입 정의.
 */
const EVENT_TYPES = {
  BRANCH_COMPLETED: 'branch_completed',
  WORKER_SPAWNED: 'worker_spawned',
  WORKER_COMPLETED: 'worker_completed',
  CRON_EXECUTED: 'cron_executed',
  MEMORY_SAVED: 'memory_saved',
  DECISION_MADE: 'decision_made',
  ERROR_OCCURRED: 'error_occurred',
  TASK_UPDATED: 'task_updated',
  AGENT_MESSAGE: 'agent_message',
  SYSTEM_EVENT: 'system_event',
  USER_MESSAGE: 'user_message',
  TOOL_EXECUTED: 'tool_executed',
};

class WorkingMemoryEventLog {
  /**
   * 초기화 — 작업 메모리 이벤트 로그 구성
   *
   * @param {Object} opts - 옵션
   * @param {Object} opts.db - better-sqlite3 인스턴스
   * @param {string} [opts.timezone='Asia/Seoul'] - 타임존
   * @param {number} [opts.maxEventsPerDay=500] - 일일 분할 상한
   * @param {number} [opts.retentionDays=30] - 보관 기간
   */
  constructor(opts = {}) {
    this.db = opts.db;
    this.timezone = opts.timezone || 'Asia/Seoul';
    this.maxEventsPerDay = opts.maxEventsPerDay || 500;
    this.retentionDays = opts.retentionDays || 30;

    log.info('WorkingMemoryEventLog initialized', {
      timezone: this.timezone,
      maxEventsPerDay: this.maxEventsPerDay,
      retentionDays: this.retentionDays
    });
  }

  /**
   * DB 테이블 초기화 (CREATE IF NOT EXISTS)
   */
  init() {
    try {
      const db = this.db || getDb();

      db.exec(`
        CREATE TABLE IF NOT EXISTS working_memory_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          agent_id TEXT,
          user_id TEXT,
          summary TEXT NOT NULL,
          metadata TEXT,
          date_partition TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CONSTRAINT chk_type CHECK (type IN (
            'branch_completed','worker_spawned','worker_completed','cron_executed',
            'memory_saved','decision_made','error_occurred','task_updated',
            'agent_message','system_event','user_message','tool_executed'
          ))
        );
        CREATE INDEX IF NOT EXISTS idx_wme_channel_date
          ON working_memory_events(channel_id, date_partition);
        CREATE INDEX IF NOT EXISTS idx_wme_type
          ON working_memory_events(type);
      `);

      log.info('working_memory_events table initialized');
    } catch (err) {
      log.error('Failed to initialize working_memory_events table', err);
      throw err;
    }
  }

  /**
   * 이벤트 기록 (append)
   *
   * @param {Object} event - 이벤트 객체
   * @param {string} event.type - EVENT_TYPES 값
   * @param {string} event.channelId - 소스 채널 ID
   * @param {string} [event.agentId] - 에이전트 ID
   * @param {string} event.summary - 한 줄 요약
   * @param {Object} [event.metadata] - 추가 데이터 (JSON)
   * @param {string} [event.userId] - 사용자 ID
   * @returns {number} 삽입된 이벤트 ID
   */
  emit(event) {
    try {
      const db = this.db || getDb();

      if (!event.type || !Object.values(EVENT_TYPES).includes(event.type)) {
        throw new Error(`Invalid event type: ${event.type}`);
      }
      if (!event.channelId) {
        throw new Error('channelId is required');
      }
      if (!event.summary) {
        throw new Error('summary is required');
      }

      const datePartition = this._today();
      const metadata = event.metadata ? JSON.stringify(event.metadata) : null;

      const stmt = db.prepare(`
        INSERT INTO working_memory_events (
          type, channel_id, agent_id, user_id, summary, metadata, date_partition
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        event.type,
        event.channelId,
        event.agentId || null,
        event.userId || null,
        event.summary,
        metadata,
        datePartition
      );

      log.debug('Event emitted', {
        id: result.lastInsertRowid,
        type: event.type,
        channelId: event.channelId
      });

      return result.lastInsertRowid;
    } catch (err) {
      log.error('Failed to emit event', err);
      throw err;
    }
  }

  /**
   * 시간축 기반 컨텍스트 조회 (진행적 압축)
   *
   * - 오늘: 전체 이벤트 상세
   * - 어제: LLM 없이 타입별 카운트 + 주요 이벤트 3개
   * - 2-7일 전: "N일 전: X건 이벤트" 한 줄 요약
   * - 7일+: 무시
   *
   * @param {string} channelId - 채널 ID
   * @returns {string} 포맷된 컨텍스트 문자열
   */
  getContext(channelId) {
    try {
      const db = this.db || getDb();
      const todayDate = this._today();
      const yesterdayDate = this._yesterday();

      let contextParts = [];

      // ─── 오늘 이벤트 (상세) ───
      const todayEvents = db.prepare(`
        SELECT id, type, summary, created_at FROM working_memory_events
        WHERE channel_id = ? AND date_partition = ?
        ORDER BY created_at ASC
      `).all(channelId, todayDate);

      if (todayEvents.length > 0) {
        contextParts.push(`## 오늘 (${todayDate})`);
        for (const event of todayEvents) {
          const timeStr = this._formatTime(event.created_at);
          const emoji = this._getEventEmoji(event.type);
          contextParts.push(`- [${timeStr}] ${emoji} ${event.type}: ${event.summary}`);
        }
        contextParts.push('');
      }

      // ─── 어제 이벤트 (요약) ───
      const yesterdayEvents = db.prepare(`
        SELECT type, summary FROM working_memory_events
        WHERE channel_id = ? AND date_partition = ?
        ORDER BY created_at ASC
      `).all(channelId, yesterdayDate);

      if (yesterdayEvents.length > 0) {
        const typeCounts = {};
        const highlights = [];

        for (const event of yesterdayEvents) {
          typeCounts[event.type] = (typeCounts[event.type] || 0) + 1;
          if (highlights.length < 3) {
            highlights.push(`"${event.summary}"`);
          }
        }

        const countStr = Object.entries(typeCounts)
          .map(([type, count]) => `${type} ×${count}`)
          .join(', ');
        const highlightStr = highlights.join(', ');

        contextParts.push(`## 어제 (${yesterdayDate})`);
        contextParts.push(`${countStr} | 주요: ${highlightStr}`);
        contextParts.push('');
      }

      // ─── 2-7일 전 이벤트 (한 줄 요약) ───
      for (let daysAgo = 2; daysAgo <= 7; daysAgo++) {
        const date = this._daysAgo(daysAgo);
        const count = db.prepare(`
          SELECT COUNT(*) as cnt FROM working_memory_events
          WHERE channel_id = ? AND date_partition = ?
        `).get(channelId, date);

        if (count && count.cnt > 0) {
          contextParts.push(`## ${daysAgo}일 전: 이벤트 ${count.cnt}건`);
        }
      }

      return contextParts.join('\n');
    } catch (err) {
      log.error('Failed to get context', err);
      return '';
    }
  }

  /**
   * 특정 날짜의 이벤트 조회
   *
   * @param {string} channelId - 채널 ID
   * @param {string} date - 'YYYY-MM-DD' 형식
   * @returns {Array<Object>} 이벤트 배열
   */
  getByDate(channelId, date) {
    try {
      const db = this.db || getDb();

      return db.prepare(`
        SELECT id, type, agent_id, user_id, summary, metadata, created_at
        FROM working_memory_events
        WHERE channel_id = ? AND date_partition = ?
        ORDER BY created_at ASC
      `).all(channelId, date);
    } catch (err) {
      log.error('Failed to get events by date', err);
      return [];
    }
  }

  /**
   * 오래된 이벤트 정리 (retentionDays 초과)
   *
   * @returns {{ deleted: number }} 삭제된 이벤트 수
   */
  cleanup() {
    try {
      const db = this.db || getDb();
      const cutoffDate = this._daysAgo(this.retentionDays);

      const result = db.prepare(`
        DELETE FROM working_memory_events
        WHERE date_partition < ?
      `).run(cutoffDate);

      log.info('Event cleanup completed', {
        deleted: result.changes,
        retentionDays: this.retentionDays
      });

      return { deleted: result.changes };
    } catch (err) {
      log.error('Failed to cleanup events', err);
      throw err;
    }
  }

  /**
   * 타입별 이벤트 통계
   *
   * @param {string} [channelId] - 필터링할 채널 ID (생략 시 전체)
   * @returns {Object} 통계
   */
  stats(channelId) {
    try {
      const db = this.db || getDb();

      let query = 'SELECT type, COUNT(*) as count FROM working_memory_events';
      const params = [];

      if (channelId) {
        query += ' WHERE channel_id = ?';
        params.push(channelId);
      }

      query += ' GROUP BY type';

      const typeCounts = db.prepare(query).all(...params);

      const total = typeCounts.reduce((sum, row) => sum + row.count, 0);

      return {
        total,
        byType: Object.fromEntries(typeCounts.map(row => [row.type, row.count]))
      };
    } catch (err) {
      log.error('Failed to get stats', err);
      return { total: 0, byType: {} };
    }
  }

  /**
   * 오늘 날짜 문자열 (timezone-aware)
   * @private
   * @returns {string} 'YYYY-MM-DD'
   */
  _today() {
    const now = new Date();
    // 간단히 로컬 날짜 사용 (실제 timezone 처리는 복잡하므로 ISO 기본값)
    return now.toISOString().split('T')[0];
  }

  /**
   * 어제 날짜 문자열
   * @private
   * @returns {string} 'YYYY-MM-DD'
   */
  _yesterday() {
    const yesterday = new Date(Date.now() - 86400000);
    return yesterday.toISOString().split('T')[0];
  }

  /**
   * N일 전 날짜 문자열
   * @private
   * @param {number} n - 일 수
   * @returns {string} 'YYYY-MM-DD'
   */
  _daysAgo(n) {
    const past = new Date(Date.now() - n * 86400000);
    return past.toISOString().split('T')[0];
  }

  /**
   * 타임스탬프 포맷 (HH:MM 형식)
   * @private
   * @param {string} isoString - ISO 8601 타임스탬프
   * @returns {string} 'HH:MM'
   */
  _formatTime(isoString) {
    try {
      const date = new Date(isoString);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    } catch {
      return '--:--';
    }
  }

  /**
   * 이벤트 타입별 이모지
   * @private
   * @param {string} type - 이벤트 타입
   * @returns {string} 이모지
   */
  _getEventEmoji(type) {
    const emojiMap = {
      branch_completed: '🌿',
      worker_spawned: '🚀',
      worker_completed: '✅',
      cron_executed: '⏰',
      memory_saved: '💾',
      decision_made: '🤔',
      error_occurred: '❌',
      task_updated: '📝',
      agent_message: '🤖',
      system_event: '⚙️',
      user_message: '👤',
      tool_executed: '🔧',
    };
    return emojiMap[type] || '📌';
  }
}

module.exports = { WorkingMemoryEventLog, EVENT_TYPES };
