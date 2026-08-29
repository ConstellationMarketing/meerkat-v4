const test = require('node:test');
const assert = require('node:assert/strict');
const { makeChain, runPool } = require('./pool');

test('runPool processes every index with bounded concurrency', async () => {
  const seen = [];
  let inFlight = 0, peak = 0;
  await runPool(9, async (i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 10));
    seen.push(i); inFlight--;
  });
  assert.equal(seen.length, 9);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(peak <= Math.max(1, Number.parseInt(process.env.MEERKAT_CONCURRENCY || '3', 10)));
});

test('makeChain serializes even when a link rejects', async () => {
  const chain = makeChain();
  const order = [];
  const p1 = chain(async () => { await new Promise(r => setTimeout(r, 20)); order.push(1); throw new Error('boom'); }).catch(() => {});
  const p2 = chain(async () => { order.push(2); });
  const p3 = chain(async () => { order.push(3); });
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});
