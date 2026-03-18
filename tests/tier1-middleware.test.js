/**
 * Tier 1 — Middleware Pipeline Tests.
 *
 * 순수 함수: BotFilter, RateLimit, Tracing.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runMiddleware, RateLimiter } = require('../src/core/middleware');

describe('runMiddleware — BotFilter', () => {
  it('should block messages with bot_id', () => {
    const result = runMiddleware({ user: 'U1', text: 'hello', bot_id: 'B123' });
    assert.equal(result.pass, false);
    assert.equal(result.reason, 'bot_message');
  });

  it('should block messages with subtype bot_message', () => {
    const result = runMiddleware({ user: 'U1', text: 'hello', subtype: 'bot_message' });
    assert.equal(result.pass, false);
  });

  it('should pass normal user messages', () => {
    const result = runMiddleware({ user: 'U_TEST_' + Date.now(), text: 'hello' });
    assert.equal(result.pass, true);
    assert.ok(result.traceId.startsWith('t-'), 'traceId should have t- prefix');
  });
});

describe('RateLimiter', () => {
  it('should allow messages under limit', () => {
    const limiter = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      assert.equal(limiter.check('U_RL_TEST'), true, `message ${i + 1} should pass`);
    }
  });

  it('should block messages over limit', () => {
    const limiter = new RateLimiter(3);
    assert.equal(limiter.check('U_RL_OVER'), true);
    assert.equal(limiter.check('U_RL_OVER'), true);
    assert.equal(limiter.check('U_RL_OVER'), true);
    assert.equal(limiter.check('U_RL_OVER'), false, '4th message should be blocked');
  });

  it('should track users independently', () => {
    const limiter = new RateLimiter(2);
    assert.equal(limiter.check('U_A'), true);
    assert.equal(limiter.check('U_A'), true);
    assert.equal(limiter.check('U_A'), false);
    assert.equal(limiter.check('U_B'), true, 'different user should not be affected');
  });
});

describe('runMiddleware — Tracing', () => {
  it('should generate unique traceIds', () => {
    const r1 = runMiddleware({ user: 'U_TR1_' + Date.now(), text: 'a' });
    const r2 = runMiddleware({ user: 'U_TR2_' + Date.now(), text: 'b' });
    assert.notEqual(r1.traceId, r2.traceId);
  });
});
