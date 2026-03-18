/**
 * Tier 1 — Context Engine Pure Function Tests.
 *
 * estimateTokens, trimToBudget, formatContextForLLM — DB 불필요.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { estimateTokens } = require('../src/shared/utils');

describe('estimateTokens', () => {
  it('should return 0 for empty/null input', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  it('should estimate English text (~4 chars per token)', () => {
    const text = 'Hello world this is a test of the system';  // 40 chars
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 8 && tokens <= 12, `Expected ~10, got ${tokens}`);
  });

  it('should estimate Korean text (~1.5 chars per token)', () => {
    const text = '안녕하세요 세계입니다';  // 10 Korean chars
    const tokens = estimateTokens(text);
    assert.ok(tokens >= 5 && tokens <= 10, `Expected ~7, got ${tokens}`);
  });

  it('should handle mixed Korean/English text', () => {
    const text = '안녕 hello 세계 world';
    const tokens = estimateTokens(text);
    assert.ok(tokens > 0, 'should return positive number');
  });
});

// formatContextForLLM is also tested through context module export
// but it depends on config which makes direct import test harder without mocking.
// The key format is tested implicitly through Tier 2 integration tests.
