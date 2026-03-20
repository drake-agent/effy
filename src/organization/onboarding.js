/**
 * onboarding.js — 대화형 온보딩 (조직 + 개인).
 *
 * 두 가지 온보딩:
 *
 * A. 조직 온보딩 (Admin, 1회)
 *    → organization.name이 비어있을 때 admin 첫 메시지에서 트리거
 *    → 회사명, 부서, 프로젝트
 *
 * B. 개인 온보딩 (모든 사용자, 각자 1회)
 *    → Entity Memory에 해당 userId의 role이 없을 때 트리거
 *    → 이름, 역할, 부서, 전문분야
 *
 * 상태 관리: Map (userId → OnboardingState)
 */
const { config } = require('../config');
const { entity } = require('../memory/manager');
const { createLogger } = require('../shared/logger');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const log = createLogger('org:onboarding');

const sessions = new Map();

// ═══════════════════════════════════════════════════════
// A. 조직 온보딩 (Admin)
// ═══════════════════════════════════════════════════════

const ORG_STEPS = {
  COMPANY: 'org_company',
  DEPARTMENTS: 'org_departments',
  DEPT_DETAILS: 'org_dept_details',
  PROJECTS: 'org_projects',
  DONE: 'org_done',
};

// ISSUE-1: config는 메모리 캐시 — 파일 수정해도 런타임에 반영 안 됨
// 조직 온보딩 완료 플래그를 메모리에 유지
let _orgOnboardingDone = false;

function needsOrgOnboarding() {
  if (_orgOnboardingDone) return false;
  if (config.organization?.name) { _orgOnboardingDone = true; return false; }
  return true;
}

function startOrgOnboarding(userId) {
  sessions.set(userId, {
    type: 'org',
    step: ORG_STEPS.COMPANY,
    data: { name: '', description: '', departments: [], projects: [] },
    pendingDeptIndex: 0,
  });
  return [
    '👋 안녕하세요! Effy 초기 설정을 시작합니다.',
    '',
    '**팀 이름**을 알려주세요.',
    '예: "AX팀" 또는 "디지털본부"',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════
// B. 개인 온보딩 (모든 사용자)
// ═══════════════════════════════════════════════════════

const PERSONAL_STEPS = {
  NAME_ROLE: 'personal_name_role',
  DEPARTMENT: 'personal_department',
  EXPERTISE: 'personal_expertise',
  DONE: 'personal_done',
};

// R5-BUG-2: 온보딩 완료 캐시 — 매 메시지마다 DB 조회 방지
const _onboardedUsers = new Set();

function needsPersonalOnboarding(userId) {
  if (_onboardedUsers.has(userId)) return false;
  const profile = entity.get('user', userId);
  if (profile?.properties?.role) {
    _onboardedUsers.add(userId);
    return false;
  }
  return true;
}

/**
 * Teams 표시 이름에서 실제 이름 추출.
 * "(허자연) C/KR/HQ/AX" → "허자연"
 * "Drake (Engineering)" → "Drake"
 */
function _extractName(displayName) {
  if (!displayName) return '';
  // 괄호 안 이름: (허자연) ... → 허자연
  const parenMatch = displayName.match(/\(([^)]+)\)/);
  if (parenMatch) return parenMatch[1].trim();
  // 슬래시/공백으로 조직경로 붙은 경우: 첫 단어만
  return displayName.split(/\s+/)[0].trim();
}

function startPersonalOnboarding(userId, opts = {}) {
  const knownName = _extractName(opts.displayName);

  if (knownName) {
    sessions.set(userId, {
      type: 'personal',
      step: PERSONAL_STEPS.NAME_ROLE,
      data: { name: knownName, role: '', department: '', expertise: [] },
      userId,
    });
    return [
      `👋 ${knownName}님, 반갑습니다! Effy입니다.`,
      '',
      '팀에서 맡고 계신 **직무**가 뭔가요?',
      '예: 프론트엔드 개발 / PM / 디자이너 / 데이터 분석',
    ].join('\n');
  }

  sessions.set(userId, {
    type: 'personal',
    step: PERSONAL_STEPS.NAME_ROLE,
    data: { name: '', role: '', department: '', expertise: [] },
    userId,
  });

  return [
    '👋 반갑습니다! Effy입니다.',
    '',
    '이름과 역할을 알려주세요.',
    '예: "Drake, CTO" 또는 "Alex, 프론트엔드 개발"',
  ].join('\n');
}

// ═══════════════════════════════════════════════════════
// 공통 API
// ═══════════════════════════════════════════════════════

function isOnboarding(userId) {
  const s = sessions.get(userId);
  return s && !s.step.endsWith('_done');
}

function processInput(userId, text) {
  const state = sessions.get(userId);
  if (!state) return null;

  const input = text.trim();

  if (state.type === 'org') return _processOrgInput(state, input);
  if (state.type === 'personal') return _processPersonalInput(state, input, userId);
  return null;
}

// ═══════════════════════════════════════════════════════
// 조직 온보딩 핸들러
// ═══════════════════════════════════════════════════════

function _processOrgInput(state, input) {
  switch (state.step) {
    case ORG_STEPS.COMPANY: {
      const parts = input.split(/[,，]/).map(s => s.trim());
      state.data.name = parts[0] || input;
      state.data.description = parts.slice(1).join(', ') || '';
      entity.upsert('organization', 'main', state.data.name, { description: state.data.description });

      state.step = ORG_STEPS.DEPARTMENTS;
      return [
        `✅ **${state.data.name}** 등록했습니다.`,
        '',
        '부서/팀 구조를 알려주세요.',
        '예: "Engineering, Product, Operations"',
        '_(없으면 "없음")_',
      ].join('\n');
    }

    case ORG_STEPS.DEPARTMENTS: {
      if (/^(없음|skip|스킵)$/i.test(input)) {
        state.step = ORG_STEPS.PROJECTS;
        return _askProjects();
      }
      const depts = input.split(/[,，]/).map(s => s.trim()).filter(s => s);
      if (depts.length === 0) {
        return '부서 이름을 최소 1개 입력해주세요.\n예: "Engineering" 또는 "Engineering, Product"';
      }
      state.data.departments = depts.map(name => ({
        id: name.toLowerCase().replace(/\s+/g, '-'), name, lead: '', channels: [], description: '',
      }));
      for (const d of state.data.departments) entity.upsert('department', d.id, d.name, {});

      state.step = ORG_STEPS.DEPT_DETAILS;
      state.pendingDeptIndex = 0;
      const first = state.data.departments[0];
      return [
        `✅ ${depts.length}개 부서 등록: ${depts.join(', ')}`,
        '',
        `**${first.name}** 부서: 리드, 채널, 설명을 알려주세요.`,
        '예: "리드 @drake, 채널 #engineering, 프로덕트 개발"',
        '_(건너뛰려면 "다음")_',
      ].join('\n');
    }

    case ORG_STEPS.DEPT_DETAILS: {
      const dept = state.data.departments[state.pendingDeptIndex];
      if (!/^(다음|next|스킵)$/i.test(input)) {
        const leadMatch = input.match(/@([\w.-]+)/);
        const channelMatch = input.match(/#([\w-]+)/g);
        const desc = input.replace(/리드\s*@[\w.-]+/i, '').replace(/#[\w-]+/g, '').replace(/채널/g, '').replace(/[,，]/g, '').trim();
        if (leadMatch) dept.lead = leadMatch[1];
        if (channelMatch) dept.channels = channelMatch.map(c => c.replace('#', ''));
        if (desc) dept.description = desc;
        entity.upsert('department', dept.id, dept.name, { lead: dept.lead, channels: dept.channels, description: dept.description });
      }

      state.pendingDeptIndex++;
      if (state.pendingDeptIndex < state.data.departments.length) {
        const next = state.data.departments[state.pendingDeptIndex];
        return `✅ ${dept.name} 완료.\n\n**${next.name}** 부서 정보를 알려주세요.\n_(건너뛰려면 "다음")_`;
      }

      state.step = ORG_STEPS.PROJECTS;
      return `✅ 모든 부서 설정 완료!\n\n${_askProjects()}`;
    }

    case ORG_STEPS.PROJECTS: {
      if (/^(없음|skip|스킵|완료|done)$/i.test(input)) {
        return _finishOrgOnboarding(state);
      }
      const parts = input.split(/[,，]/).map(s => s.trim());
      const project = {
        id: (parts[0] || 'project').toLowerCase().replace(/\s+/g, '-'),
        name: parts[0] || input, owner: parts[1] || '', deadline: parts[2] || '',
        description: parts.slice(3).join(', ') || '', status: 'in_progress',
      };
      state.data.projects.push(project);
      entity.upsert('project', project.id, project.name, { owner: project.owner, deadline: project.deadline, description: project.description });
      return `✅ 프로젝트 **${project.name}** 등록.\n다음 프로젝트를 입력하거나, "완료"를 입력하세요.`;
    }

    default: return null;
  }
}

function _askProjects() {
  return [
    '진행 중인 프로젝트가 있나요?',
    '형식: **프로젝트명, 담당자, 마감일, 설명**',
    '예: "V2 Launch, Drake, 2026-06-30, 새 결제 시스템"',
    '_(없으면 "없음")_',
  ].join('\n');
}

function _finishOrgOnboarding(state) {
  state.step = ORG_STEPS.DONE;
  _orgOnboardingDone = true;  // ISSUE-1: 메모리 플래그 설정
  _tryUpdateConfig(state.data);

  const lines = [
    `🎉 **${state.data.name}** 조직 설정 완료!`,
    '',
  ];
  if (state.data.departments.length) lines.push(`부서: ${state.data.departments.map(d => d.name).join(', ')}`);
  if (state.data.projects.length) lines.push(`프로젝트: ${state.data.projects.map(p => p.name).join(', ')}`);
  lines.push('', '이제 팀원들이 Effy에게 말을 걸면 각자 자기소개를 입력하게 됩니다.');

  log.info('Org onboarding completed', { company: state.data.name, depts: state.data.departments.length });
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════
// 개인 온보딩 핸들러
// ═══════════════════════════════════════════════════════

function _processPersonalInput(state, input, userId) {
  switch (state.step) {
    case PERSONAL_STEPS.NAME_ROLE: {
      // 일상 대화/질문이면 온보딩 답변으로 처리하지 않음
      const casualPattern = /^(안녕|하이|hi|hello|뭐해|뭐야|뭘해|뭐하고|누구|어떻게|왜|테스트|ㅋ|ㅎ|ㅇㅇ|나\s*뭐)/i;
      if (casualPattern.test(input) || input.length > 30) {
        return [
          `아직 직무를 못 들었어요 😅`,
          '',
          '**직무**만 짧게 알려주세요!',
          '예: 프론트엔드 개발 / PM / 디자이너',
        ].join('\n');
      }

      // 이름이 이미 있으면 (Teams에서 전달) 입력을 역할로 처리
      if (state.data.name) {
        state.data.role = input;
      } else {
        const parts = input.split(/[,，]/).map(s => s.trim());
        state.data.name = parts[0] || input;
        state.data.role = parts[1] || '';
      }

      if (!state.data.role) {
        return '**직무**만 짧게 알려주세요!\n예: 프론트엔드 개발 / PM / 디자이너';
      }

      // 바로 전문분야로 (부서는 Teams 프로필에서 가져올 수 있으므로 스킵)
      state.step = PERSONAL_STEPS.EXPERTISE;
      return [
        `${state.data.name}님, **${state.data.role}** 등록했습니다!`,
        '',
        '전문 기술이 있으면 알려주세요. 없으면 "스킵"',
        '예: React, TypeScript, Python',
      ].join('\n');
    }

    case PERSONAL_STEPS.DEPARTMENT: {
      if (!/^(없음|skip|스킵)$/i.test(input)) {
        state.data.department = input.toLowerCase().replace(/\s+/g, '-');
      }

      state.step = PERSONAL_STEPS.EXPERTISE;
      return [
        '전문분야를 알려주세요.',
        '예: "React, TypeScript, CSS" 또는 "데이터 분석, SQL, Python"',
        '_(건너뛰려면 "스킵")_',
      ].join('\n');
    }

    case PERSONAL_STEPS.EXPERTISE: {
      if (!/^(스킵|skip)$/i.test(input)) {
        state.data.expertise = input.split(/[,，/]/).map(s => s.trim()).filter(s => s);
      }

      return _finishPersonalOnboarding(state, userId);
    }

    default: return null;
  }
}

function _finishPersonalOnboarding(state, userId) {
  state.step = PERSONAL_STEPS.DONE;
  _onboardedUsers.add(userId);  // R5-BUG-2: 캐시 등록

  // Entity Memory에 저장
  entity.upsert('user', userId, state.data.name, {
    role: state.data.role,
    department: state.data.department,
    expertise: state.data.expertise,
  });

  log.info('Personal onboarding completed', { userId, name: state.data.name, role: state.data.role });

  // R17-BUG-1: 이전 코드는 entity.upsert로 properties를 덮어써서 프로필이 날아감.
  // Smart Onboarding 브리핑은 Gateway에서 직접 트리거 (slackClient 접근 가능한 곳에서).

  const lines = [
    `✅ 프로필 등록 완료!`,
    '',
    `**${state.data.name}** — ${state.data.role}`,
  ];
  if (state.data.department) lines.push(`부서: ${state.data.department}`);
  if (state.data.expertise.length) lines.push(`전문분야: ${state.data.expertise.join(', ')}`);
  lines.push('');
  lines.push('Effy가 할 수 있는 것들을 보려면 **"help"** 라고 입력해보세요!');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════
// Config 파일 업데이트 (조직 온보딩 완료 시)
// ═══════════════════════════════════════════════════════

function _tryUpdateConfig(data) {
  try {
    const configPath = path.resolve(process.cwd(), 'effy.config.yaml');
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, 'utf8');
    const doc = yaml.parseDocument(raw);
    doc.set('organization', {
      name: data.name,
      description: data.description,
      departments: data.departments.map(d => ({ id: d.id, name: d.name, lead: d.lead, channels: d.channels, description: d.description })),
      members: [],
      projects: data.projects.map(p => ({ id: p.id, name: p.name, owner: p.owner, status: p.status, deadline: p.deadline, description: p.description })),
    });
    fs.writeFileSync(configPath, doc.toString(), 'utf8');
    log.info('Config updated with organization data');
  } catch (err) {
    log.warn('Config update failed (non-critical)', { error: err.message });
  }
}

module.exports = {
  needsOrgOnboarding,
  needsPersonalOnboarding,
  startOrgOnboarding,
  startPersonalOnboarding,
  isOnboarding,
  processInput,
  // 하위 호환
  needsOnboarding: needsOrgOnboarding,
  startOnboarding: startOrgOnboarding,
};
