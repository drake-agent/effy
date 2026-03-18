/**
 * Tier 1 — Tool Registry Static Validation.
 *
 * 순수 함수 테스트: DB/IO 의존성 없음.
 * - 모든 도구 정의가 Anthropic API 스키마 준수
 * - getToolsForFunction 정확성
 * - buildToolSchemas 출력 포맷
 * - validateToolInput 필수 필드 검증
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  TOOL_DEFINITIONS,
  getToolsForFunction,
  buildToolSchemas,
  validateToolInput,
} = require('../src/agents/tool-registry');

describe('Tool Registry — Schema Completeness', () => {
  const allTools = Object.keys(TOOL_DEFINITIONS);

  it('should have at least 1 tool defined', () => {
    assert.ok(allTools.length > 0, 'No tools defined');
  });

  for (const name of Object.keys(TOOL_DEFINITIONS)) {
    it(`${name}: has required fields (name, description, input_schema, agents, category)`, () => {
      const def = TOOL_DEFINITIONS[name];
      assert.equal(def.name, name, 'name must match key');
      assert.ok(typeof def.description === 'string' && def.description.length > 0, 'description required');
      assert.ok(typeof def.category === 'string', 'category required');
      assert.ok(Array.isArray(def.agents) && def.agents.length > 0, 'agents must be non-empty array');
      assert.ok(def.input_schema && typeof def.input_schema === 'object', 'input_schema required');
    });

    it(`${name}: input_schema is valid JSON Schema structure`, () => {
      const schema = TOOL_DEFINITIONS[name].input_schema;
      assert.equal(schema.type, 'object', 'input_schema.type must be "object"');
      assert.ok(schema.properties && typeof schema.properties === 'object', 'properties required');
      if (schema.required) {
        assert.ok(Array.isArray(schema.required), 'required must be array');
        for (const field of schema.required) {
          assert.ok(field in schema.properties, `required field "${field}" must exist in properties`);
        }
      }
    });

    it(`${name}: all property types are valid JSON Schema types`, () => {
      const validTypes = ['string', 'number', 'boolean', 'object', 'array', 'integer', 'null'];
      const props = TOOL_DEFINITIONS[name].input_schema.properties;
      for (const [field, prop] of Object.entries(props)) {
        assert.ok(validTypes.includes(prop.type), `${name}.${field}.type "${prop.type}" is not valid`);
      }
    });
  }
});

describe('getToolsForFunction', () => {
  it('should return wildcard tools for any functionType', () => {
    const generalTools = getToolsForFunction('general');
    assert.ok(generalTools.includes('slack_reply'), 'slack_reply (agents=["*"]) should be in general');
    assert.ok(generalTools.includes('search_knowledge'), 'search_knowledge should be in general');
    assert.ok(generalTools.includes('save_knowledge'), 'save_knowledge should be in general');
  });

  it('should return ops-specific tools only for ops', () => {
    const opsTools = getToolsForFunction('ops');
    assert.ok(opsTools.includes('create_task'), 'create_task should be in ops');
    assert.ok(opsTools.includes('create_incident'), 'create_incident should be in ops');

    const generalTools = getToolsForFunction('general');
    assert.ok(!generalTools.includes('create_task'), 'create_task should NOT be in general');
    assert.ok(!generalTools.includes('create_incident'), 'create_incident should NOT be in general');
  });

  it('should handle unknown functionType gracefully (returns wildcard tools only)', () => {
    const tools = getToolsForFunction('nonexistent');
    assert.ok(tools.includes('slack_reply'), 'wildcard tools still returned');
    assert.ok(!tools.includes('create_task'), 'ops-specific tools excluded');
  });
});

describe('buildToolSchemas', () => {
  it('should convert tool names to Anthropic API format', () => {
    const schemas = buildToolSchemas(['slack_reply', 'search_knowledge']);
    assert.equal(schemas.length, 2);
    for (const schema of schemas) {
      assert.ok(typeof schema.name === 'string');
      assert.ok(typeof schema.description === 'string');
      assert.ok(typeof schema.input_schema === 'object');
      // Must NOT include internal fields (category, agents)
      assert.equal(schema.category, undefined, 'category should not leak to API');
      assert.equal(schema.agents, undefined, 'agents should not leak to API');
    }
  });

  it('should skip unknown tool names gracefully', () => {
    const schemas = buildToolSchemas(['slack_reply', 'does_not_exist']);
    assert.equal(schemas.length, 1, 'unknown tools filtered out');
    assert.equal(schemas[0].name, 'slack_reply');
  });

  it('should return empty array for empty input', () => {
    const schemas = buildToolSchemas([]);
    assert.deepEqual(schemas, []);
  });
});

// ─── 새 도구 Agent 권한 + 카테고리 검증 ───────────────────
describe('New Tools — Agent Access & Categories', () => {
  const opsOnlyTools = ['send_message', 'cron_schedule'];
  const restrictedTools = { file_write: ['ops', 'code'], shell: ['ops', 'code'] };
  const wildcardNewTools = ['react', 'send_file', 'send_agent_message',
    'task_list', 'task_update', 'file_read',
    'web_search', 'config_inspect', 'set_status'];

  for (const name of opsOnlyTools) {
    it(`${name}: should be ops-only`, () => {
      const def = TOOL_DEFINITIONS[name];
      assert.ok(def, `${name} must exist`);
      assert.ok(def.agents.includes('ops'), `${name} should include 'ops'`);
      assert.ok(!def.agents.includes('*'), `${name} should NOT be wildcard`);
    });
  }

  for (const name of wildcardNewTools) {
    it(`${name}: should be available to all agents`, () => {
      const def = TOOL_DEFINITIONS[name];
      assert.ok(def, `${name} must exist`);
      assert.ok(def.agents.includes('*'), `${name} should be wildcard`);
    });
  }

  for (const [name, expectedAgents] of Object.entries(restrictedTools)) {
    it(`${name}: should be restricted to ${expectedAgents.join(', ')}`, () => {
      const def = TOOL_DEFINITIONS[name];
      assert.ok(def, `${name} must exist`);
      assert.ok(!def.agents.includes('*'), `${name} should NOT be wildcard`);
      for (const a of expectedAgents) {
        assert.ok(def.agents.includes(a), `${name} should include '${a}'`);
      }
    });
  }

  it('should have exactly 31 tools total', () => {
    assert.equal(Object.keys(TOOL_DEFINITIONS).length, 31);
  });

  it('send_message: category should be communication', () => {
    assert.equal(TOOL_DEFINITIONS.send_message.category, 'communication');
  });

  it('shell: category should be system', () => {
    assert.equal(TOOL_DEFINITIONS.shell.category, 'system');
  });

  it('cron_schedule: category should be integration', () => {
    assert.equal(TOOL_DEFINITIONS.cron_schedule.category, 'integration');
  });

  it('config_inspect: category should be config', () => {
    assert.equal(TOOL_DEFINITIONS.config_inspect.category, 'config');
  });

  it('getToolsForFunction("ops") should include send_message', () => {
    const opsTools = getToolsForFunction('ops');
    assert.ok(opsTools.includes('send_message'), 'send_message in ops');
    assert.ok(!opsTools.includes('memory_delete'), 'memory_delete should be removed');
  });

  it('getToolsForFunction("general") should include new wildcard tools', () => {
    const generalTools = getToolsForFunction('general');
    for (const name of wildcardNewTools) {
      assert.ok(generalTools.includes(name), `${name} should be in general`);
    }
  });

  it('getToolsForFunction("general") should NOT include ops-only or restricted tools', () => {
    const generalTools = getToolsForFunction('general');
    for (const name of opsOnlyTools) {
      assert.ok(!generalTools.includes(name), `${name} should NOT be in general`);
    }
    for (const name of Object.keys(restrictedTools)) {
      assert.ok(!generalTools.includes(name), `${name} should NOT be in general`);
    }
  });
});

// ─── 새 도구 필수 필드 검증 ─────────────────────────────
describe('New Tools — Required Field Validation', () => {
  it('send_message: requires channel and text', () => {
    const r1 = validateToolInput('send_message', { channel: 'C123', text: 'hi' });
    assert.equal(r1.valid, true);
    const r2 = validateToolInput('send_message', { channel: 'C123' });
    assert.equal(r2.valid, false);
  });

  it('react: requires channel, timestamp, emoji', () => {
    const r = validateToolInput('react', { channel: 'C1', timestamp: '123.456', emoji: 'thumbsup' });
    assert.equal(r.valid, true);
    const bad = validateToolInput('react', { channel: 'C1' });
    assert.equal(bad.valid, false);
  });

  it('send_file: requires channel, content, filename', () => {
    const r = validateToolInput('send_file', { channel: 'C1', content: 'data', filename: 'a.txt' });
    assert.equal(r.valid, true);
  });

  it('file_read: requires path', () => {
    const r = validateToolInput('file_read', { path: 'data/test.txt' });
    assert.equal(r.valid, true);
    const bad = validateToolInput('file_read', {});
    assert.equal(bad.valid, false);
  });

  it('file_write: requires path and content', () => {
    const r = validateToolInput('file_write', { path: 'data/output/f.txt', content: 'x' });
    assert.equal(r.valid, true);
  });

  it('shell: requires command', () => {
    const r = validateToolInput('shell', { command: 'ls -la' });
    assert.equal(r.valid, true);
    const bad = validateToolInput('shell', {});
    assert.equal(bad.valid, false);
  });

  it('web_search: requires query', () => {
    const r = validateToolInput('web_search', { query: 'test' });
    assert.equal(r.valid, true);
  });

  it('cron_schedule: requires action', () => {
    const r = validateToolInput('cron_schedule', { action: 'list' });
    assert.equal(r.valid, true);
  });

  it('memory_delete: should not exist (permanently disabled)', () => {
    assert.ok(!TOOL_DEFINITIONS.memory_delete, 'memory_delete should be removed');
    const r = validateToolInput('memory_delete', { hash: 'abc123', reason: 'test' });
    assert.equal(r.valid, false, 'should fail validation for removed tool');
  });

  it('task_update: requires task_id', () => {
    const r = validateToolInput('task_update', { task_id: '1' });
    assert.equal(r.valid, true);
    const bad = validateToolInput('task_update', {});
    assert.equal(bad.valid, false);
  });
});

describe('validateToolInput', () => {
  it('should pass when all required fields present', () => {
    const result = validateToolInput('slack_reply', { channel: 'C123', text: 'hello' });
    assert.equal(result.valid, true);
  });

  it('should fail when required field is missing', () => {
    const result = validateToolInput('slack_reply', { channel: 'C123' });
    assert.equal(result.valid, false);
    assert.ok(result.error.includes('text'), 'error should mention missing field');
    assert.ok(typeof result.hint === 'string' && result.hint.length > 0, 'P-3: hint required');
  });

  it('should fail when required field is empty string', () => {
    const result = validateToolInput('slack_reply', { channel: 'C123', text: '' });
    assert.equal(result.valid, false);
  });

  it('should fail for unknown tool with hint', () => {
    const result = validateToolInput('nonexistent_tool', {});
    assert.equal(result.valid, false);
    assert.ok(result.hint.includes('slack_reply'), 'hint should list available tools');
  });

  it('should pass when optional fields are omitted', () => {
    const result = validateToolInput('save_knowledge', { content: 'some content' });
    assert.equal(result.valid, true);
  });
});
