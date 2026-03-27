const { createLogger } = require('../shared/logger');

const log = createLogger('memory:participants');

class ParticipantAwareness {
  /**
   * @param {Object} opts
   * @param {Object} opts.db - better-sqlite3 인스턴스
   * @param {number} [opts.staleSummaryAgeMs=86400000] - 24시간 지나면 요약 갱신
   * @param {number} [opts.maxSummaryLength=500] - 최대 요약 길이
   */
  constructor(opts = {}) {
    this.db = opts.db;
    this.staleSummaryAgeMs = opts.staleSummaryAgeMs || 86400000; // 24시간
    this.maxSummaryLength = opts.maxSummaryLength || 500;

    if (!this.db) {
      throw new Error('ParticipantAwareness requires opts.db (better-sqlite3 instance)');
    }
  }

  /** 스키마 초기화. */
  init() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS participants (
          user_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          display_name TEXT,
          platform TEXT,
          summary TEXT,
          summary_updated_at TEXT,
          message_count INTEGER DEFAULT 0,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (user_id, channel_id)
        );

        CREATE INDEX IF NOT EXISTS idx_participants_channel
          ON participants(channel_id, last_active_at);

        CREATE INDEX IF NOT EXISTS idx_participants_stale
          ON participants(summary_updated_at);
      `);

      log('✓ 스키마 초기화 완료');
    } catch (err) {
      log('✗ 스키마 초기화 실패', { error: err.message });
      throw err;
    }
  }

  /**
   * 메시지 수신 시 참여자 upsert (fire-and-forget).
   * @param {Object} msg - { userId, displayName, channelId, platform }
   */
  onMessage(msg) {
    try {
      const { userId, displayName, channelId, platform } = msg;

      if (!userId || !channelId) {
        return; // 필수 필드 누락
      }

      const existing = this.db
        .prepare('SELECT message_count FROM participants WHERE user_id = ? AND channel_id = ?')
        .get(userId, channelId);

      if (existing) {
        // 기존 참여자 업데이트
        this.db
          .prepare(`
            UPDATE participants
            SET message_count = message_count + 1,
                last_active_at = datetime('now'),
                display_name = COALESCE(?, display_name),
                platform = COALESCE(?, platform)
            WHERE user_id = ? AND channel_id = ?
          `)
          .run(displayName || null, platform || null, userId, channelId);
      } else {
        // 새 참여자 생성
        this.db
          .prepare(`
            INSERT INTO participants (user_id, channel_id, display_name, platform, message_count)
            VALUES (?, ?, ?, ?, 1)
          `)
          .run(userId, channelId, displayName || `user:${userId}`, platform || 'unknown');
      }
    } catch (err) {
      log('✗ onMessage 실패', { userId: msg.userId, channelId: msg.channelId, error: err.message });
    }
  }

  /**
   * 채널의 현재 참여자 목록 + 요약.
   * @param {string} channelId
   * @param {number} [recentWindowMs=3600000] - 최근 1시간 내 활성
   * @returns {Array<{ userId, displayName, summary, lastActiveAt, messageCount }>}
   */
  getChannelParticipants(channelId, recentWindowMs = 3600000) {
    try {
      const windowSecs = Math.floor(recentWindowMs / 1000);

      const results = this.db
        .prepare(`
          SELECT
            user_id as userId,
            display_name as displayName,
            summary,
            last_active_at as lastActiveAt,
            message_count as messageCount
          FROM participants
          WHERE channel_id = ?
            AND datetime(last_active_at) > datetime('now', ? || ' seconds')
          ORDER BY last_active_at DESC
        `)
        .all(channelId, -windowSecs);

      return results || [];
    } catch (err) {
      log('✗ getChannelParticipants 실패', { channelId, error: err.message });
      return [];
    }
  }

  /**
   * 시스템 프롬프트용 참여자 컨텍스트 포맷.
   * @param {string} channelId
   * @returns {string} 예: "## 대화 참여자\n- Drake: 개발자. 주로 아키텍처 논의를 함..."
   */
  formatForPrompt(channelId) {
    try {
      const participants = this.getChannelParticipants(channelId);

      if (participants.length === 0) {
        return '## 대화 참여자\n(아직 참여자 정보가 없습니다)';
      }

      const lines = ['## 대화 참여자'];

      for (const p of participants) {
        const name = p.displayName || `user:${p.userId}`;
        const summary = p.summary || '요약 없음';
        const msgCount = p.messageCount || 0;

        lines.push(`- **${name}** (${msgCount}개 메시지): ${summary}`);
      }

      return lines.join('\n');
    } catch (err) {
      log('✗ formatForPrompt 실패', { channelId, error: err.message });
      return '## 대화 참여자\n(참여자 정보 로드 실패)';
    }
  }

  /**
   * 오래된 요약을 갱신해야 할 참여자 목록.
   * @param {number} [limit=10]
   * @returns {Array<{ userId, displayName, channelId }>}
   */
  getStaleSummaries(limit = 10) {
    try {
      const staleSecs = Math.floor(this.staleSummaryAgeMs / 1000);

      const results = this.db
        .prepare(`
          SELECT
            user_id as userId,
            display_name as displayName,
            channel_id as channelId
          FROM participants
          WHERE summary_updated_at IS NULL
            OR datetime(summary_updated_at) < datetime('now', ? || ' seconds')
          ORDER BY last_active_at DESC
          LIMIT ?
        `)
        .all(-staleSecs, limit);

      return results || [];
    } catch (err) {
      log('✗ getStaleSummaries 실패', { error: err.message });
      return [];
    }
  }

  /**
   * 참여자 요약 업데이트 (Cortex에서 호출).
   * @param {string} userId
   * @param {string} channelId
   * @param {string} summary - LLM 생성 2-3문장 바이오
   */
  updateSummary(userId, channelId, summary) {
    try {
      if (!userId || !channelId || !summary) {
        throw new Error('updateSummary requires userId, channelId, and summary');
      }

      // 길이 제한
      const truncated = summary.substring(0, this.maxSummaryLength);

      // 참여자 존재 확인
      const existing = this.db
        .prepare('SELECT user_id FROM participants WHERE user_id = ? AND channel_id = ?')
        .get(userId, channelId);

      if (!existing) {
        throw new Error(`Participant not found: ${userId} in ${channelId}`);
      }

      this.db
        .prepare(`
          UPDATE participants
          SET summary = ?, summary_updated_at = datetime('now')
          WHERE user_id = ? AND channel_id = ?
        `)
        .run(truncated, userId, channelId);

      log('요약 업데이트', { userId, channelId, summaryLen: truncated.length });
    } catch (err) {
      log('✗ updateSummary 실패', { userId, channelId, error: err.message });
      throw err;
    }
  }

  /**
   * 참여자 통계.
   * @returns {{ totalParticipants: number, channelsWithParticipants: number, staleSummaries: number }}
   */
  stats() {
    try {
      const totalParticipants = this.db
        .prepare('SELECT COUNT(DISTINCT user_id) as count FROM participants')
        .get().count;

      const channelsWithParticipants = this.db
        .prepare('SELECT COUNT(DISTINCT channel_id) as count FROM participants')
        .get().count;

      const staleSecs = Math.floor(this.staleSummaryAgeMs / 1000);
      const staleSummaries = this.db
        .prepare(`
          SELECT COUNT(*) as count FROM participants
          WHERE summary_updated_at IS NULL
            OR datetime(summary_updated_at) < datetime('now', ? || ' seconds')
        `)
        .get(-staleSecs).count;

      return {
        totalParticipants,
        channelsWithParticipants,
        staleSummaries,
      };
    } catch (err) {
      log('✗ stats 실패', { error: err.message });
      return {
        totalParticipants: 0,
        channelsWithParticipants: 0,
        staleSummaries: 0,
      };
    }
  }

  /**
   * 디버깅용: 채널의 모든 참여자 조회 (최근순).
   * @param {string} channelId
   * @param {number} [limit=100]
   * @returns {Array<Object>}
   */
  debug_getAllParticipants(channelId, limit = 100) {
    try {
      return this.db
        .prepare(`
          SELECT * FROM participants
          WHERE channel_id = ?
          ORDER BY last_active_at DESC
          LIMIT ?
        `)
        .all(channelId, limit);
    } catch (err) {
      log('✗ debug_getAllParticipants 실패', { channelId, error: err.message });
      return [];
    }
  }
}

module.exports = { ParticipantAwareness };
