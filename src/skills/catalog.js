/**
 * catalog.js — Skill 카탈로그.
 *
 * awesome-claude-skills 기반 빌트인 카탈로그 + GitHub API 원격 갱신 지원.
 * 에이전트가 search_skills로 검색할 때 이 카탈로그에서 매칭.
 *
 * 카탈로그 엔트리 구조:
 *   { id, name, description, repo, category, tags, source }
 *
 * repo 형식: "owner/repo" (GitHub) — SKILL.md는 skills/{id}/SKILL.md 또는 루트 SKILL.md
 */

// ─── 빌트인 카탈로그 (awesome-claude-skills 2026-03 기준) ───
const BUILTIN_CATALOG = [
  // Official — Anthropic
  { id: 'docx', name: 'docx', description: 'Create, edit, and analyze Word documents with tracked changes support', repo: 'anthropics/skills', path: 'skills/docx', category: 'document', tags: ['word', 'document', 'office', 'docx'], source: 'official' },
  { id: 'pdf', name: 'pdf', description: 'Comprehensive PDF manipulation: extract text/tables, merge, split, create', repo: 'anthropics/skills', path: 'skills/pdf', category: 'document', tags: ['pdf', 'document', 'extract', 'merge'], source: 'official' },
  { id: 'pptx', name: 'pptx', description: 'Create, edit, and analyze PowerPoint presentations', repo: 'anthropics/skills', path: 'skills/pptx', category: 'document', tags: ['powerpoint', 'presentation', 'slides', 'pptx'], source: 'official' },
  { id: 'xlsx', name: 'xlsx', description: 'Create, edit, and analyze Excel spreadsheets with formulas and charts', repo: 'anthropics/skills', path: 'skills/xlsx', category: 'document', tags: ['excel', 'spreadsheet', 'data', 'xlsx'], source: 'official' },
  { id: 'algorithmic-art', name: 'algorithmic-art', description: 'Create generative art using p5.js', repo: 'anthropics/skills', path: 'skills/algorithmic-art', category: 'creative', tags: ['art', 'generative', 'p5js', 'creative'], source: 'official' },
  { id: 'canvas-design', name: 'canvas-design', description: 'Design beautiful visual art in .png and .pdf formats using Canvas API', repo: 'anthropics/skills', path: 'skills/canvas-design', category: 'creative', tags: ['design', 'canvas', 'image', 'visual'], source: 'official' },
  { id: 'frontend-design', name: 'frontend-design', description: 'Make bold, opinionated frontend design decisions — avoid generic aesthetics', repo: 'anthropics/skills', path: 'skills/frontend-design', category: 'development', tags: ['frontend', 'design', 'ui', 'css'], source: 'official' },
  { id: 'web-artifacts-builder', name: 'web-artifacts-builder', description: 'Build complex HTML artifacts using React, Tailwind CSS for Claude.ai', repo: 'anthropics/skills', path: 'skills/web-artifacts-builder', category: 'development', tags: ['react', 'tailwind', 'artifacts', 'web'], source: 'official' },
  { id: 'mcp-builder', name: 'mcp-builder', description: 'Guide for creating high-quality MCP (Model Context Protocol) servers', repo: 'anthropics/skills', path: 'skills/mcp-builder', category: 'development', tags: ['mcp', 'server', 'protocol', 'api'], source: 'official' },
  { id: 'webapp-testing', name: 'webapp-testing', description: 'Test local web applications using Playwright browser automation', repo: 'anthropics/skills', path: 'skills/webapp-testing', category: 'development', tags: ['testing', 'playwright', 'browser', 'qa'], source: 'official' },
  { id: 'brand-guidelines', name: 'brand-guidelines', description: "Apply Anthropic's official brand colors and typography", repo: 'anthropics/skills', path: 'skills/brand-guidelines', category: 'communication', tags: ['brand', 'design', 'guidelines', 'typography'], source: 'official' },
  { id: 'internal-comms', name: 'internal-comms', description: 'Write internal communications: status reports, newsletters, memos', repo: 'anthropics/skills', path: 'skills/internal-comms', category: 'communication', tags: ['communication', 'writing', 'report', 'memo'], source: 'official' },
  { id: 'skill-creator', name: 'skill-creator', description: 'Interactive skill creation tool with Q&A guidance and best practices', repo: 'anthropics/skills', path: 'skills/skill-creator', category: 'meta', tags: ['skill', 'creator', 'template', 'meta'], source: 'official' },
  { id: 'slack-gif-creator', name: 'slack-gif-creator', description: 'Create animated GIFs optimized for Slack size constraints', repo: 'anthropics/skills', path: 'skills/slack-gif-creator', category: 'creative', tags: ['gif', 'slack', 'animation', 'image'], source: 'official' },

  // Community — obra/superpowers
  { id: 'superpowers', name: 'superpowers', description: 'Core skills library: 20+ battle-tested skills including /brainstorm, /write-plan, /execute-plan', repo: 'obra/superpowers-skills', path: 'skills', category: 'collection', tags: ['planning', 'brainstorm', 'execute', 'workflow'], source: 'community' },

  // Community — Individual
  { id: 'ios-simulator', name: 'ios-simulator-skill', description: 'iOS app building, testing, and simulator automation', repo: 'conorluddy/ios-simulator-skill', path: '.', category: 'development', tags: ['ios', 'simulator', 'mobile', 'swift'], source: 'community' },
  { id: 'ffuf-web-fuzzing', name: 'ffuf-web-fuzzing', description: 'Web fuzzing and penetration testing automation with ffuf', repo: 'jthack/ffuf_claude_skill', path: '.', category: 'security', tags: ['security', 'fuzzing', 'pentest', 'web'], source: 'community' },
  { id: 'playwright', name: 'playwright-skill', description: 'General-purpose browser automation with Playwright', repo: 'lackeyjb/playwright-skill', path: '.', category: 'development', tags: ['browser', 'automation', 'testing', 'playwright'], source: 'community' },
  { id: 'd3js-viz', name: 'claude-d3js-skill', description: 'Create D3.js data visualizations and interactive charts', repo: 'chrisvoncsefalvay/claude-d3js-skill', path: '.', category: 'creative', tags: ['d3', 'visualization', 'chart', 'data'], source: 'community' },
  { id: 'scientific', name: 'claude-scientific-skills', description: 'Scientific computing: simulation, analysis, visualization', repo: 'K-Dense-AI/claude-scientific-skills', path: '.', category: 'development', tags: ['science', 'computing', 'simulation', 'analysis'], source: 'community' },
  { id: 'web-asset-generator', name: 'web-asset-generator', description: 'Generate favicons, app icons, and social media images', repo: 'alonw0/web-asset-generator', path: '.', category: 'creative', tags: ['favicon', 'icon', 'image', 'web'], source: 'community' },
  { id: 'loki-mode', name: 'loki-mode', description: 'Multi-agent autonomous startup system for rapid prototyping', repo: 'asklokesh/claudeskill-loki-mode', path: '.', category: 'development', tags: ['agent', 'startup', 'automation', 'multi-agent'], source: 'community' },
  { id: 'security-analysis', name: 'trail-of-bits-security', description: 'Static analysis, CodeQL queries, and variant analysis for security', repo: 'trailofbits/skills', path: '.', category: 'security', tags: ['security', 'static-analysis', 'codeql', 'audit'], source: 'community' },
  { id: 'frontend-slides', name: 'frontend-slides', description: 'Animation-rich HTML presentations with smooth transitions', repo: 'zarazhangrui/frontend-slides', path: '.', category: 'creative', tags: ['slides', 'presentation', 'html', 'animation'], source: 'community' },
  { id: 'expo', name: 'expo-skills', description: 'Official Expo team skills for React Native app development', repo: 'expo/skills', path: '.', category: 'development', tags: ['expo', 'react-native', 'mobile', 'app'], source: 'community' },
];

/**
 * 카탈로그에서 키워드 검색.
 * 이름, 설명, 태그, 카테고리에서 매칭.
 * @param {string} query — 검색 키워드
 * @param {object} options — { category, source, limit }
 * @returns {Array}
 */
function searchCatalog(query, options = {}) {
  const { category, source, limit = 10 } = options;
  const q = (query || '').toLowerCase();

  let results = BUILTIN_CATALOG;

  if (category) {
    results = results.filter(s => s.category === category);
  }
  if (source) {
    results = results.filter(s => s.source === source);
  }

  if (!q) return results.slice(0, limit);

  // 점수 기반 매칭
  const scored = results.map(skill => {
    let score = 0;
    if (skill.id.includes(q)) score += 10;
    if (skill.name.toLowerCase().includes(q)) score += 8;
    if (skill.description.toLowerCase().includes(q)) score += 5;
    if (skill.category === q) score += 6;
    for (const tag of skill.tags || []) {
      if (tag.includes(q)) score += 3;
    }
    return { ...skill, _score: score };
  });

  return scored
    .filter(s => s._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit)
    .map(({ _score, ...rest }) => rest);
}

/**
 * 카탈로그에서 ID로 조회.
 * @param {string} skillId
 * @returns {object|null}
 */
function getCatalogEntry(skillId) {
  return BUILTIN_CATALOG.find(s => s.id === skillId) ?? null;
}

/**
 * 전체 카탈로그 반환.
 * @returns {Array}
 */
function getFullCatalog() {
  return [...BUILTIN_CATALOG];
}

module.exports = { BUILTIN_CATALOG, searchCatalog, getCatalogEntry, getFullCatalog };
