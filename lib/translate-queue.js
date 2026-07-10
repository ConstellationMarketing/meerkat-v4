'use strict';

/**
 * Automatic translation queue + reconciler.
 *
 * Two mechanisms keep ES/VI translations in sync with the English article:
 *
 * 1. queueTranslation(articleId) — debounced trigger. The autosave path
 *    (update-article) pings this on every save; the translation only fires
 *    once the article has been quiet for DEBOUNCE_MS (2 min). New articles
 *    from the pipeline use a short delay instead.
 *
 * 2. startReconciler() — periodic sweep (default 30 min) that catches
 *    everything the debounce misses: server restarts (in-memory timers are
 *    lost), stuck 'pending' rows, failed runs (retried up to MAX_ATTEMPTS),
 *    and articles that never got a translation at all. Throttled to
 *    MAX_PER_RUN articles per sweep so a large backlog drains gradually
 *    instead of hammering the Anthropic API.
 *
 * All actual translation runs are serialized through a single promise chain —
 * one Haiku call at a time, matching the load profile of the old manual flow.
 */

const { runTranslation, SUPPORTED_LANGUAGES } = require('./translate');
const { listArticlesTranslationState } = require('./supabase');

const DEBOUNCE_MS = 2 * 60 * 1000;        // fire 2 min after last edit
const RECONCILE_INTERVAL_MS = 30 * 60 * 1000;
const PENDING_STUCK_MS = 30 * 60 * 1000;  // 'pending' older than this = stuck
const MAX_ATTEMPTS = 3;
const MAX_PER_RUN = 10;
const GAP_BETWEEN_LANGS_MS = 3000;

const timers = new Map();    // articleId -> Timeout
const inFlight = new Set();  // "articleId:lang" queued or running

let chain = Promise.resolve();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Serialize a translation run for the given article/languages. */
function enqueueRun(articleId, langs = SUPPORTED_LANGUAGES, reason = 'queue') {
  const todo = langs.filter((lang) => !inFlight.has(`${articleId}:${lang}`));
  if (todo.length === 0) return chain;

  for (const lang of todo) inFlight.add(`${articleId}:${lang}`);

  chain = chain.then(async () => {
    for (const lang of todo) {
      try {
        await runTranslation(articleId, lang);
        console.log(`[TranslateQueue] Done (${reason}): ${articleId} ${lang}`);
      } catch (err) {
        console.error(`[TranslateQueue] Failed (${reason}): ${articleId} ${lang}:`, err.message);
      } finally {
        inFlight.delete(`${articleId}:${lang}`);
      }
      await sleep(GAP_BETWEEN_LANGS_MS);
    }
  });
  return chain;
}

/**
 * Debounced translation trigger. Every call resets the article's timer;
 * translation fires only after `delayMs` with no further calls.
 */
function queueTranslation(articleId, { delayMs = DEBOUNCE_MS, reason = 'edit' } = {}) {
  if (!articleId) return;

  const existing = timers.get(articleId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    timers.delete(articleId);
    enqueueRun(articleId, SUPPORTED_LANGUAGES, reason);
  }, delayMs);
  // Don't hold the process open just for a pending debounce timer.
  if (typeof timer.unref === 'function') timer.unref();

  timers.set(articleId, timer);
}

/**
 * Decide whether one language of one article needs (re)translation.
 * Exported for tests.
 */
function needsTranslation(t, updatedAtMs, nowMs, maxAttempts = MAX_ATTEMPTS) {
  if (!t) return true; // never translated

  const attempts = t.attempts || 0;
  const editedAfter = (ts) =>
    Boolean(updatedAtMs && ts && updatedAtMs > Date.parse(ts));

  if (t.status === 'complete') {
    // Stale: article edited after the translation was produced.
    return editedAfter(t.translated_at);
  }

  if (t.status === 'pending') {
    // Legacy rows (pre-queued_at) or runs orphaned by a crash/restart.
    const queuedAt = t.queued_at ? Date.parse(t.queued_at) : null;
    if (!queuedAt) return attempts < maxAttempts;
    return nowMs - queuedAt > PENDING_STUCK_MS && attempts < maxAttempts;
  }

  if (t.status === 'failed') {
    if (editedAfter(t.failed_at)) return true; // content changed since failure
    return attempts < maxAttempts;
  }

  return false;
}

/**
 * One reconciler sweep. Returns the jobs it enqueued (for logging/tests).
 */
async function reconcileOnce({ maxPerRun = MAX_PER_RUN, quietMs = DEBOUNCE_MS } = {}) {
  const rows = await listArticlesTranslationState();
  const now = Date.now();
  const jobs = [];

  for (const row of rows) {
    if (jobs.length >= maxPerRun) break;

    const updatedAtMs = row.updated_at ? Date.parse(row.updated_at) : null;
    // Skip articles edited within the quiet window — the debounce owns those.
    if (updatedAtMs && now - updatedAtMs < quietMs) continue;
    // Skip articles with a pending debounce timer.
    if (timers.has(row.article_id)) continue;

    const translations = row.translations || {};
    const langs = SUPPORTED_LANGUAGES.filter(
      (lang) =>
        !inFlight.has(`${row.article_id}:${lang}`) &&
        needsTranslation(translations[lang], updatedAtMs, now)
    );

    if (langs.length > 0) jobs.push({ articleId: row.article_id, langs });
  }

  if (jobs.length > 0) {
    console.log(`[TranslateQueue] Reconciler: ${jobs.length} article(s) need translation`);
    for (const job of jobs) enqueueRun(job.articleId, job.langs, 'reconcile');
  }
  return jobs;
}

let reconcilerStarted = false;

/** Start the periodic reconciler. Idempotent. */
function startReconciler({ intervalMs = RECONCILE_INTERVAL_MS } = {}) {
  if (reconcilerStarted) return;
  reconcilerStarted = true;

  const run = () =>
    reconcileOnce().catch((err) =>
      console.error('[TranslateQueue] Reconciler sweep error:', err.message)
    );

  // First sweep shortly after boot (let the server settle), then periodic.
  const first = setTimeout(run, 60 * 1000);
  const interval = setInterval(run, intervalMs);
  if (typeof first.unref === 'function') first.unref();
  if (typeof interval.unref === 'function') interval.unref();

  console.log(`[TranslateQueue] Reconciler started (every ${Math.round(intervalMs / 60000)} min, max ${MAX_PER_RUN} articles/sweep)`);
}

module.exports = { queueTranslation, startReconciler, reconcileOnce, needsTranslation };
