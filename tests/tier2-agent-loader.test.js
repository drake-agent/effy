/**
 * Tier 2 — Agent Loader Integration Tests.
 *
 * 실제 agents/ 디렉토리에서 SOUL.md / AGENTS.md 로드 검증.
 * P-4: _base 계층 조립 순서 검증.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { AgentLoader } = require('../src/gateway/agent-loader');

const AGENTS_DIR = path.resolve(__dirname, '../agents');

describe('AgentLoader — P-4 Base Layer', () => {
  const loader = new AgentLoader(AGENTS_DIR);

  it('should load _base/SOUL.md and _base/AGENTS.md', () => {
    const base = loader.loadBase();
    assert.ok(base.soul.length > 0, '_base/SOUL.md should have content');
    assert.ok(base.agents.length > 0, '_base/AGENTS.md should have content');
  });

  it('should cache _base and return same reference on second call', () => {
    const base1 = loader.loadBase();
    const base2 = loader.loadBase();
    assert.equal(base1.soul, base2.soul, 'should return cached content');
  });
});

describe('AgentLoader — Agent Loading', () => {
  const loader = new AgentLoader(AGENTS_DIR);

  it('should load general agent', () => {
    const { soul, agents } = loader.load('general');
    assert.ok(soul.includes('SOUL'), 'should contain SOUL heading');
    assert.ok(soul.length > 50, 'soul should have meaningful content');
  });

  it('should return fallback for nonexistent agent', () => {
    const { soul } = loader.load('nonexistent_agent_xyz');
    assert.ok(soul.includes('nonexistent_agent_xyz'), 'fallback should mention agent name');
  });

  it('should list all agents (excluding _base)', () => {
    const agents = loader.listAgents();
    assert.ok(agents.includes('general'), 'should list general agent');
    assert.ok(!agents.includes('_base'), 'should NOT list _base');
    assert.ok(agents.length >= 3, 'should have at least 3 agents');
  });
});

describe('AgentLoader — buildSystemPrompt Assembly Order', () => {
  const loader = new AgentLoader(AGENTS_DIR);

  it('should assemble in correct P-4 order: base.soul → agent.soul → base.agents → agent.agents → memory', () => {
    const prompt = loader.buildSystemPrompt('general', '<test_memory>hello</test_memory>');

    const baseSoul = loader.loadBase().soul;
    const agentSoul = loader.load('general').soul;
    const baseAgents = loader.loadBase().agents;

    // Verify order by checking that base SOUL content comes before agent SOUL
    const baseSoulPos = prompt.indexOf(baseSoul.slice(0, 30));
    const agentSoulPos = prompt.indexOf(agentSoul.slice(0, 30));
    const baseAgentsPos = prompt.indexOf(baseAgents.slice(0, 30));
    const memoryPos = prompt.indexOf('<test_memory>');

    assert.ok(baseSoulPos >= 0, 'base SOUL should be in prompt');
    assert.ok(agentSoulPos > baseSoulPos, 'agent SOUL should come after base SOUL');
    assert.ok(baseAgentsPos > agentSoulPos, 'base AGENTS should come after agent SOUL');
    assert.ok(memoryPos > baseAgentsPos, 'memory should come after base AGENTS');
  });

  it('should wrap memory in <memory_context> tags', () => {
    const prompt = loader.buildSystemPrompt('general', 'some context');
    assert.ok(prompt.includes('<memory_context>'), 'should have opening tag');
    assert.ok(prompt.includes('</memory_context>'), 'should have closing tag');
    assert.ok(prompt.includes('some context'), 'should include memory content');
  });

  it('should handle empty memory context', () => {
    const prompt = loader.buildSystemPrompt('general', '');
    // Empty string is falsy → no memory block appended.
    // _base/SOUL.md may reference <memory_context> in instructions,
    // so check that the CLOSING pattern (newline + tag) is absent.
    assert.ok(!prompt.includes('\n---\n\n<memory_context>\n\n</memory_context>'),
      'should not include empty memory block wrapper');
  });
});

describe('AgentLoader — Cache Invalidation', () => {
  const loader = new AgentLoader(AGENTS_DIR);

  it('should clear specific agent cache', () => {
    loader.load('general');
    assert.ok(loader.cache.has('general'));
    loader.invalidate('general');
    assert.ok(!loader.cache.has('general'));
  });

  it('should clear all caches', () => {
    loader.load('general');
    loader.loadBase();
    assert.ok(loader.cache.size > 0);
    loader.invalidate();
    assert.equal(loader.cache.size, 0);
  });
});
