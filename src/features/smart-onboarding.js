/**
 * smart-onboarding.js — 신규 입사자 자동 맥락 브리핑.
 *
 * 새 팀원이 개인 온보딩을 완료하면,
 * 팀의 최근 핵심 결정사항 + 아키텍처 결정 + 진행 중인 프로젝트를
 * DM으로 자동 브리핑합니다.
 *
 * "지난 3개월간 팀에서 일어난 일" 요약 → 멘토 역할의 70% 대체.
 */
const { config } = require('../config');
const { createLogger } = require('../shared/logger');

const log = createLogger('features:smart-onboarding');

/**
 * 신규 입사자에게 팀 맥락 브리핑 생성.
 *
 * @param {string} userId - 신규 멤버 Slack user ID
 * @param {object} deps - { semantic, entity, slackClient }
 * @returns {string} 브리핑 텍스트
 */
async function sendNewMemberBriefing(userId, deps) {
  const { semantic, entity, slackClient } = deps;
  if (!slackClient) return;

  const profile = entity?.get?.('user', userId);
  const name = profile?.name || '새 팀원';
  const dept = profile?.properties?.department || '';

  const sections = [];
  sections.push(`👋 *${name}님, ${config.organization?.name || '팀'}에 오신 걸 환영합니다!*`);
  sections.push('');
  sections.push('팀에서 최근에 있었던 중요한 내용을 정리해 드릴게요.');

  // 1. 핵심 결정사항 (L3 Semantic에서 decision 타입)
  if (semantic) {
    try {
      const decisions = semantic.searchWithPools?.('결정 확정 합의 decided confirmed', ['team'], 10) || [];

      if (decisions.length > 0) {
        sections.push('');
        sections.push('*📋 최근 핵심 결정사항*');
        for (const d of decisions.slice(0, 7)) {
          const ch = d.channel_id ? `<#${d.channel_id}>` : '';
          sections.push(`  • ${d.content?.slice(0, 150)} ${ch}`);
        }
      }
    } catch { /* search 미지원 시 스킵 */ }
  }

  // 2. 부서 관련 정보 (해당 부서 결정사항)
  if (dept && semantic) {
    try {
      const deptInfo = semantic.searchWithPools?.(dept, ['team'], 5) || [];
      if (deptInfo.length > 0) {
        sections.push('');
        sections.push(`*🏢 ${dept} 부서 관련*`);
        for (const d of deptInfo.slice(0, 3)) {
          sections.push(`  • ${d.content?.slice(0, 150)}`);
        }
      }
    } catch { /* 스킵 */ }
  }

  // 3. 진행 중인 프로젝트
  const projects = config.organization?.projects || [];
  const activeProjects = projects.filter(p => p.status === 'in_progress');
  if (activeProjects.length > 0) {
    sections.push('');
    sections.push('*🚀 진행 중인 프로젝트*');
    for (const p of activeProjects) {
      sections.push(`  • *${p.name}* — ${p.description || ''} (마감: ${p.deadline || 'TBD'})`);
    }
  }

  // 4. 팀원 소개
  const members = config.organization?.members || [];
  if (members.length > 0) {
    sections.push('');
    sections.push('*👥 팀원*');
    for (const m of members.slice(0, 10)) {
      const expertise = m.expertise?.length ? ` [${m.expertise.join(', ')}]` : '';
      sections.push(`  • *${m.name}* — ${m.role}${expertise}`);
    }
  }

  sections.push('');
  sections.push('궁금한 게 있으면 언제든 저한테 물어보세요. 채널에서 @Effy 또는 DM으로 질문하시면 됩니다!');

  const briefingText = sections.join('\n');

  // DM으로 전송
  try {
    await slackClient.chat.postMessage({
      channel: userId,  // DM은 userId를 channel로 사용
      text: briefingText,
      unfurl_links: false,
    });
    log.info('New member briefing sent', { userId, name });
  } catch (err) {
    log.warn('New member briefing failed', { userId, error: err.message });
  }

  return briefingText;
}

const HELP_ENTRY = {
  icon: '🚀',
  title: '신규 멤버 온보딩',
  lines: [
    '새 팀원이 들어오면 최근 결정사항, 진행 중인 프로젝트,',
    '팀 구조를 자동으로 브리핑합니다.',
  ],
  order: 40,
};

module.exports = { sendNewMemberBriefing, HELP_ENTRY };
