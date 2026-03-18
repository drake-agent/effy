/**
 * loader.js — SKILL.md 파서.
 *
 * YAML frontmatter + Markdown body를 파싱.
 * frontmatter: name, description, (optional) version, tags, author
 * body: 에이전트에게 주입될 실제 지시문
 */

/**
 * SKILL.md 텍스트를 파싱.
 * @param {string} raw — SKILL.md 원본 텍스트
 * @returns {{ meta: object, body: string }}
 */
function parseSkillMd(raw) {
  if (!raw || typeof raw !== 'string') {
    return { meta: {}, body: '' };
  }

  const trimmed = raw.trim();

  // YAML frontmatter 파싱: --- ... ---
  const fmMatch = trimmed.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!fmMatch) {
    // frontmatter 없으면 전체가 body
    return { meta: {}, body: trimmed };
  }

  const yamlBlock = fmMatch[1];
  const body = (fmMatch[2] || '').trim();

  // 간이 YAML 파서 (yaml 라이브러리 의존 회피 — 단순 key: value만)
  const meta = {};
  for (const line of yamlBlock.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (m) {
      const key = m[1].trim();
      let val = m[2].trim();
      // 따옴표 제거
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      // 배열 [a, b, c]
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      }
      meta[key] = val;
    }
  }

  return { meta, body };
}

/**
 * BUG-4 fix: XML 속성 값 이스케이핑.
 * @param {string} str
 * @returns {string}
 */
function escapeXmlAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 파싱된 스킬에서 에이전트 system prompt 주입용 텍스트 생성.
 * @param {string} skillId
 * @param {{ meta: object, body: string }} parsed
 * @returns {string}
 */
function formatSkillPrompt(skillId, parsed) {
  const { meta, body } = parsed;
  const name = escapeXmlAttr(meta.name || skillId);
  const desc = meta.description ? ` description="${escapeXmlAttr(meta.description)}"` : '';
  return `<skill id="${name}"${desc}>\n${body}\n</skill>`;
}

module.exports = { parseSkillMd, formatSkillPrompt };
