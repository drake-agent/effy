/**
 * user-profile.js — User Profile Hydration for Effy v4.0.
 *
 * UserProfileBuilder queries MemoryGraph for a specific user's memories
 * across all types (fact, preference, decision, identity, event, observation, goal, todo)
 * and condenses them into a structured user profile document with TTL-based caching.
 *
 * 사용자 프로필을 MemoryGraph에서 로드하여 시스템 프롬프트에 주입:
 * - 신원 (identity): 사용자가 누구인가
 * - 선호 (preference): 어떤 것을 좋아하는가
 * - 최근 결정 (decision): 최근에 내린 결정들
 * - 활성 목표 (goal): 진행 중인 목표들
 * - 활성 할일 (todo): 해야 할 일들
 * - 주요 사실 (fact): 알아두면 좋은 배경 정보
 *
 * 캐싱: 15분 TTL (기본값)
 * save_knowledge 후: refreshProfile(userId) 호출 → 캐시 무효화
 */
const { createLogger } = require('../shared/logger');
const { sanitizeForPrompt } = require('../shared/prompt-sanitizer');

const log = createLogger('memory:user-profile');

const MEMORY_TYPES = ['fact', 'preference', 'decision', 'identity', 'event', 'observation', 'goal', 'todo'];

class UserProfileBuilder {
  /**
   * @param {MemoryGraph} graph - MemoryGraph 인스턴스
   * @param {Object} [options={}]
   * @param {number} [options.cacheTtlMs=900000] - 캐시 TTL (밀리초, 기본 15분)
   * @param {number} [options.maxMemoriesPerType=5] - 타입별 최대 메모리 수 (캐시 크기 제한)
   */
  constructor(graph, options = {}) {
    this._graph = graph;
    this._cache = new Map(); // userId → { profile, updatedAt }
    this._cacheTtlMs = options.cacheTtlMs || 15 * 60 * 1000; // 15 min
    this._maxMemoriesPerType = options.maxMemoriesPerType || 5;
    this._maxCacheSize = options.maxCacheSize || 500;
  }

  /**
   * 캐시된 프로필을 반환하거나, 없으면 빌드.
   * @param {string} userId
   * @returns {Promise<Object>} 구조화된 프로필
   *   { identity: [], preferences: [], decisions: [], goals: [], todos: [], facts: [], observation: [] }
   */
  async getProfile(userId) {
    if (!userId) {
      return this._emptyProfile();
    }

    const cached = this._cache.get(userId);
    if (cached && Date.now() - cached.updatedAt < this._cacheTtlMs) {
      log.debug('Profile cache hit', { userId });
      return cached.profile;
    }

    const profile = await this._buildProfile(userId);

    // Evict stale entries if cache exceeds max size
    if (this._cache.size >= this._maxCacheSize) {
      const now = Date.now();
      for (const [key, entry] of this._cache) {
        if (now - entry.updatedAt >= this._cacheTtlMs) this._cache.delete(key);
      }
      // If still at capacity, delete oldest entry
      if (this._cache.size >= this._maxCacheSize) {
        const oldestKey = this._cache.keys().next().value;
        this._cache.delete(oldestKey);
      }
    }

    this._cache.set(userId, { profile, updatedAt: Date.now() });
    log.debug('Profile built and cached', { userId });
    return profile;
  }

  /**
   * 캐시 무효화 (새 메모리 저장 후 호출).
   * @param {string} userId
   */
  async refreshProfile(userId) {
    if (!userId) return;
    this._cache.delete(userId);
    log.debug('Profile cache invalidated', { userId });
  }

  /**
   * 프로필을 시스템 프롬프트 주입용 텍스트로 변환.
   * @param {string} userId
   * @returns {Promise<string>} 마크다운 포맷의 프로필 텍스트 (800 토큰 이하)
   */
  async getProfileText(userId) {
    if (!userId) {
      return '';
    }

    const profile = await this.getProfile(userId);
    return this._formatProfileForPrompt(userId, profile);
  }

  /**
   * 빈 프로필 객체 반환.
   * @returns {Object}
   */
  _emptyProfile() {
    return {
      identity: [],
      preferences: [],
      decisions: [],
      goals: [],
      todos: [],
      facts: [],
      observations: [],
      events: [],
    };
  }

  /**
   * 사용자의 모든 메모리를 MemoryGraph에서 쿼리하여 프로필 빌드.
   * @param {string} userId
   * @returns {Promise<Object>} 구조화된 프로필
   */
  async _buildProfile(userId) {
    const profile = this._emptyProfile();

    try {
      // 각 타입별로 sourceUser 필터로 조회
      for (const memType of MEMORY_TYPES) {
        try {
          const memories = await this._graph.getByType(memType, {
            limit: this._maxMemoriesPerType,
            archived: false,
            minImportance: 0,
            sourceUser: userId,
          });

          if (memories.length === 0) continue;

          const condensed = memories.map(m => ({
            content: m.content,
            importance: m.importance,
            accessCount: m.access_count,
            createdAt: m.created_at,
          }));

          // 타입별로 프로필 객체에 매핑
          switch (memType) {
            case 'identity':
              profile.identity = condensed;
              break;
            case 'preference':
              profile.preferences = condensed;
              break;
            case 'decision':
              profile.decisions = condensed;
              break;
            case 'goal':
              profile.goals = condensed;
              break;
            case 'todo':
              profile.todos = condensed;
              break;
            case 'fact':
              profile.facts = condensed;
              break;
            case 'observation':
              profile.observations = condensed;
              break;
            case 'event':
              profile.events = condensed;
              break;
          }
        } catch (typeErr) {
          log.warn('Failed to fetch memories by type', { userId, type: memType, error: typeErr.message });
          // 특정 타입 실패 시에도 계속 진행
        }
      }

      log.info('Profile built', {
        userId,
        totalMemories: Object.values(profile).reduce((sum, arr) => sum + arr.length, 0),
      });
    } catch (err) {
      log.error('Profile build failed', { userId, error: err.message });
      // 전체 실패 시에도 빈 프로필 반환 (graceful degradation)
    }

    return profile;
  }

  /**
   * 프로필을 시스템 프롬프트 주입용 텍스트로 포맷.
   * 토큰 제한 (약 800)을 고려하여 요약.
   * @param {string} userId
   * @param {Object} profile
   * @returns {string} 마크다운 포맷 텍스트
   */
  _formatProfileForPrompt(userId, profile) {
    const lines = [];

    // 헤더
    lines.push(`[사용자 프로필: ${userId}]`);

    // 신원
    if (profile.identity.length > 0) {
      const identities = profile.identity
        .slice(0, 2)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`신원:\n${identities}`);
    }

    // 선호
    if (profile.preferences.length > 0) {
      const prefs = profile.preferences
        .slice(0, 3)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`선호:\n${prefs}`);
    }

    // 최근 결정
    if (profile.decisions.length > 0) {
      const decs = profile.decisions
        .slice(0, 2)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`최근 결정:\n${decs}`);
    }

    // 활성 목표
    if (profile.goals.length > 0) {
      const goals = profile.goals
        .slice(0, 2)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`활성 목표:\n${goals}`);
    }

    // 활성 할일
    if (profile.todos.length > 0) {
      const todos = profile.todos
        .slice(0, 2)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`활성 할일:\n${todos}`);
    }

    // 주요 사실
    if (profile.facts.length > 0) {
      const facts = profile.facts
        .slice(0, 2)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`주요 사실:\n${facts}`);
    }

    // 관찰
    if (profile.observations.length > 0) {
      const obs = profile.observations
        .slice(0, 1)
        .map(m => `  • ${sanitizeForPrompt(m.content)}`)
        .join('\n');
      lines.push(`최근 관찰:\n${obs}`);
    }

    // 프로필 없으면 빈 문자열
    if (lines.length === 1) {
      return '';
    }

    return lines.join('\n');
  }
}

module.exports = { UserProfileBuilder };
