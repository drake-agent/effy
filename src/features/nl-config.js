/**
 * nl-config.js — Natural Language Config.
 *
 * 자연어 명령으로 effy.config.yaml 변경.
 * YAML 편집 없이 Slack에서 직접 설정 가능.
 *
 * 지원 명령:
 * - 바인딩: "@effy #engineering에 code 에이전트 배정해"
 * - 프로필: "@effy 내 전문분야 React 추가해줘"
 * - Observer: "@effy #random 채널 관찰 제외해"
 * - 브리핑: "@effy 아침 브리핑 켜줘"
 *
 * Admin 전용 (isAdmin 체크). HIGH 이상 변경은 Change Control 경유.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { config } = require('../config');
const { entity } = require('../memory/manager');
const { isAdmin } = require('../shared/auth');
const { requestChange, getSeverity, isApproved } = require('../observer/change-control');
const { createLogger } = require('../shared/logger');

const log = createLogger('features:nl-config');

// ─── 명령 패턴 ──────────────────────────────────────

const PATTERNS = [
  // 바인딩: "#채널에 에이전트 배정"
  {
    regex: /[#<]([a-zA-Z0-9_-]+)>?\s*(에|에서|채널에)\s*([\w-]+)\s*(에이전트|agent)\s*(배정|설정|연결)/i,
    handler: 'bindAgent',
    severity: 'channel_observe_add',  // HIGH
  },
  // 프로필 전문분야 추가: "내 전문분야 X 추가"
  {
    regex: /내\s*전문\s*분야\s*(에\s*)?([\w\s,/]+)\s*(추가|등록)/i,
    handler: 'addExpertise',
    severity: 'feedback_weight_adjust',  // MEDIUM (자동승인)
  },
  // 프로필 역할 변경: "내 역할 X로 변경"
  {
    regex: /내\s*역할\s*(을\s*)?([\w\s]+)\s*(으?로\s*)(변경|수정|업데이트)/i,
    handler: 'changeRole',
    severity: 'feedback_weight_adjust',  // MEDIUM
  },
  // Observer 제외: "#채널 관찰 제외"
  {
    regex: /[#<]([a-zA-Z0-9_-]+)>?\s*(채널\s*)?(관찰|observe)\s*(제외|끄기|off|비활성)/i,
    handler: 'excludeChannel',
    severity: 'channel_observe_remove',  // HIGH
  },
  // 브리핑 토글: "아침 브리핑 켜/꺼"
  {
    regex: /아침\s*브리핑\s*(켜|켜줘|활성|on|끄|꺼줘|비활성|off)/i,
    handler: 'toggleBriefing',
    severity: 'observer_toggle',  // CRITICAL
  },
  // 에이전트 이름으로 바인딩 (영어): "assign code agent to #engineering"
  {
    regex: /assign\s+([\w-]+)\s+agent\s+to\s+[#<]?([a-zA-Z0-9_-]+)/i,
    handler: 'bindAgentEn',
    severity: 'channel_observe_add',
  },
];

/**
 * 자연어 config 명령인지 감지.
 *
 * @param {string} text
 * @returns {{ matched: boolean, handler?: string, params?: object, severity?: string }}
 */
function detectConfigCommand(text) {
  if (!text || text.length < 5) return { matched: false };
  // SEC-NL fix: 입력 길이 상한 — ReDoS 방어 + 불필요한 장문 처리 방지
  if (text.length > 500) return { matched: false };

  for (const p of PATTERNS) {
    const m = text.match(p.regex);
    if (m) {
      return { matched: true, handler: p.handler, match: m, severity: p.severity };
    }
  }
  return { matched: false };
}

/**
 * Config 명령 실행.
 *
 * @param {string} handler
 * @param {RegExpMatchArray} match
 * @param {string} userId
 * @param {string} severity
 * @returns {string} 결과 메시지
 */
async function executeConfigCommand(handler, match, userId, severity) {
  // Admin 체크
  if (!isAdmin(userId)) {
    return '⛔ Config 변경은 Admin만 가능합니다.';
  }

  switch (handler) {
    case 'bindAgent':
    case 'bindAgentEn': {
      const channelId = handler === 'bindAgentEn' ? match[2] : match[1];
      const agentId = handler === 'bindAgentEn' ? match[1] : match[3];

      // 에이전트 존재 확인
      const agents = (config.agents?.list || []).map(a => a.id);
      if (!agents.includes(agentId)) {
        return `❌ 에이전트 '${agentId}'를 찾을 수 없습니다.\n사용 가능: ${agents.join(', ')}`;
      }

      // Change Control
      const change = requestChange(
        getSeverity(severity), 'channel_observe_add',
        `#${channelId}에 ${agentId} 에이전트 배정`,
        { channelId, agentId }, userId,
      );

      if (isApproved(change)) {
        _updateConfigFile(cfg => {
          if (!cfg.bindings) cfg.bindings = [];
          // 기존 바인딩 제거 후 추가
          cfg.bindings = cfg.bindings.filter(b => b.match?.channelId !== channelId);
          cfg.bindings.push({ agentId, match: { channel: 'slack', channelId } });
        });
        return `✅ #${channelId}에 **${agentId}** 에이전트 배정 완료.\n_pm2 restart 후 적용됩니다._`;
      }
      return `⏳ 변경 승인 대기: \`${change.id}\`\n\`/effy approve ${change.id}\`로 승인`;
    }

    case 'addExpertise': {
      const skills = match[2].split(/[,/]/).map(s => s.trim()).filter(s => s);
      const profile = await entity.get('user', userId);
      if (!profile) return '프로필이 없습니다. 먼저 "@effy 안녕"으로 자기소개를 해주세요.';
      const existing = profile.properties?.expertise || [];
      const merged = [...new Set([...existing, ...skills])];

      await entity.upsert('user', userId, profile.name || '', {
        ...profile.properties,
        expertise: merged,
      });

      return `✅ 전문분야 추가: ${skills.join(', ')}\n현재: ${merged.join(', ')}`;
    }

    case 'changeRole': {
      const newRole = match[2].trim();
      const profile = await entity.get('user', userId);
      if (!profile) return '프로필이 없습니다. 먼저 "@effy 안녕"으로 자기소개를 해주세요.';

      await entity.upsert('user', userId, profile.name || '', {
        ...profile.properties,
        role: newRole,
      });

      return `✅ 역할 변경: **${newRole}**`;
    }

    case 'excludeChannel': {
      const channelId = match[1];
      const change = requestChange(
        getSeverity(severity), 'channel_observe_remove',
        `#${channelId} 관찰 제외`,
        { channelId }, userId,
      );

      if (isApproved(change)) {
        _updateConfigFile(cfg => {
          if (!cfg.observer) cfg.observer = {};
          if (!cfg.observer.excludeChannels) cfg.observer.excludeChannels = [];
          if (!cfg.observer.excludeChannels.includes(channelId)) {
            cfg.observer.excludeChannels.push(channelId);
          }
        });
        return `✅ #${channelId} 관찰 제외 완료.`;
      }
      return `⏳ 변경 승인 대기: \`${change.id}\``;
    }

    case 'toggleBriefing': {
      const on = /켜|켜줘|활성|on/i.test(match[1]);
      const change = requestChange(
        getSeverity(severity), 'observer_toggle',
        `아침 브리핑 ${on ? '활성화' : '비활성화'}`,
        { enabled: on }, userId,
      );

      if (isApproved(change)) {
        _updateConfigFile(cfg => {
          if (!cfg.features) cfg.features = {};
          if (!cfg.features.briefing) cfg.features.briefing = {};
          cfg.features.briefing.enabled = on;
        });
        return `✅ 아침 브리핑 ${on ? '활성화' : '비활성화'} 완료.\n_pm2 restart 후 적용됩니다._`;
      }
      return `⏳ 변경 승인 대기: \`${change.id}\` (CRITICAL 변경)`;
    }

    default:
      return '❌ 알 수 없는 명령입니다.';
  }
}

/**
 * Config YAML 파일 업데이트 (best-effort).
 */
function _updateConfigFile(mutator) {
  try {
    const configPath = path.resolve(process.cwd(), 'effy.config.yaml');
    if (!fs.existsSync(configPath)) return;
    const raw = fs.readFileSync(configPath, 'utf8');
    // R21-BUG-3: parseDocument + toString으로 주석 보존 (parse + stringify는 주석 삭제)
    const doc = yaml.parseDocument(raw);
    const obj = doc.toJSON();
    mutator(obj);
    // mutate된 객체를 다시 doc에 반영
    for (const [key, val] of Object.entries(obj)) {
      doc.set(key, val);
    }
    fs.writeFileSync(configPath, doc.toString(), 'utf8');
    log.info('Config file updated via NL command');
  } catch (err) {
    log.warn('Config file update failed', { error: err.message });
  }
}

const HELP_ENTRY = {
  icon: '⚙️',
  title: '자연어 설정',
  lines: [
    '"브리핑 시간 8시로 바꿔줘" — 자연어로 Effy 설정을 변경할 수 있습니다.',
  ],
  order: 70,
};

module.exports = { detectConfigCommand, executeConfigCommand, HELP_ENTRY };
