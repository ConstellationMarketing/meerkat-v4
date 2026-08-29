'use strict';

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { runPipeline } = require('../pipeline');
const { CONCURRENCY, makeChain, runPool } = require('./pool');

// Lazy init — env vars may not be loaded when module is first required
let _supabase = null;
function getSupabase() {
  if (!_supabase) _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: 'meerkat' } });
  return _supabase;
}
const ARTICLE_TABLE = process.env.SUPABASE_TABLE || 'article_outlines';
const BATCH_TABLE = 'batch_jobs';
const DELAY_BETWEEN_ARTICLES_MS = 5000;
// One serialized lane for batch_jobs progress writes: counts and errors[] are
// read-modify-write, so concurrent article workers must take turns.
const progress = makeChain();

/**
 * Start a batch generation run. Processes articles sequentially
 * using the same runPipeline() as single articles.
 *
 * @param {string} batchId - Unique batch identifier
 * @param {object[]} articles - Enriched articles with clientInfo, website, sections resolved
 * @returns {Promise<void>}
 */
async function startBatch(batchId, articles) {
  console.log(`[Batch] Starting batch "${batchId}" with ${articles.length} articles (concurrency ${CONCURRENCY})`);

  // Update status to processing
  await getSupabase().from(BATCH_TABLE).update({ status: 'processing' }).eq('batch_id', batchId);

  let cancelled = false;
  await runPool(articles.length, async (i) => {
    if (cancelled) return;
    const article = articles[i];
    const articleId = crypto.randomUUID();

    // Check for cancellation before each article
    const { data: job } = await getSupabase()
      .from(BATCH_TABLE)
      .select('status')
      .eq('batch_id', batchId)
      .single();

    if (cancelled || job?.status === 'cancelled') {
      if (!cancelled) console.log(`[Batch] Cancelled at article ${i + 1}/${articles.length}`);
      cancelled = true;
      return;
    }

    // Update current progress (latest article to start; cosmetic under concurrency)
    await progress(() => getSupabase().from(BATCH_TABLE).update({
      current_keyword: article.keyword
    }).eq('batch_id', batchId));

    console.log(`[Batch] [${i + 1}/${articles.length}] Generating: "${article.keyword}" (${article.clientName})`);

    // Seed the article row in article_outlines
    const seedRow = {
      id: Math.random().toString(36).substring(2, 12),
      article_id: articleId,
      client_name: article.clientName,
      client_id: article.clientId || null,
      keyword: article.keyword,
      template: article.template || null,
      sections: article.sections,
      batch_id: batchId,
      version: `V${require('../package.json').version}`,
      updated_at: new Date().toISOString(),
    };

    const { error: seedError } = await getSupabase().from(ARTICLE_TABLE).insert(seedRow);
    if (seedError) {
      console.error(`[Batch] Failed to seed article "${article.keyword}":`, seedError.message);
      await recordFailure(batchId, articleId, article, `Seed failed: ${seedError.message}`);
      return;
    }

    // Build pipeline payload
    const payload = {
      articleid: articleId,
      clientId: article.clientId || null,
      clientName: article.clientName,
      clientInfo: article.clientInfo || '',
      website: article.website || '',
      keyword: article.keyword,
      template: article.template || 'Practice Page',
      sections: article.sections,
      userId: article.userId || null,
    };

    try {
      const result = await runPipeline(payload);

      if (result.supabaseError) {
        console.error(`[Batch] Pipeline error for "${article.keyword}":`, result.supabaseError);
        await recordFailure(batchId, articleId, article, result.supabaseError);
      } else {
        console.log(`[Batch] [${i + 1}/${articles.length}] Complete: "${article.keyword}" | ${result.wordCount} words | flesch ${result.fleschScore}`);
        await progress(async () => getSupabase().from(BATCH_TABLE).update({
          completed_count: (await getCompletedCount(batchId)) + 1
        }).eq('batch_id', batchId));
      }
    } catch (err) {
      console.error(`[Batch] Pipeline crashed for "${article.keyword}":`, err.message);
      await recordFailure(batchId, articleId, article, err.message);
    }

    // Small pause before this worker takes its next article
    if (i < articles.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_ARTICLES_MS));
    }
  });

  // Final status update
  const { data: finalJob } = await getSupabase()
    .from(BATCH_TABLE)
    .select('status, completed_count, failed_count, total_articles')
    .eq('batch_id', batchId)
    .single();

  if (finalJob && finalJob.status !== 'cancelled') {
    const finalStatus = finalJob.failed_count === finalJob.total_articles ? 'failed' : 'completed';
    await getSupabase().from(BATCH_TABLE).update({
      status: finalStatus,
      current_keyword: null
    }).eq('batch_id', batchId);
    console.log(`[Batch] Batch "${batchId}" ${finalStatus}: ${finalJob.completed_count} completed, ${finalJob.failed_count} failed`);
  }
}

/**
 * Record a failure for an article in the batch.
 */
async function recordFailure(batchId, articleId, article, errorMsg) {
  return progress(async () => {
    const { data: job } = await getSupabase()
      .from(BATCH_TABLE)
      .select('errors, failed_count')
      .eq('batch_id', batchId)
      .single();

    const errors = job?.errors || [];
    errors.push({
      articleId,
      keyword: article.keyword,
      clientName: article.clientName,
      error: errorMsg,
      timestamp: new Date().toISOString()
    });

    await getSupabase().from(BATCH_TABLE).update({
      errors,
      failed_count: (job?.failed_count || 0) + 1
    }).eq('batch_id', batchId);
  });
}

/**
 * Get current completed count from DB.
 */
async function getCompletedCount(batchId) {
  const { data } = await getSupabase()
    .from(BATCH_TABLE)
    .select('completed_count')
    .eq('batch_id', batchId)
    .single();
  return data?.completed_count || 0;
}

/**
 * Cancel a running batch. The processing loop checks for this between articles.
 */
async function cancelBatch(batchId) {
  const { error } = await getSupabase()
    .from(BATCH_TABLE)
    .update({ status: 'cancelled', current_keyword: null })
    .eq('batch_id', batchId);

  if (error) throw new Error(`Cancel failed: ${error.message}`);
  console.log(`[Batch] Batch "${batchId}" marked as cancelled`);
}

/**
 * Retry failed articles from a completed/failed batch.
 *
 * @param {string} batchId
 * @param {object[]} articles  — pre-enriched candidates (caller has already
 *                                resolved client and template data)
 * @param {string[]|null} articleKeywords  — optional subset filter. If
 *   provided, only the keywords in this list (intersected with the batch's
 *   failed set) are retried. If null/empty, every failed article in the
 *   batch is retried.
 */
async function retryFailed(batchId, articles, articleKeywords = null) {
  const { data: job } = await getSupabase()
    .from(BATCH_TABLE)
    .select('*')
    .eq('batch_id', batchId)
    .single();

  if (!job) throw new Error(`Batch "${batchId}" not found`);
  if (!job.errors || job.errors.length === 0) throw new Error('No failed articles to retry');

  // Determine target keywords. Caller-supplied subset is intersected with
  // the failed set so retries are always scoped to actual failures.
  const failedKeywords = new Set(job.errors.map(e => e.keyword));
  const requestedKeywords = Array.isArray(articleKeywords) && articleKeywords.length > 0
    ? new Set(articleKeywords)
    : null;
  const targetKeywords = requestedKeywords
    ? new Set([...failedKeywords].filter(k => requestedKeywords.has(k)))
    : failedKeywords;

  const retryArticles = articles.filter(a => targetKeywords.has(a.keyword));
  if (retryArticles.length === 0) throw new Error('No matching articles found for retry');

  // Remove only the to-be-retried errors from errors[] and decrement
  // failed_count by that amount. Preserve total_articles and completed_count
  // so historic batch metrics stay correct. Previous behavior reset
  // total_articles to retryArticles.length, which destroyed the original
  // batch shape ("5 of 5 attempted, 1 failed" became "1 of 1 attempted").
  const remainingErrors = (job.errors || []).filter(e => !targetKeywords.has(e.keyword));
  // Atomic claim: only a batch that is finished (failed/completed/orphaned) can
  // be retried. Without the status filter a retry on a still-processing batch
  // started a SECOND generation loop on the same row, both loops writing
  // counts/errors over each other (review finding, 2026-08-29).
  const { data: claimed, error: claimError } = await getSupabase().from(BATCH_TABLE).update({
    status: 'processing',
    errors: remainingErrors,
    failed_count: remainingErrors.length,
    current_keyword: null,
  }).eq('batch_id', batchId).in('status', ['failed', 'completed', 'orphaned']).select('batch_id');
  if (claimError) throw new Error(`Retry claim failed: ${claimError.message}`);
  if (!claimed || claimed.length === 0) {
    throw new Error(`Batch "${batchId}" is still running or queued - wait for it to finish before retrying`);
  }

  const scope = requestedKeywords ? 'selected' : 'all';
  console.log(`[Batch] Retrying ${retryArticles.length} ${scope} failed article(s) from batch "${batchId}"`);
  await startBatch(batchId, retryArticles);
}

/**
 * Get batch status.
 */
async function getBatchStatus(batchId) {
  const { data, error } = await getSupabase()
    .from(BATCH_TABLE)
    .select('*')
    .eq('batch_id', batchId)
    .single();

  if (error) throw new Error(`Status fetch failed: ${error.message}`);
  return data;
}

/**
 * Return any batch_jobs row currently in 'processing' status. Used by
 * /batch/start to refuse a second concurrent run, and by markOrphanedBatches
 * on VPS startup to detect runs that died mid-flight.
 *
 * Returns the most-recent matching row or null.
 */
async function getActiveBatch() {
  const { data, error } = await getSupabase()
    .from(BATCH_TABLE)
    .select('*')
    .eq('status', 'processing')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`Active-batch lookup failed: ${error.message}`);
  return (data && data[0]) || null;
}

/**
 * On VPS startup, mark any 'processing' batch as 'orphaned'. The fire-and-
 * forget batch loop in startBatch() runs in the same process, so any process
 * restart abandons in-flight batches with no recovery. Without this sweep
 * those rows would stay in 'processing' forever, preventing future batches
 * from starting (per the lock in /batch/start).
 *
 * Safe to call from server.js startup. Idempotent — does nothing if no
 * orphans exist.
 */
async function markOrphanedBatches() {
  // The test instance shares this batch_jobs table; its restarts must never
  // orphan a live production batch. Set SKIP_ORPHAN_SWEEP=1 on that process.
  if (process.env.SKIP_ORPHAN_SWEEP === '1') {
    console.log('[Batch] Orphan sweep skipped (SKIP_ORPHAN_SWEEP=1)');
    return;
  }
  const { data: orphans, error: fetchError } = await getSupabase()
    .from(BATCH_TABLE)
    .select('batch_id, current_keyword, total_articles, completed_count')
    .eq('status', 'processing');
  if (fetchError) {
    console.error('[Batch] Orphan sweep — fetch failed:', fetchError.message);
    return;
  }
  if (!orphans || orphans.length === 0) return;

  console.warn(`[Batch] Found ${orphans.length} orphaned batch(es) from a prior process — marking as 'orphaned'`);
  for (const o of orphans) {
    console.warn(`  - ${o.batch_id} | last keyword: ${o.current_keyword || '(none)'} | progress: ${o.completed_count}/${o.total_articles}`);
  }

  const { error: updateError } = await getSupabase()
    .from(BATCH_TABLE)
    .update({ status: 'orphaned', current_keyword: null })
    .eq('status', 'processing');
  if (updateError) {
    console.error('[Batch] Orphan sweep — update failed:', updateError.message);
  }
}

module.exports = { startBatch, cancelBatch, retryFailed, getBatchStatus, getActiveBatch, markOrphanedBatches };
