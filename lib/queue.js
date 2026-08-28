'use strict';

// FIFO batch queue: one engine, one lane, zero refusals.
//
// Every batch launch (generation and optimization) inserts a batch_jobs row
// with status 'queued' plus the ready-to-run payload, then pump() drains the
// queue one batch at a time in created_at order. Callers never see the old
// "another batch is already running" 409 — with multiple editors launching
// work, refusal was a clash; queueing is invisible.
//
// pump() is the single consumer. All launches arrive through this one Node
// process, so the in-process `running` flag is the lock — no DB-level
// coordination needed. On process restart, queued rows survive (payload is in
// queue_payload) and server startup calls pump() after the orphan sweep, so a
// queue never needs a human to restart it.
//
// Columns (scripts/migration/batch-queue-columns.sql):
//   queue_kind     'generate' | 'optimize' — which runner starts the batch
//   queue_payload  the enriched articles/items array, nulled once started

const { createClient } = require('@supabase/supabase-js');
const { startBatch } = require('./batch');
const { startOptimizeBatch } = require('./optimize');

let _supabase = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: 'meerkat' } });
  return _supabase;
}
const BATCH_TABLE = 'batch_jobs';

let running = false;

/**
 * Insert a batch as 'queued' and kick the pump. Returns { ahead } — how many
 * batches (queued or processing) sit in front of this one. ahead === 0 means
 * it starts immediately.
 */
async function enqueueBatch({ batchId, kind, payload, total, userId, csvData }) {
  const { error } = await getSupabase().from(BATCH_TABLE).insert({
    batch_id: batchId,
    status: 'queued',
    queue_kind: kind,
    queue_payload: payload,
    total_articles: total,
    completed_count: 0,
    failed_count: 0,
    errors: [],
    created_by: userId || null,
    ...(csvData ? { csv_data: csvData } : {}),
  });
  if (error) throw new Error(`Failed to enqueue batch: ${error.message}`);
  const ahead = await countAhead(batchId);
  pump();
  return { ahead };
}

/** Batches queued or processing ahead of batchId, in FIFO order. */
async function countAhead(batchId) {
  const { data, error } = await getSupabase()
    .from(BATCH_TABLE)
    .select('batch_id, status, created_at')
    .in('status', ['queued', 'processing'])
    .order('created_at', { ascending: true });
  if (error) return 0;
  const rows = data || [];
  const index = rows.findIndex((row) => row.batch_id === batchId);
  return index === -1 ? rows.length : index;
}

/**
 * Drain the queue: while nothing is processing, claim the oldest queued batch
 * and run it to completion, then look again. Never throws.
 */
async function pump() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const { data: active } = await getSupabase()
        .from(BATCH_TABLE).select('batch_id').eq('status', 'processing').limit(1);
      if (active && active.length) return; // a batch is running (this lane or /batch/retry) — it will pump on completion

      const { data: next } = await getSupabase()
        .from(BATCH_TABLE)
        .select('batch_id, queue_kind, queue_payload')
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(1);
      const job = next && next[0];
      if (!job) return;

      // Claim only if still queued (a cancel may have landed since the read).
      const { data: claimed } = await getSupabase()
        .from(BATCH_TABLE)
        .update({ status: 'processing', queue_payload: null })
        .eq('batch_id', job.batch_id)
        .eq('status', 'queued')
        .select('batch_id');
      if (!claimed || !claimed.length) continue;

      const items = Array.isArray(job.queue_payload) ? job.queue_payload : [];
      console.log(`[Queue] Starting ${job.queue_kind || 'generate'} batch "${job.batch_id}" (${items.length} items)`);
      try {
        if (job.queue_kind === 'optimize') await startOptimizeBatch(job.batch_id, items);
        else await startBatch(job.batch_id, items);
      } catch (err) {
        // A top-level crash skips the runner's own final-status pass; mark the
        // batch failed so the lane never wedges on a phantom 'processing' row.
        console.error(`[Queue] Batch "${job.batch_id}" crashed:`, err.message);
        try {
          await getSupabase().from(BATCH_TABLE)
            .update({ status: 'failed', current_keyword: null })
            .eq('batch_id', job.batch_id).eq('status', 'processing');
        } catch { /* next pump() resolves it */ }
      }
    }
  } catch (err) {
    console.error('[Queue] pump error:', err.message);
  } finally {
    running = false;
  }
}

module.exports = { enqueueBatch, pump, countAhead };
