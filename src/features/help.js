/**
 * help.js — Effy 기능 소개 메시지.
 *
 * 첫 대화 또는 "help" 입력 시 표시.
 *
 * 각 기능 모듈이 HELP_ENTRY를 export하면 자동으로 수집됩니다.
 * HELP_ENTRY 형식:
 *   { icon: '🌅', title: '아침 브리핑', lines: ['설명1', '설명2'], order: 10 }
 */
const fs = require('fs');
const path = require('path');

/** features/ 디렉토리에서 HELP_ENTRY를 가진 모듈을 자동 수집. */
function collectHelpEntries() {
  const entries = [];
  const dir = __dirname; // src/features/
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'help.js');

  for (const file of files) {
    try {
      const mod = require(path.join(dir, file));
      if (mod.HELP_ENTRY) entries.push(mod.HELP_ENTRY);
    } catch { /* 로드 실패 무시 */ }
  }

  return entries.sort((a, b) => (a.order || 999) - (b.order || 999));
}

let _cachedMessage = null;

function getHelpMessage() {
  if (_cachedMessage) return _cachedMessage;

  const entries = collectHelpEntries();
  const parts = [
    '🧠 **Effy — 팀의 두뇌, AI가 구동합니다**',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ];

  for (const entry of entries) {
    parts.push('', `${entry.icon} **${entry.title}**`);
    parts.push(...entry.lines);
  }

  parts.push(
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '💡 **사용법**',
    '• 아무 질문이나 편하게 말을 걸어보세요',
    '• 채널에서는 @Effy로 멘션',
    '• "내 프로필 수정" — 프로필 재설정',
    '• "help" — 이 안내 다시 보기',
    '',
    '자세한 내용: https://www.effy.one',
  );

  _cachedMessage = parts.join('\n');
  return _cachedMessage;
}

function isHelpCommand(text) {
  if (!text) return false;
  return /^(help|도움말|사용법|뭐\s*할\s*수\s*있|뭘\s*할\s*수|기능|소개)\s*[?？]?\s*$/i.test(text.trim());
}

module.exports = { getHelpMessage, isHelpCommand };
