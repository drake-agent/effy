/**
 * Tier 2 — Run Logger Integration Tests.
 *
 * P-6: NDJSON append-only 로그 파일 생성/로테이션 검증.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { RunLogger } = require('../src/shared/run-logger');

const TEST_LOG_DIR = path.resolve(__dirname, '../data/test-runs');

/**
 * Wait for stream to flush by closing and waiting a tick.
 */
function closeAndFlush(logger) {
  return new Promise((resolve) => {
    if (logger.stream) {
      logger.stream.end(() => {
        logger.stream = null;
        logger.currentDate = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

describe('RunLogger — P-6', () => {
  let logger;

  before(() => {
    if (fs.existsSync(TEST_LOG_DIR)) {
      fs.rmSync(TEST_LOG_DIR, { recursive: true });
    }
  });

  after(async () => {
    if (logger) await closeAndFlush(logger);
    if (fs.existsSync(TEST_LOG_DIR)) {
      fs.rmSync(TEST_LOG_DIR, { recursive: true });
    }
  });

  it('should create log directory on construction', () => {
    logger = new RunLogger(TEST_LOG_DIR);
    assert.ok(fs.existsSync(TEST_LOG_DIR), 'log directory should be created');
  });

  it('should write NDJSON entries', async () => {
    logger.log({
      traceId: 't-test-1',
      agentId: 'general',
      functionType: 'general',
      budgetProfile: 'STANDARD',
      model: 'claude-haiku-4-5-20251001',
      userId: 'U1',
      channelId: 'C1',
      inputTokens: 100,
      outputTokens: 50,
      iterations: 1,
      durationMs: 500,
    });

    // Flush stream properly
    await closeAndFlush(logger);

    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(TEST_LOG_DIR, `runs-${today}.ndjson`);
    assert.ok(fs.existsSync(logFile), `log file should exist: ${logFile}`);

    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const lines = content.split('\n').filter(l => l.trim());
    assert.ok(lines.length >= 1, 'should have at least 1 line');

    const record = JSON.parse(lines[0]);
    assert.equal(record.traceId, 't-test-1');
    assert.equal(record.agentId, 'general');
    assert.ok(record.ts, 'should have timestamp');
  });

  it('should append multiple entries', async () => {
    logger = new RunLogger(TEST_LOG_DIR);
    logger.log({ traceId: 't-multi-1', agentId: 'code' });
    logger.log({ traceId: 't-multi-2', agentId: 'ops' });
    logger.log({ traceId: 't-multi-3', agentId: 'strategy' });
    await closeAndFlush(logger);

    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(TEST_LOG_DIR, `runs-${today}.ndjson`);
    const content = fs.readFileSync(logFile, 'utf-8').trim();
    const lines = content.split('\n').filter(l => l.trim());
    assert.ok(lines.length >= 3, `expected >= 3 lines, got ${lines.length}`);
  });

  it('should not throw on log() when constructor created dir successfully', async () => {
    // Use a temp dir in the test area (safe path that we CAN create)
    const safeDir = path.join(TEST_LOG_DIR, 'sub-test');
    const safeLogger = new RunLogger(safeDir);
    assert.doesNotThrow(() => {
      safeLogger.log({ traceId: 't-safe' });
    });
    await closeAndFlush(safeLogger);
  });
});
