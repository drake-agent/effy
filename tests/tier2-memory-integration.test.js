/**
 * Tier 2 — Memory Integration Tests (DB-independent parts).
 *
 * better-sqlite3 네이티브 바인딩이 없는 환경에서도 실행 가능한 테스트.
 * SQLite 의존 테스트는 tier2-db-integration.test.js에서 별도 실행.
 *
 * - L1 WorkingMemory: add/get/clear + P-1 summarization flag
 * - ConcurrencyGovernor: acquire/release/queue
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── WorkingMemory는 DB 불필요 (pure in-memory Map) ───
// 단, constructor에서 config를 읽으므로 환경변수 설정 필요
process.env.EFFY_CONFIG = require('path').resolve(__dirname, '../effy.config.yaml');
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SLACK_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_APP_TOKEN = 'xapp-test';

// WorkingMemory를 import하면 config.js가 로드됨. config는 YAML만 읽고 DB 없이 작동.
// 하지만 manager.js의 최상위에서 require('../db/sqlite')를 호출할 수 있으므로
// WorkingMemory만 별도 테스트. manager.js 직접 import은 DB가 필요.

describe('L1: WorkingMemory (isolated)', () => {
  // manager.js를 import하면 sqlite가 필요하므로,
  // WorkingMemory의 로직을 직접 테스트
  let WorkingMemory;

  it('should import WorkingMemory class', () => {
    // DB require를 try/catch — native 바인딩 없으면 모듈 레벨에서 에러 발생 가능
    try {
      ({ WorkingMemory } = require('../src/memory/manager'));
    } catch (e) {
      if (e.message.includes('bindings')) {
        // better-sqlite3 바인딩 없음 — skip gracefully
        assert.ok(true, 'Skipped: better-sqlite3 native bindings not available');
        return;
      }
      throw e;
    }
    assert.ok(WorkingMemory, 'WorkingMemory should be exported');
  });

  it('should add and get entries', () => {
    if (!WorkingMemory) return; // skip if import failed
    const wm = new WorkingMemory(60000, 50);
    wm.add('test:conv:1', { role: 'user', content: 'hello' });
    wm.add('test:conv:1', { role: 'assistant', content: 'hi there' });

    const entries = wm.get('test:conv:1');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].role, 'user');
    assert.equal(entries[1].role, 'assistant');
  });

  it('should return empty for unknown key', () => {
    if (!WorkingMemory) return;
    const wm = new WorkingMemory();
    assert.deepEqual(wm.get('nonexistent'), []);
  });

  it('should clear entries', () => {
    if (!WorkingMemory) return;
    const wm = new WorkingMemory();
    wm.add('clear:test', { role: 'user', content: 'x' });
    assert.equal(wm.get('clear:test').length, 1);
    wm.clear('clear:test');
    assert.deepEqual(wm.get('clear:test'), []);
  });

  it('should enforce maxEntries cap', () => {
    if (!WorkingMemory) return;
    const wm = new WorkingMemory(60000, 5);
    for (let i = 0; i < 10; i++) {
      wm.add('cap:test', { role: 'user', content: `msg ${i}` });
    }
    assert.equal(wm.get('cap:test').length, 5, 'should be capped at maxEntries');
    assert.equal(wm.get('cap:test')[0].content, 'msg 5', 'oldest should be trimmed');
  });

  it('P-1: should set needsSummary flag when threshold exceeded', () => {
    if (!WorkingMemory) return;
    const wm = new WorkingMemory(60000, 100);
    wm.summarizeThreshold = 5;
    wm.summarizationEnabled = true;

    for (let i = 0; i < 6; i++) {
      wm.add('summary:test', { role: 'user', content: `msg ${i}` });
    }
    const bucket = wm.store.get('summary:test');
    assert.equal(bucket.needsSummary, true, 'needsSummary should be true after exceeding threshold');
  });
});

describe('ConcurrencyGovernor (no DB dependency)', () => {
  // pool.js imports config (OK) and db/sqlite — but ConcurrencyGovernor itself
  // doesn't use DB methods. SessionRegistry does use DB in serialize().
  // We test ConcurrencyGovernor only.
  let ConcurrencyGovernor;

  it('should import ConcurrencyGovernor', () => {
    try {
      ({ ConcurrencyGovernor } = require('../src/core/pool'));
    } catch (e) {
      if (e.message.includes('bindings')) {
        assert.ok(true, 'Skipped: better-sqlite3 native bindings not available');
        return;
      }
      throw e;
    }
    assert.ok(ConcurrencyGovernor);
  });

  it('should acquire and release slots', () => {
    if (!ConcurrencyGovernor) return;
    const gov = new ConcurrencyGovernor();
    assert.ok(gov.canAcquire('U1', 'C1'), 'should be available initially');
    gov.acquire('U1', 'C1');
    assert.equal(gov.stats.global, 1);
    gov.release('U1', 'C1');
    assert.equal(gov.stats.global, 0);
  });

  it('should respect perUser limit', async () => {
    if (!ConcurrencyGovernor) return;
    const gov = new ConcurrencyGovernor();

    // config.gateway.maxConcurrency.perUser = 5 (v4.0에서 확대)
    const { config } = require('../src/config');
    const perUserLimit = config.gateway?.maxConcurrency?.perUser || 5;

    // perUser 한도까지 acquire
    const acquired = [];
    for (let i = 0; i < perUserLimit; i++) {
      const r = await gov.waitForSlot('U_PU', `C${i}`);
      assert.equal(r, true, `slot ${i} should be acquired`);
      acquired.push(`C${i}`);
    }

    // 한도 초과 → timeout
    const overflow = await gov.waitForSlot('U_PU', `C${perUserLimit}`, 100);
    assert.equal(overflow, false, 'should timeout when perUser limit exceeded');

    // 정리
    for (const ch of acquired) gov.release('U_PU', ch);
  });

  it('should drain queue on release', async () => {
    if (!ConcurrencyGovernor) return;
    const gov = new ConcurrencyGovernor();

    await gov.waitForSlot('U_DQ', 'C1');
    await gov.waitForSlot('U_DQ', 'C2');

    const waitPromise = gov.waitForSlot('U_DQ', 'C3', 5000);
    gov.release('U_DQ', 'C1');

    const result = await waitPromise;
    assert.equal(result, true, 'queued request should be resolved after release');

    gov.release('U_DQ', 'C2');
    gov.release('U_DQ', 'C3');
  });
});
