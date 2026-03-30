const { createLogger } = require('../shared/logger');
const crypto = require('crypto');

const log = createLogger('memory:user-scoped');

class UserScopedMemory {
  /**
   * @param {Object} opts
   * @param {Object} opts.db - better-sqlite3 인스턴스
   */
  constructor(opts = {}) {
    this.db = opts.db;
    if (!this.db) {
      throw new Error('UserScopedMemory requires opts.db (better-sqlite3 instance)');
    }
  }

  /** 스키마 초기화. */
  init() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS canonical_users (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          first_seen TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS user_platform_links (
          platform TEXT NOT NULL,
          platform_user_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES canonical_users(user_id),
          linked_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (platform, platform_user_id)
        );

        CREATE INDEX IF NOT EXISTS idx_upl_user ON user_platform_links(user_id);

        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT REFERENCES canonical_users(user_id),
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          channel_id TEXT,
          agent_id TEXT,
          importance INTEGER DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_memories_channel ON memories(channel_id);
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      `);

      log.info('✓ 스키마 초기화 완료');
    } catch (err) {
      log.error('✗ 스키마 초기화 실패', { error: err.message });
      throw err;
    }
  }

  /**
   * 플랫폼 ID → 정규 사용자 ID 해석 (없으면 생성).
   * @param {string} platform - 'discord', 'slack', 'teams', 'web'
   * @param {string} platformUserId - 플랫폼 고유 ID
   * @param {string} [displayName]
   * @returns {{ userId: string, created: boolean }}
   */
  resolveUser(platform, platformUserId, displayName = null) {
    try {
      // 기존 링크 확인
      const existing = this.db
        .prepare('SELECT user_id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?')
        .get(platform, platformUserId);

      if (existing) {
        // 마지막 활동 시간 업데이트
        this.db
          .prepare('UPDATE canonical_users SET last_seen = datetime(\'now\') WHERE user_id = ?')
          .run(existing.user_id);

        return { userId: existing.user_id, created: false };
      }

      // 새 정규 사용자 ID 생성
      const userId = this._generateUserId();

      // 정규 사용자 레코드 생성
      this.db
        .prepare(`
          INSERT INTO canonical_users (user_id, display_name)
          VALUES (?, ?)
        `)
        .run(userId, displayName || `${platform}:${platformUserId}`);

      // 플랫폼 링크 생성
      this.db
        .prepare(`
          INSERT INTO user_platform_links (platform, platform_user_id, user_id)
          VALUES (?, ?, ?)
        `)
        .run(platform, platformUserId, userId);

      log.info('사용자 생성', { userId, platform, platformUserId, displayName });
      return { userId, created: true };
    } catch (err) {
      log.error('✗ resolveUser 실패', { platform, platformUserId, error: err.message });
      throw err;
    }
  }

  /**
   * 크로스 플랫폼 ID 연결 (같은 사용자의 다른 플랫폼 ID 매핑).
   * @param {string} userId - 정규 사용자 ID
   * @param {string} platform
   * @param {string} platformUserId
   */
  linkPlatform(userId, platform, platformUserId) {
    try {
      // 플랫폼이 이미 다른 사용자에게 연결되어 있는지 확인
      const existing = this.db
        .prepare('SELECT user_id FROM user_platform_links WHERE platform = ? AND platform_user_id = ?')
        .get(platform, platformUserId);

      if (existing && existing.user_id !== userId) {
        throw new Error(`Platform ID already linked to another user: ${existing.user_id}`);
      }

      if (existing) {
        return; // 이미 연결됨
      }

      // 사용자 존재 확인
      const user = this.db
        .prepare('SELECT user_id FROM canonical_users WHERE user_id = ?')
        .get(userId);

      if (!user) {
        throw new Error(`User not found: ${userId}`);
      }

      // 링크 생성
      this.db
        .prepare(`
          INSERT INTO user_platform_links (platform, platform_user_id, user_id)
          VALUES (?, ?, ?)
        `)
        .run(platform, platformUserId, userId);

      log.info('플랫폼 링크 생성', { userId, platform, platformUserId });
    } catch (err) {
      log.error('✗ linkPlatform 실패', { userId, platform, platformUserId, error: err.message });
      throw err;
    }
  }

  /**
   * 유저 스코프 메모리 저장.
   * @param {Object} memory - { type, content, channelId, agentId, importance }
   * @param {string} [userId] - null이면 글로벌 메모리
   * @returns {{ id: number, scope: 'user'|'global' }}
   */
  saveMemory(memory, userId = null) {
    try {
      const { type, content, channelId = null, agentId = null, importance = 1 } = memory;

      if (!type || !content) {
        throw new Error('Memory requires type and content');
      }

      const result = this.db
        .prepare(`
          INSERT INTO memories (user_id, type, content, channel_id, agent_id, importance)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(userId || null, type, content, channelId, agentId, importance);

      const scope = userId ? 'user' : 'global';
      log.info('메모리 저장', { id: result.lastInsertRowid, scope, type, userId });

      return { id: result.lastInsertRowid, scope };
    } catch (err) {
      log.error('✗ saveMemory 실패', { userId, type: memory.type, error: err.message });
      throw err;
    }
  }

  /**
   * 유저 스코프 메모리 검색 (해당 유저 + 글로벌 병합).
   * @param {string} query
   * @param {Object} opts - { userId, channelId, agentId, limit, types }
   * @returns {Array<{ ...memory, scope: 'user'|'global' }>}
   */
  searchMemories(query, opts = {}) {
    try {
      const { userId = null, channelId = null, agentId = null, limit = 50, types = null } = opts;

      // DOS protection: limit query length
      if (query && query.length > 1000) {
        log.warn('search query too long, truncating', { queryLength: query.length });
        query = query.substring(0, 1000);
      }

      let sql = `
        SELECT *, 'user' as scope FROM memories
        WHERE (user_id = ? OR user_id IS NULL)
          AND content LIKE ?
      `;
      const params = [userId, `%${query}%`];

      if (channelId) {
        sql += ' AND channel_id = ?';
        params.push(channelId);
      }

      if (agentId) {
        sql += ' AND agent_id = ?';
        params.push(agentId);
      }

      if (types && Array.isArray(types) && types.length > 0) {
        const placeholders = types.map(() => '?').join(',');
        sql += ` AND type IN (${placeholders})`;
        params.push(...types);
      }

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const results = this.db.prepare(sql).all(...params);

      return results || [];
    } catch (err) {
      log.error('✗ searchMemories 실패', { query, userId: opts.userId, error: err.message });
      return [];
    }
  }

  /**
   * 특정 유저의 모든 플랫폼 ID 조회.
   * @param {string} userId
   * @returns {Array<{ platform: string, platformUserId: string, linkedAt: string }>}
   */
  getUserPlatforms(userId) {
    try {
      const results = this.db
        .prepare(`
          SELECT platform, platform_user_id as platformUserId, linked_at as linkedAt
          FROM user_platform_links
          WHERE user_id = ?
          ORDER BY linked_at ASC
        `)
        .all(userId);

      return results || [];
    } catch (err) {
      log.error('✗ getUserPlatforms 실패', { userId, error: err.message });
      return [];
    }
  }

  /**
   * 유저 프로필 정보 조회.
   * @param {string} userId
   * @returns {{ userId, displayName, platforms: Array, memoryCount: number, firstSeen, lastSeen }}
   */
  getUserProfile(userId) {
    try {
      const user = this.db
        .prepare(`
          SELECT user_id as userId, display_name as displayName, first_seen as firstSeen, last_seen as lastSeen
          FROM canonical_users
          WHERE user_id = ?
        `)
        .get(userId);

      if (!user) {
        return null;
      }

      const platforms = this.getUserPlatforms(userId);

      const countResult = this.db
        .prepare('SELECT COUNT(*) as count FROM memories WHERE user_id = ?')
        .get(userId);

      const memoryCount = countResult?.count || 0;

      return {
        ...user,
        platforms,
        memoryCount,
      };
    } catch (err) {
      log.error('✗ getUserProfile 실패', { userId, error: err.message });
      return null;
    }
  }

  /**
   * 정규 사용자 ID 생성 (UUID v4).
   * @private
   * @returns {string}
   */
  _generateUserId() {
    return crypto.randomUUID ? crypto.randomUUID() : this._generateFallbackUuid();
  }

  /**
   * UUID 생성 폴백 (레거시 Node.js 호환성).
   * @private
   * @returns {string}
   */
  _generateFallbackUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

module.exports = { UserScopedMemory };
