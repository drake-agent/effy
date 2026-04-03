/**
 * morning-briefing.js — 개인화 아침 브리핑.
 *
 * 매일 지정 시간에 **각 사용자에게 개인화된 브리핑을 DM으로** 전달.
 *
 * 개인화 기준:
 * - 사용자 부서 → 해당 부서 채널의 결정사항 우선
 * - 사용자 참여 채널 → 활동 채널 기반 토픽 필터
 * - 사용자 역할 → CTO면 전체 현황, Frontend Lead면 프론트엔드 중심
 * - 미확인 대화 → 사용자가 마지막 활동 이후 발생한 이벤트만
 *
 * 전달 방식: 채널 X → 사용자별 DM
 */
const { config } = require('../config');
const { entity } = require('../memory/manager');
const { createLogger } = require('../shared/logger');

const log = createLogger('features:briefing');

class MorningBriefing {
  /**
   * @param {object} opts
   * @param {object} opts.slackClient - Slack WebClient
   * @param {object} opts.insightStore - Observer InsightStore
   * @param {object} opts.semantic - L3 Semantic memory
   * @param {object} opts.episodic - L2 Episodic memory
   */
  constructor(opts = {}) {
    this.slackClient = opts.slackClient || null;
    this.insightStore = opts.insightStore || null;
    this.semantic = opts.semantic || null;
    this.episodic = opts.episodic || null;

    this.config = config.features?.briefing || {};
    this.enabled = this.config.enabled !== false;
    this.hourKST = this.config.hourKST ?? 9;

    this._timer = null;
  }

  start() {
    if (!this.enabled) {
      log.info('Morning briefing disabled');
      return;
    }

    const scheduleNext = () => {
      const now = new Date();
      const kstHour = (now.getUTCHours() + 9) % 24;
      const kstMin = now.getUTCMinutes();
      const kstSec = now.getUTCSeconds();

      // BL-6 fix: Correct scheduler drift — when kstHour === hourKST, check minutes
      let hoursUntil = this.hourKST - kstHour;
      if (hoursUntil < 0) {
        hoursUntil += 24;
      } else if (hoursUntil === 0) {
        // Same hour: if minutes have passed the target (top of hour), schedule for tomorrow
        if (kstMin > 0 || kstSec > 0) hoursUntil = 24;
      }
      let delayMs = hoursUntil * 3600000 - kstMin * 60000 - kstSec * 1000;
      if (delayMs <= 0) delayMs += 86400000;  // 안전장치: 음수면 +24h

      this._timer = setTimeout(async () => {
        await this.sendAll();
        scheduleNext();
      }, delayMs);

      log.info('Morning briefing scheduled', { nextInMs: delayMs, hourKST: this.hourKST });
    };

    scheduleNext();
  }

  /**
   * 모든 등록된 사용자에게 개인화 브리핑 전송.
   */
  async sendAll() {
    if (!this.slackClient) return;

    // Entity Memory에서 프로필이 있는 사용자 목록 조회
    const members = config.organization?.members || [];
    // config에 없으면 Entity Memory에서 조회 시도
    const users = members.length > 0
      ? members.map(m => ({ userId: m.slackId, ...m }))
      : await this._getRegisteredUsers();

    if (users.length === 0) {
      log.debug('No users for briefing');
      return;
    }

    // R11-PERF-1: 병렬 전송 (5개씩 배치)
    let sent = 0;
    const BATCH_SIZE = 5;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (user) => {
          const userId = user.userId || user.slackId;
          if (!userId) return;
          const briefing = await this._buildPersonalBriefing(userId, user);
          if (!briefing) return;
          await this.slackClient.chat.postMessage({
            channel: userId,
            text: briefing,
            unfurl_links: false,
          });
          return true;
        })
      );
      sent += results.filter(r => r.status === 'fulfilled' && r.value).length;
    }

    log.info('Morning briefings sent', { total: users.length, sent });
  }

  /**
   * 사용자별 개인화 브리핑 생성.
   */
  async _buildPersonalBriefing(userId, userInfo) {
    const sections = [];
    const since = Date.now() - 24 * 60 * 60 * 1000;  // 24시간
    const name = userInfo.name || '팀원';
    const dept = userInfo.department || '';
    const role = userInfo.role || '';

    sections.push(`☀️ *Good morning, ${name}!*  (${new Date().toLocaleDateString('ko-KR')})`);

    // ─── 1. 내 부서 관련 결정사항 ───
    const decisions = this._getRecentDecisions(since, dept);
    if (decisions.length > 0) {
      sections.push('');
      sections.push('*📋 내 부서 관련 결정사항*');
      for (const d of decisions.slice(0, 5)) {
        const ch = d.channel ? `<#${d.channel}>` : '';
        sections.push(`  • ${d.content?.slice(0, 120)} ${ch}`);
      }
    }

    // ─── 2. 전체 중요 결정 (내 부서 외) ───
    const otherDecisions = this._getRecentDecisions(since, '').filter(d =>
      !decisions.some(md => md.id === d.id)
    );
    if (otherDecisions.length > 0) {
      sections.push('');
      sections.push('*🏢 팀 전체 결정사항*');
      for (const d of otherDecisions.slice(0, 3)) {
        const ch = d.channel ? `<#${d.channel}>` : '';
        sections.push(`  • ${d.content?.slice(0, 120)} ${ch}`);
      }
    }

    // ─── 3. 나한테 온 미답변 질문 / 멘션 ───
    const mentions = await this._getUserMentions(userId, since);
    if (mentions.length > 0) {
      sections.push('');
      sections.push('*💬 나를 언급한 대화*');
      for (const m of mentions.slice(0, 3)) {
        sections.push(`  • ${m.content?.slice(0, 120)}`);
      }
    }

    // ─── 4. 미답변 질문 (도움 줄 수 있는) ───
    const openQuestions = this._getOpenQuestions(since, userInfo.expertise || []);
    if (openQuestions.length > 0) {
      sections.push('');
      sections.push('*❓ 도움 줄 수 있는 미답변 질문*');
      for (const q of openQuestions.slice(0, 2)) {
        const ch = q.channel ? `<#${q.channel}>` : '';
        sections.push(`  • ${ch} ${q.content?.slice(0, 120)}`);
      }
    }

    // 내용이 없으면 브리핑 안 보냄
    if (sections.length <= 1) return null;

    sections.push('');
    sections.push('_자세한 내용은 @Effy 에게 물어보세요._');

    return sections.join('\n');
  }

  /**
   * 최근 결정사항 조회 (InsightStore에서).
   */
  _getRecentDecisions(since, dept) {
    if (!this.insightStore) return [];
    const deptChannels = this._getDeptChannels(dept);

    return [...(this.insightStore.insights?.values() || [])]
      .filter(i => {
        if (i.type !== 'decision') return false;
        if (i.createdAt < since) return false;
        // 부서 필터: dept가 있으면 해당 부서 채널만
        if (dept && deptChannels.length > 0) {
          return deptChannels.includes(i.channel);
        }
        return true;
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);
  }

  /**
   * 부서별 채널 목록 조회.
   */
  _getDeptChannels(dept) {
    if (!dept) return [];
    const departments = config.organization?.departments || [];
    const found = departments.find(d => d.id === dept || d.name?.toLowerCase() === dept);
    return found?.channels || [];
  }

  /**
   * 사용자 멘션 조회 (L2 Episodic에서).
   */
  async _getUserMentions(userId, since) {
    if (!this.episodic) return [];
    try {
      const sinceDate = new Date(since).toISOString();
      return (await this.episodic.getMentions?.(userId, { since: sinceDate, limit: 5 })) || [];
    } catch (e) { log.debug('getMentions failed', { userId, error: e.message }); return []; }
  }

  /**
   * 미답변 질문 중 사용자 전문분야와 매칭되는 것.
   */
  _getOpenQuestions(since, expertise) {
    if (!this.insightStore || !expertise?.length) return [];
    const keywords = expertise.map(e => e.toLowerCase());

    return [...(this.insightStore.insights?.values() || [])]
      .filter(i => {
        if (i.type !== 'question' || i.status !== 'pending') return false;
        if (i.createdAt < since) return false;
        // 전문분야 키워드 매칭
        const content = (i.content || '').toLowerCase();
        return keywords.some(k => content.includes(k));
      })
      .slice(0, 3);
  }

  /**
   * Entity Memory에서 등록된 사용자 목록 (config에 없을 때 fallback).
   */
  async _getRegisteredUsers() {
    try {
      const all = (await entity.list?.('user')) || [];
      return all
        .filter(u => u.properties?.role)  // 온보딩 완료된 사용자만
        .map(u => ({
          userId: u.entity_id,  // R16-BUG-1: entity_id가 Slack user ID (id는 auto-increment PK)
          name: u.name,
          role: u.properties?.role || '',
          department: u.properties?.department || '',
          expertise: u.properties?.expertise || [],
        }));
    } catch (e) { log.debug('getRegisteredUsers failed', { error: e.message }); return []; }
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
  }
}

const HELP_ENTRY = {
  icon: '🌅',
  title: '아침 브리핑',
  lines: [
    '매일 아침, 나만을 위한 브리핑을 받아보세요.',
    '내 부서 결정사항, 나를 멘션한 대화, 미답변 질문까지.',
    '100명이 각자 다른 브리핑. 스크롤 안 해도 됩니다.',
  ],
  order: 10,
};

module.exports = { MorningBriefing, HELP_ENTRY };
