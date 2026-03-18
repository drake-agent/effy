/**
 * Tier 1 — Config & Agent Static Validation.
 *
 * YAML 스키마 검증, SOUL.md/AGENTS.md 파싱, Pool 접근 일관성.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const CONFIG_PATH = path.resolve(__dirname, '../effy.config.yaml');
const AGENTS_DIR = path.resolve(__dirname, '../agents');

describe('effy.config.yaml — Schema Validation', () => {
  let cfg;

  it('should parse without errors', () => {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    // Replace env vars with placeholders to avoid parse errors
    const resolved = raw.replace(/\$\{(\w+)\}/g, (_, name) => `PLACEHOLDER_${name}`);
    cfg = yaml.parse(resolved);
    assert.ok(cfg, 'parsed config must be truthy');
  });

  it('should have gateway section with required fields', () => {
    assert.ok(cfg.gateway, 'gateway section missing');
    assert.ok(typeof cfg.gateway.port === 'number', 'gateway.port must be number');
    assert.ok(cfg.gateway.maxConcurrency, 'maxConcurrency missing');
    assert.ok(typeof cfg.gateway.maxConcurrency.global === 'number');
    assert.ok(typeof cfg.gateway.maxConcurrency.perUser === 'number');
    assert.ok(typeof cfg.gateway.maxConcurrency.perChannel === 'number');
  });

  it('should have anthropic section with model config', () => {
    assert.ok(cfg.anthropic, 'anthropic section missing');
    assert.ok(typeof cfg.anthropic.defaultModel === 'string');
    assert.ok(typeof cfg.anthropic.advancedModel === 'string');
    assert.ok(typeof cfg.anthropic.maxTokens === 'number');
  });

  it('should have agents.list with at least one default agent', () => {
    assert.ok(Array.isArray(cfg.agents?.list), 'agents.list must be array');
    assert.ok(cfg.agents.list.length > 0, 'at least 1 agent required');
    const defaults = cfg.agents.list.filter(a => a.default);
    assert.equal(defaults.length, 1, 'exactly 1 default agent required');
  });

  it('should have valid agent memory config for each agent', () => {
    for (const agent of cfg.agents.list) {
      assert.ok(agent.id, 'agent must have id');
      assert.ok(agent.memory, `agent ${agent.id} must have memory config`);
      assert.ok(Array.isArray(agent.memory.shared_read), `${agent.id}: shared_read must be array`);
      assert.ok(Array.isArray(agent.memory.shared_write), `${agent.id}: shared_write must be array`);
    }
  });

  it('should have all agent memory pools defined in memory.pools', () => {
    const definedPools = Object.keys(cfg.memory?.pools || {});
    for (const agent of cfg.agents.list) {
      for (const pool of [...(agent.memory.shared_read || []), ...(agent.memory.shared_write || [])]) {
        assert.ok(definedPools.includes(pool), `Agent "${agent.id}" references pool "${pool}" not defined in memory.pools`);
      }
    }
  });

  it('should have valid bindings referencing existing agents', () => {
    const agentIds = new Set(cfg.agents.list.map(a => a.id));
    for (const binding of (cfg.bindings || [])) {
      assert.ok(agentIds.has(binding.agentId), `Binding references unknown agent: ${binding.agentId}`);
      assert.ok(binding.match, 'binding must have match clause');
    }
  });

  it('should have memory.budget profiles with all required slots', () => {
    const requiredSlots = ['total', 'system_prompt', 'entity_context', 'current_thread', 'buffer'];
    for (const [profileName, profile] of Object.entries(cfg.memory?.budget || {})) {
      for (const slot of requiredSlots) {
        assert.ok(typeof profile[slot] === 'number', `budget.${profileName}.${slot} must be number`);
      }
      // total should be >= sum of individual slots (sanity check)
      const slotSum = Object.entries(profile).filter(([k]) => k !== 'total').reduce((s, [, v]) => s + v, 0);
      assert.ok(profile.total >= slotSum, `budget.${profileName}.total (${profile.total}) must be >= slot sum (${slotSum})`);
    }
  });

  it('should have summarization config with valid thresholds', () => {
    const sum = cfg.memory?.summarization;
    assert.ok(sum, 'memory.summarization missing');
    assert.ok(typeof sum.threshold === 'number' && sum.threshold > 0, 'threshold must be positive');
    assert.ok(typeof sum.keepRecent === 'number' && sum.keepRecent > 0, 'keepRecent must be positive');
    assert.ok(sum.keepRecent < sum.threshold, 'keepRecent must be less than threshold');
  });

  it('should have cost.modelRates matching anthropic model names', () => {
    const rates = cfg.cost?.modelRates || {};
    assert.ok(cfg.anthropic.defaultModel in rates, `defaultModel rate missing: ${cfg.anthropic.defaultModel}`);
    assert.ok(cfg.anthropic.advancedModel in rates, `advancedModel rate missing: ${cfg.anthropic.advancedModel}`);
    for (const [model, rate] of Object.entries(rates)) {
      assert.ok(typeof rate.input === 'number', `${model}.input must be number`);
      assert.ok(typeof rate.output === 'number', `${model}.output must be number`);
    }
  });
});

describe('Agent Workspace — SOUL.md / AGENTS.md Validation', () => {
  const agentDirs = fs.readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  it('should have _base directory with SOUL.md', () => {
    assert.ok(agentDirs.includes('_base'), '_base directory missing');
    const baseSoul = path.join(AGENTS_DIR, '_base', 'SOUL.md');
    assert.ok(fs.existsSync(baseSoul), '_base/SOUL.md missing');
    const content = fs.readFileSync(baseSoul, 'utf-8');
    assert.ok(content.length > 100, '_base/SOUL.md too short');
  });

  for (const dir of agentDirs.filter(d => d !== '_base')) {
    it(`${dir}: should have SOUL.md`, () => {
      const soulPath = path.join(AGENTS_DIR, dir, 'SOUL.md');
      assert.ok(fs.existsSync(soulPath), `${dir}/SOUL.md missing`);
      const content = fs.readFileSync(soulPath, 'utf-8');
      assert.ok(content.length > 50, `${dir}/SOUL.md too short (<50 chars)`);
      assert.ok(content.includes('#'), `${dir}/SOUL.md should contain markdown headings`);
    });
  }

  it('should not have duplicate content between _base and agent SOUL.md files', () => {
    const baseSoul = fs.readFileSync(path.join(AGENTS_DIR, '_base', 'SOUL.md'), 'utf-8');
    // Extract meaningful lines (non-empty, non-heading) from _base
    const baseLines = baseSoul.split('\n')
      .filter(l => l.trim().length > 30 && !l.startsWith('#'))
      .map(l => l.trim());

    for (const dir of agentDirs.filter(d => d !== '_base')) {
      const soulPath = path.join(AGENTS_DIR, dir, 'SOUL.md');
      if (!fs.existsSync(soulPath)) continue;
      const agentSoul = fs.readFileSync(soulPath, 'utf-8');
      for (const line of baseLines) {
        assert.ok(!agentSoul.includes(line),
          `P-4 violation: "${line.slice(0, 50)}..." duplicated in ${dir}/SOUL.md and _base/SOUL.md`);
      }
    }
  });
});
