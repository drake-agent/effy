/**
 * tier1-skills.test.js — Skill System 단위 테스트.
 *
 * 대상:
 * - loader.js (parseSkillMd, formatSkillPrompt)
 * - catalog.js (searchCatalog, getCatalogEntry, getFullCatalog)
 * - registry.js (SkillRegistry — install, activate, getSkillPrompts, listInstalled)
 * - tool-registry.js (skill 도구 정의 검증)
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// ─── Loader 테스트 ───────────────────────────────────────

describe('Skill Loader', () => {
  let parseSkillMd, formatSkillPrompt;

  before(() => {
    ({ parseSkillMd, formatSkillPrompt } = require('../src/skills/loader'));
  });

  it('should parse SKILL.md with YAML frontmatter + body', () => {
    const raw = `---
name: Test Skill
description: A test skill for unit tests
---
# Instructions
Do something useful.`;
    const result = parseSkillMd(raw);
    assert.equal(result.meta.name, 'Test Skill');
    assert.equal(result.meta.description, 'A test skill for unit tests');
    assert.ok(result.body.includes('# Instructions'));
    assert.ok(result.body.includes('Do something useful.'));
  });

  it('should handle missing frontmatter (body only)', () => {
    const raw = '# Just Markdown\nNo frontmatter here.';
    const result = parseSkillMd(raw);
    assert.deepEqual(result.meta, {});
    assert.ok(result.body.includes('# Just Markdown'));
  });

  it('should handle empty input', () => {
    const result = parseSkillMd('');
    assert.deepEqual(result.meta, {});
    assert.equal(result.body, '');
  });

  it('should handle frontmatter with array values', () => {
    const raw = `---
name: Multi Tags
tags: [tag1, tag2, tag3]
---
Body content.`;
    const result = parseSkillMd(raw);
    assert.equal(result.meta.name, 'Multi Tags');
    assert.deepEqual(result.meta.tags, ['tag1', 'tag2', 'tag3']);
  });

  it('formatSkillPrompt should wrap in <skill> XML', () => {
    const prompt = formatSkillPrompt('test-skill', {
      meta: { name: 'Test Skill', description: 'Desc' },
      body: 'Do things.',
    });
    assert.ok(prompt.includes('<skill id="Test Skill"'));
    assert.ok(prompt.includes('description="Desc"'));
    assert.ok(prompt.includes('Do things.'));
    assert.ok(prompt.includes('</skill>'));
  });

  it('formatSkillPrompt should use skillId when name is missing', () => {
    const prompt = formatSkillPrompt('fallback-id', {
      meta: {},
      body: 'Body only.',
    });
    assert.ok(prompt.includes('<skill id="fallback-id"'));
  });

  // BUG-4 regression: XML Attribute Injection 방어
  it('formatSkillPrompt should escape XML special chars in name/description', () => {
    const prompt = formatSkillPrompt('evil', {
      meta: { name: 'x" injected="y', description: '<script>alert("xss")</script>' },
      body: 'Safe body.',
    });
    // 이중 따옴표가 이스케이핑되어야 함
    assert.ok(!prompt.includes('injected="y"'), 'Should not contain unescaped injection');
    assert.ok(prompt.includes('&quot;'), 'Should contain escaped quotes');
    assert.ok(prompt.includes('&lt;script&gt;'), 'Should contain escaped angle brackets');
  });
});

// ─── Catalog 테스트 ──────────────────────────────────────

describe('Skill Catalog', () => {
  let searchCatalog, getCatalogEntry, getFullCatalog;

  before(() => {
    ({ searchCatalog, getCatalogEntry, getFullCatalog } = require('../src/skills/catalog'));
  });

  it('should return full catalog', () => {
    const catalog = getFullCatalog();
    assert.ok(Array.isArray(catalog));
    assert.ok(catalog.length >= 20, `Expected 20+ entries, got ${catalog.length}`);
  });

  it('should search by keyword', () => {
    const results = searchCatalog('document');
    assert.ok(results.length > 0, 'document search should find results');
    // docx should be in results
    const ids = results.map(r => r.id);
    assert.ok(ids.includes('docx'), `Expected docx in results, got: ${ids.join(', ')}`);
  });

  it('should search by category', () => {
    const results = searchCatalog('', { category: 'security' });
    assert.ok(results.length > 0, 'security category should exist');
    assert.ok(results.every(r => r.category === 'security'));
  });

  it('should respect limit option', () => {
    const results = searchCatalog('', { limit: 3 });
    assert.ok(results.length <= 3);
  });

  it('should get catalog entry by ID', () => {
    const entry = getCatalogEntry('docx');
    assert.ok(entry, 'docx should exist in catalog');
    assert.equal(entry.id, 'docx');
    assert.ok(entry.repo, 'entry should have repo');
    assert.ok(entry.path, 'entry should have path');
  });

  it('should return null for unknown skill ID', () => {
    const entry = getCatalogEntry('nonexistent-skill-xyz');
    assert.ok(!entry, 'nonexistent skill should return falsy');
  });

  it('should filter by source', () => {
    const results = searchCatalog('', { source: 'official' });
    assert.ok(results.length > 0);
    assert.ok(results.every(r => r.source === 'official'));
  });
});

// ─── Resolver 보안 테스트 ─────────────────────────────────

describe('Skill Resolver Security', () => {
  let SkillResolver;

  before(() => {
    ({ SkillResolver } = require('../src/skills/resolver'));
  });

  // BUG-1 regression: Path Traversal 방어
  it('_safeFileName should reject path traversal attempts', () => {
    const resolver = new SkillResolver({ cacheDir: '/tmp/test-skills-cache' });
    assert.throws(() => resolver._safeFileName('../../../etc/passwd'), /Invalid skillId/);
    assert.throws(() => resolver._safeFileName('..'), /Invalid skillId/);
    assert.throws(() => resolver._safeFileName('.'), /Invalid skillId/);
    assert.throws(() => resolver._safeFileName('skill/evil'), /Invalid skillId/);
    assert.throws(() => resolver._safeFileName('skill\\evil'), /Invalid skillId/);
    assert.throws(() => resolver._safeFileName('a..b'), /Invalid skillId/);
  });

  it('_safeFileName should sanitize special characters but allow valid IDs', () => {
    const resolver = new SkillResolver({ cacheDir: '/tmp/test-skills-cache' });
    assert.equal(resolver._safeFileName('valid-skill_1'), 'valid-skill_1');
    assert.equal(resolver._safeFileName('docx'), 'docx');
    assert.equal(resolver._safeFileName('security-analysis'), 'security-analysis');
    // 특수문자는 _ 로 치환
    assert.equal(resolver._safeFileName('skill@v2'), 'skill_v2');
  });
});

// ─── Registry 테스트 (모킹) ─────────────────────────────

describe('Skill Registry', () => {
  let SkillRegistry;

  before(() => {
    ({ SkillRegistry } = require('../src/skills/registry'));
  });

  it('should instantiate with empty state', () => {
    const reg = new SkillRegistry();
    assert.equal(reg.installed.size, 0);
    assert.equal(reg.activeSkills.size, 0);
    assert.equal(reg.initialized, false);
  });

  it('search() should return catalog results with installed status', () => {
    const reg = new SkillRegistry();
    const results = reg.search('document');
    assert.ok(results.length > 0);
    // 설치되지 않은 상태이므로 모두 installed: false
    assert.ok(results.every(r => r.installed === false));
  });

  it('activateFor() should track per-agent skill activation', () => {
    const reg = new SkillRegistry();
    reg.activateFor('knowledge', 'docx');
    reg.activateFor('knowledge', 'pdf');
    reg.activateFor('code', 'security-analysis');

    const knowledgeSkills = reg.activeSkills.get('knowledge');
    assert.ok(knowledgeSkills.has('docx'));
    assert.ok(knowledgeSkills.has('pdf'));
    assert.equal(knowledgeSkills.size, 2);

    const codeSkills = reg.activeSkills.get('code');
    assert.ok(codeSkills.has('security-analysis'));
    assert.equal(codeSkills.size, 1);
  });

  it('deactivateFor() should remove skill from agent', () => {
    const reg = new SkillRegistry();
    reg.activateFor('ops', 'xlsx');
    reg.deactivateFor('ops', 'xlsx');
    const opsSkills = reg.activeSkills.get('ops');
    assert.ok(!opsSkills.has('xlsx'));
  });

  it('getSkillPrompts() should return empty string when no skills active', () => {
    const reg = new SkillRegistry();
    const prompts = reg.getSkillPrompts('nonexistent-agent');
    assert.equal(prompts, '');
  });

  it('getSkillPrompts() should return XML for installed + active skills', () => {
    const reg = new SkillRegistry();
    // 수동으로 installed에 스킬 추가 (resolver 없이 테스트)
    reg.installed.set('test-skill', {
      meta: { id: 'test-skill', name: 'Test Skill', description: 'Test desc' },
      body: '# Instructions\nDo test stuff.',
      installedAt: Date.now(),
    });
    reg.activateFor('general', 'test-skill');

    const prompts = reg.getSkillPrompts('general');
    assert.ok(prompts.includes('<active_skills>'));
    assert.ok(prompts.includes('</active_skills>'));
    assert.ok(prompts.includes('<skill id="Test Skill"'));
    assert.ok(prompts.includes('Do test stuff.'));
  });

  it('listInstalled() should include active status for agent', () => {
    const reg = new SkillRegistry();
    reg.installed.set('skill-a', {
      meta: { id: 'skill-a', name: 'Skill A', description: 'A', category: 'util', source: 'test' },
      body: 'body-a',
      installedAt: Date.now(),
    });
    reg.installed.set('skill-b', {
      meta: { id: 'skill-b', name: 'Skill B', description: 'B', category: 'util', source: 'test' },
      body: 'body-b',
      installedAt: Date.now(),
    });
    reg.activateFor('ops', 'skill-a');

    const list = reg.listInstalled('ops');
    assert.equal(list.length, 2);
    const a = list.find(s => s.id === 'skill-a');
    const b = list.find(s => s.id === 'skill-b');
    assert.equal(a.active, true);
    assert.equal(b.active, false);
  });

  it('uninstall() should remove from installed and all active sets', () => {
    const reg = new SkillRegistry();
    reg.installed.set('to-remove', {
      meta: { id: 'to-remove', name: 'Remove Me' },
      body: 'bye',
      installedAt: Date.now(),
    });
    reg.activateFor('general', 'to-remove');
    reg.activateFor('code', 'to-remove');

    reg.uninstall('to-remove');

    assert.ok(!reg.installed.has('to-remove'));
    assert.ok(!reg.activeSkills.get('general')?.has('to-remove'));
    assert.ok(!reg.activeSkills.get('code')?.has('to-remove'));
  });

  it('getCategories() should return sorted category list', () => {
    const reg = new SkillRegistry();
    const cats = reg.getCategories();
    assert.ok(Array.isArray(cats));
    assert.ok(cats.length > 0);
    // 정렬 검증
    const sorted = [...cats].sort();
    assert.deepEqual(cats, sorted);
  });

  it('destroy() should clear all state', async () => {
    const reg = new SkillRegistry();
    reg.installed.set('x', { meta: {}, body: '', installedAt: 0 });
    reg.activateFor('a', 'x');
    reg.initialized = true;

    await reg.destroy();

    assert.equal(reg.installed.size, 0);
    assert.equal(reg.activeSkills.size, 0);
    assert.equal(reg.initialized, false);
  });
});

// ─── 대화형 스킬 빌더 (registerLocal) 테스트 ────────────

describe('Skill Registry — registerLocal (Conversational Builder)', () => {
  let SkillRegistry;

  before(() => {
    ({ SkillRegistry } = require('../src/skills/registry'));
  });

  it('should register a local skill from raw SKILL.md', () => {
    const reg = new SkillRegistry();
    const rawMd = `---
name: Dashboard Summary
description: 팀 대시보드 데이터를 요약하는 스킬
category: analysis
---
## 역할
당신은 대시보드 데이터 분석가입니다.

## 규칙
- 핵심 지표만 3줄로 요약
- 전일 대비 변동률 포함`;

    const result = reg.registerLocal('dashboard-summary', rawMd, {
      category: 'analysis',
      tags: ['dashboard', 'summary'],
      createdBy: 'general',
    });

    assert.ok(result.success);
    assert.equal(result.meta.id, 'dashboard-summary');
    assert.equal(result.meta.name, 'Dashboard Summary');
    assert.equal(result.meta.source, 'local');
    assert.equal(result.meta.category, 'analysis');
    assert.ok(reg.installed.has('dashboard-summary'));
    assert.ok(reg.installed.get('dashboard-summary').body.includes('대시보드 데이터 분석가'));
  });

  it('should overwrite existing local skill with same ID', () => {
    const reg = new SkillRegistry();
    const v1 = `---\nname: MySkill\n---\nVersion 1 instructions.`;
    const v2 = `---\nname: MySkill v2\n---\nVersion 2 updated instructions.`;

    reg.registerLocal('my-skill', v1);
    const result = reg.registerLocal('my-skill', v2);

    assert.ok(result.success);
    assert.ok(result.overwrite);
    assert.equal(result.meta.name, 'MySkill v2');
    assert.ok(reg.installed.get('my-skill').body.includes('Version 2'));
  });

  it('should normalize skillId to safe kebab-case', () => {
    const reg = new SkillRegistry();
    const raw = `---\nname: Test\n---\nBody content here for testing.`;
    const result = reg.registerLocal('My Cool Skill!!', raw);
    assert.ok(result.success);
    assert.equal(result.meta.id, 'my-cool-skill');
  });

  it('should reject empty or too-short instructions', () => {
    const reg = new SkillRegistry();
    const r1 = reg.registerLocal('test', '');
    assert.ok(!r1.success);
    assert.ok(r1.error.includes('짧습니다'));

    const r2 = reg.registerLocal('test', 'short');
    assert.ok(!r2.success);
  });

  it('should reject empty skillId', () => {
    const reg = new SkillRegistry();
    const r = reg.registerLocal('', `---\nname: X\n---\nBody that is long enough to pass.`);
    assert.ok(!r.success);
  });

  it('should reject SKILL.md with no body (frontmatter only)', () => {
    const reg = new SkillRegistry();
    const raw = `---\nname: Empty Body\ndescription: No instructions\n---\n`;
    const result = reg.registerLocal('empty-body', raw);
    assert.ok(!result.success);
    assert.ok(result.error.includes('body'));
  });

  it('should make registered skill available in getSkillPrompts', () => {
    const reg = new SkillRegistry();
    const raw = `---\nname: Prompt Test\n---\n## Role\nYou are a test skill agent.`;
    reg.registerLocal('prompt-test', raw);
    reg.activateFor('general', 'prompt-test');

    const prompts = reg.getSkillPrompts('general');
    assert.ok(prompts.includes('<active_skills>'));
    assert.ok(prompts.includes('Prompt Test'));
    assert.ok(prompts.includes('test skill agent'));
  });

  it('should list local skill with source=local', () => {
    const reg = new SkillRegistry();
    const raw = `---\nname: List Test\n---\nBody content for list test skill.`;
    reg.registerLocal('list-test', raw, { category: 'custom' });

    const list = reg.listInstalled();
    const found = list.find(s => s.id === 'list-test');
    assert.ok(found);
    assert.equal(found.source, 'local');
    assert.equal(found.category, 'custom');
  });

  it('uninstall should remove local skill', () => {
    const reg = new SkillRegistry();
    const raw = `---\nname: ToDelete\n---\nBody content to be deleted later.`;
    reg.registerLocal('to-delete', raw);
    reg.activateFor('general', 'to-delete');

    reg.uninstall('to-delete');
    assert.ok(!reg.installed.has('to-delete'));
    assert.ok(!reg.activeSkills.get('general')?.has('to-delete'));
  });
});

// ─── Tool Registry 스킬 도구 정의 검증 ──────────────────

describe('Skill Tool Definitions', () => {
  let TOOL_DEFINITIONS, getToolsForFunction, validateToolInput;

  before(() => {
    ({ TOOL_DEFINITIONS, getToolsForFunction, validateToolInput } = require('../src/agents/tool-registry'));
  });

  it('should include all 6 skill tools', () => {
    const skillTools = ['search_skills', 'install_skill', 'list_skills', 'activate_skill', 'create_skill', 'delete_skill'];
    for (const name of skillTools) {
      assert.ok(TOOL_DEFINITIONS[name], `Missing tool definition: ${name}`);
      assert.equal(TOOL_DEFINITIONS[name].category, 'skills');
    }
  });

  it('skill tools should be accessible to all agents (*)', () => {
    const skillTools = ['search_skills', 'install_skill', 'list_skills', 'activate_skill', 'create_skill', 'delete_skill'];
    for (const name of skillTools) {
      assert.ok(TOOL_DEFINITIONS[name].agents.includes('*'));
    }
  });

  it('getToolsForFunction should include skill tools for any function type', () => {
    const tools = getToolsForFunction('general');
    assert.ok(tools.includes('search_skills'));
    assert.ok(tools.includes('install_skill'));
    assert.ok(tools.includes('list_skills'));
    assert.ok(tools.includes('activate_skill'));
    assert.ok(tools.includes('create_skill'));
  });

  it('create_skill should require skill_id, name, description, instructions', () => {
    const r1 = validateToolInput('create_skill', {});
    assert.equal(r1.valid, false);

    const r2 = validateToolInput('create_skill', {
      skill_id: 'test',
      name: 'Test',
      description: 'A test skill',
      instructions: 'Do something useful for testing.',
    });
    assert.equal(r2.valid, true);
  });

  it('validateToolInput should enforce required fields', () => {
    const r1 = validateToolInput('search_skills', {});
    assert.equal(r1.valid, false);
    assert.ok(r1.error.includes('query'));

    const r2 = validateToolInput('search_skills', { query: 'test' });
    assert.equal(r2.valid, true);

    const r3 = validateToolInput('install_skill', {});
    assert.equal(r3.valid, false);

    const r4 = validateToolInput('activate_skill', { skill_id: 'docx' });
    assert.equal(r4.valid, true);
  });
});
