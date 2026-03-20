/**
 * bulletin.js — Memory Bulletin 생성 + 캐시.
 *
 * 채널/유저별 1h TTL 캐시.
 * cache miss → semantic_memory에서 결정사항 + 목표 조회 → Haiku 브리핑 생성.
 */
const { config } = require('../config');
const { semantic } = require('./manager');
const { client } = require('../shared/anthropic');
const { getDefaultModel } = require('../shared/model-config');

class MemoryBulletin {
  constructor() {
    const bulletinCfg = config.bulletin || {};
    this.enabled = bulletinCfg.enabled !== false;
    this.cacheTtlMs = bulletinCfg.cacheTtlMs || 3600000;
    this.maxLength = bulletinCfg.maxLength || 300;

    /** @type {Map<string, { text: string, expiresAt: number }>} */
    this._cache = new Map();
  }

  /** Bulletin 조회 (캐시 우선). */
  async get(channelId, userId) {
    if (!this.enabled) return '';

    const cacheKey = `${channelId}:${userId}`;
    const cached = this._cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.text;

    try {
      const bulletin = await this._generate(channelId, userId);
      this._cache.set(cacheKey, { text: bulletin, expiresAt: Date.now() + this.cacheTtlMs });
      return bulletin;
    } catch (err) {
      console.warn(`[bulletin] Generation failed: ${err.message}`);
      return '';
    }
  }

  /** 캐시 무효화 — 새 결정사항 저장 시 호출. */
  invalidate(channelId) {
    for (const [key] of this._cache) {
      if (key.startsWith(`${channelId}:`)) this._cache.delete(key);
    }
  }

  clear() { this._cache.clear(); }

  /** Bulletin 생성 — semantic_memory 조회 + Haiku 요약. */
  async _generate(channelId, userId) {
    const decisions = semantic.getChannelDecisions(channelId, 3);

    let goals = [];
    try {
      const { getDb } = require('../db/sqlite');
      const db = getDb();
      goals = db.prepare(`
        SELECT content FROM semantic_memory
        WHERE (channel_id = ? OR user_id = ?)
          AND memory_type = 'Goal'
          AND archived = 0
        ORDER BY created_at DESC LIMIT 2
      `).all(channelId, userId);
    } catch { /* memory_type 컬럼 미존재 시 무시 */ }

    if (decisions.length === 0 && goals.length === 0) return '';

    const decisionText = decisions.map(d => `- ${d.content.slice(0, 100)}`).join('\n');
    const goalText = goals.map(g => `- ${g.content.slice(0, 100)}`).join('\n');

    const input = [
      decisions.length > 0 ? `[최근 결정사항]\n${decisionText}` : '',
      goals.length > 0 ? `[진행 중 목표]\n${goalText}` : '',
    ].filter(Boolean).join('\n\n');

    try {
      const response = await client.messages.create({
        model: getDefaultModel(),
        max_tokens: 150,
        system: '아래 정보를 2~3문장으로 간결하게 브리핑하세요. "[채널 최근 결정] ... [진행 중 목표] ..." 형태로. 브리핑문만 출력하세요.',
        messages: [{ role: 'user', content: input }],
      });
      return (response.content[0]?.text || '').slice(0, this.maxLength);
    } catch (err) {
      console.warn(`[bulletin] Haiku briefing failed: ${err.message}`);
      return input.slice(0, this.maxLength);
    }
  }
}

module.exports = { MemoryBulletin };
