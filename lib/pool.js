// Small worker pool for the batch loops: N articles in flight inside the one
// engine lane. The lane itself stays single-batch (queue.js); this only
// overlaps articles WITHIN the running batch.
//
// Concurrency default 3: the key's measured limits (10M input TPM, 10K RPM,
// probed 2026-08-29) leave enormous headroom over even 4 concurrent articles,
// and callClaude already retries 429s with backoff if that ever changes.
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.MEERKAT_CONCURRENCY || '3', 10) || 1);

// Serialized async lane. Progress writes on the shared batch_jobs row are
// read-modify-write (counts, errors[]), so concurrent workers must take turns.
function makeChain() {
  let chain = Promise.resolve();
  return (fn) => {
    const run = chain.catch(() => {}).then(fn);
    chain = run;
    return run;
  };
}

// Run worker(i) for i in [0, count) with at most CONCURRENCY in flight.
// Workers start staggered so section-generation bursts don't align.
async function runPool(count, worker) {
  let next = 0;
  const n = Math.min(CONCURRENCY, count);
  const lanes = [];
  for (let w = 0; w < n; w++) {
    lanes.push((async () => {
      if (w) await new Promise(r => setTimeout(r, w * 2000));
      for (;;) {
        const i = next++;
        if (i >= count) return;
        await worker(i);
      }
    })());
  }
  await Promise.all(lanes);
}

module.exports = { CONCURRENCY, makeChain, runPool };
