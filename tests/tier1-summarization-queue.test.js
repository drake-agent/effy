/**
 * tier1-summarization-queue.test.js — R2-PERF-4: SummarizationQueue tests.
 *
 * Verifies concurrency limiting, queue ordering, load shedding, and stats.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SummarizationQueue } = require('../src/shared/summarization-queue');

describe('SummarizationQueue', () => {
  it('executes immediately when under concurrency limit', async () => {
    const q = new SummarizationQueue(2);
    const result = await q.enqueue(async () => 'done');
    assert.equal(result, 'done');
    assert.equal(q.getStats().processed, 1);
  });

  it('limits concurrent executions to maxConcurrent', async () => {
    const q = new SummarizationQueue(2);
    let activeCalls = 0;
    let maxActiveCalls = 0;

    const task = () => new Promise((resolve) => {
      activeCalls++;
      if (activeCalls > maxActiveCalls) maxActiveCalls = activeCalls;
      setTimeout(() => {
        activeCalls--;
        resolve('ok');
      }, 50);
    });

    // Launch 5 tasks simultaneously — only 2 should run at once
    const results = await Promise.all([
      q.enqueue(task),
      q.enqueue(task),
      q.enqueue(task),
      q.enqueue(task),
      q.enqueue(task),
    ]);

    assert.equal(maxActiveCalls, 2, 'should never exceed maxConcurrent=2');
    assert.equal(results.length, 5);
    results.forEach(r => assert.equal(r, 'ok'));
    assert.equal(q.getStats().processed, 5);
  });

  it('queues excess tasks and processes them in order', async () => {
    const q = new SummarizationQueue(1);
    const order = [];

    const task = (id) => async () => {
      order.push(id);
      await new Promise(r => setTimeout(r, 10));
      return id;
    };

    const [r1, r2, r3] = await Promise.all([
      q.enqueue(task('A')),
      q.enqueue(task('B')),
      q.enqueue(task('C')),
    ]);

    assert.equal(r1, 'A');
    assert.equal(r2, 'B');
    assert.equal(r3, 'C');
    assert.deepEqual(order, ['A', 'B', 'C'], 'should process in FIFO order');
  });

  it('drops tasks when queue is full (load shedding)', async () => {
    const q = new SummarizationQueue(1);
    q._maxQueueDepth = 2; // Override for test

    // 1 active + 2 queued = full, 4th should be dropped
    const blocker = new Promise((resolve) => {
      q.enqueue(async () => {
        await new Promise(r => setTimeout(r, 200));
        resolve('blocker');
        return 'blocker';
      });
    });

    // These 2 queue behind the blocker
    const p1 = q.enqueue(async () => 'q1');
    const p2 = q.enqueue(async () => 'q2');

    // This one should be dropped (queue full)
    const dropped = await q.enqueue(async () => 'dropped');

    assert.equal(dropped, null, 'should return null when queue is full');
    assert.equal(q.getStats().dropped, 1);

    // Wait for blocker to finish
    await blocker;
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1, 'q1');
    assert.equal(r2, 'q2');
  });

  it('propagates errors from task', async () => {
    const q = new SummarizationQueue(2);
    await assert.rejects(
      () => q.enqueue(async () => { throw new Error('API error'); }),
      { message: 'API error' }
    );
    // Queue should still work after error
    const result = await q.enqueue(async () => 'recovered');
    assert.equal(result, 'recovered');
  });

  it('getStats() reports accurate counts', async () => {
    const q = new SummarizationQueue(1);
    q._maxQueueDepth = 1;

    const stats0 = q.getStats();
    assert.equal(stats0.active, 0);
    assert.equal(stats0.pending, 0);
    assert.equal(stats0.processed, 0);
    assert.equal(stats0.dropped, 0);
    assert.equal(stats0.maxConcurrent, 1);

    // Fill up: 1 active + 1 queued
    let resolveBlocker;
    const blockerP = q.enqueue(() => new Promise(r => { resolveBlocker = r; }));
    q.enqueue(async () => 'q1');

    const stats1 = q.getStats();
    assert.equal(stats1.active, 1);
    assert.equal(stats1.pending, 1);

    // Drop one
    const dropped = await q.enqueue(async () => 'overflow');
    assert.equal(dropped, null);
    assert.equal(q.getStats().dropped, 1);

    resolveBlocker('done');
    await blockerP;
  });

  it('setMaxConcurrent() adjusts limit at runtime', async () => {
    const q = new SummarizationQueue(1);
    let activeCalls = 0;
    let maxActiveCalls = 0;

    const task = () => new Promise((resolve) => {
      activeCalls++;
      if (activeCalls > maxActiveCalls) maxActiveCalls = activeCalls;
      setTimeout(() => { activeCalls--; resolve('ok'); }, 30);
    });

    // Start with maxConcurrent=1
    const p1 = q.enqueue(task);
    const p2 = q.enqueue(task);

    // Raise to 3
    q.setMaxConcurrent(3);

    const p3 = q.enqueue(task);
    await Promise.all([p1, p2, p3]);

    // maxActiveCalls may be 2 or 3 depending on timing
    assert.ok(maxActiveCalls >= 2, 'should allow more concurrent after raising limit');
  });
});
