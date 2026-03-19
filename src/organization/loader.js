/**
 * loader.js — Organization Structure Loader.
 *
 * effy.config.yaml의 organization 섹션을 읽어서:
 * 1. L4 Entity Memory에 사용자/부서 프로필 upsert
 * 2. 에이전트 시스템 프롬프트에 조직 맥락 주입용 텍스트 생성
 *
 * 부팅 시 1회 실행 (app.js에서 호출).
 */
const { config } = require('../config');
const { entity } = require('../memory/manager');
const { createLogger } = require('../shared/logger');

const log = createLogger('org:loader');

/**
 * Organization config → Entity Memory에 로드.
 *
 * @returns {{ memberCount, deptCount, projectCount }}
 */
function loadOrganization() {
  const org = config.organization;
  if (!org) return { memberCount: 0, deptCount: 0, projectCount: 0 };

  const departments = org.departments || [];
  const members = org.members || [];
  const projects = org.projects || [];

  // 부서 → Entity Memory (type: 'department')
  for (const dept of departments) {
    if (!dept.id) continue;
    entity.upsert('department', dept.id, dept.name || dept.id, {
      lead: dept.lead || '',
      channels: dept.channels || [],
      description: dept.description || '',
    });
  }

  // 멤버 → Entity Memory (type: 'user') — 기존 Entity와 merge
  for (const member of members) {
    if (!member.slackId) continue;
    entity.upsert('user', member.slackId, member.name || '', {
      role: member.role || '',
      department: member.department || '',
      responsibilities: member.responsibilities || [],
      expertise: member.expertise || [],
    });
  }

  // 프로젝트 → Entity Memory (type: 'project')
  for (const proj of projects) {
    if (!proj.id) continue;
    entity.upsert('project', proj.id, proj.name || proj.id, {
      owner: proj.owner || '',
      members: proj.members || [],
      status: proj.status || 'unknown',
      deadline: proj.deadline || '',
      description: proj.description || '',
    });
  }

  log.info('Organization loaded', {
    name: org.name || '(unnamed)',
    departments: departments.length,
    members: members.length,
    projects: projects.length,
  });

  return {
    memberCount: members.length,
    deptCount: departments.length,
    projectCount: projects.length,
  };
}

/**
 * 에이전트 시스템 프롬프트에 주입할 조직 맥락 텍스트 생성.
 *
 * @returns {string} XML 형태 조직 정보 (빈 config이면 빈 문자열)
 */
function buildOrgContext() {
  const org = config.organization;
  if (!org || (!org.name && !(org.departments?.length) && !(org.members?.length))) return '';

  const parts = [];

  if (org.name) {
    parts.push(`Company: ${org.name}`);
    if (org.description) parts.push(`About: ${org.description}`);
  }

  const departments = org.departments || [];
  if (departments.length > 0) {
    parts.push('Departments:');
    for (const d of departments) {
      parts.push(`  - ${d.name || d.id}: ${d.description || ''} (lead: ${d.lead || 'N/A'})`);
    }
  }

  const members = org.members || [];
  if (members.length > 0) {
    parts.push('Team Members:');
    for (const m of members) {
      const expertise = m.expertise?.length ? ` [${m.expertise.join(', ')}]` : '';
      parts.push(`  - ${m.name} (${m.role}, ${m.department})${expertise}`);
    }
  }

  const projects = org.projects || [];
  if (projects.length > 0) {
    parts.push('Active Projects:');
    for (const p of projects) {
      parts.push(`  - ${p.name}: ${p.description || ''} (status: ${p.status}, deadline: ${p.deadline || 'N/A'})`);
    }
  }

  return `<organization>\n${parts.join('\n')}\n</organization>`;
}

module.exports = { loadOrganization, buildOrgContext };
