#!/usr/bin/env node
/**
 * Backfill translations: trigger ES + VI for every article that is missing
 * a translation, has a stale one (article edited after last translation),
 * or has a failed/stuck run.
 *
 * Companion to the July 2026 auto-translation work — the VPS reconciler
 * drains gaps gradually (max 10 articles per 30-min sweep); this script is
 * the fast lane for the initial backfill of the whole catalog.
 *
 * Usage:
 *   node scripts/translate-missing.js                 # dry run — list what would run
 *   node scripts/translate-missing.js --commit        # actually fire the calls
 *   node scripts/translate-missing.js --commit --delay 8   # seconds between calls (default 5)
 *   node scripts/translate-missing.js --commit --limit 20  # cap number of triggers
 *
 * Env: SUPABASE_URL, SUPABASE_KEY (service role) for the listing query.
 *      TRANSLATE_API_URL to override the API base.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TRANSLATE_API = process.env.TRANSLATE_API_URL || 'https://meerkat-api.goconstellation.com';
const LANGS = ['es', 'vi'];

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  db: { schema: 'meerkat' },
});

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const delayIdx = args.indexOf('--delay');
const delaySeconds = delayIdx > -1 ? parseInt(args[delayIdx + 1], 10) || 5 : 5;
const limitIdx = args.indexOf('--limit');
const limit = limitIdx > -1 ? parseInt(args[limitIdx + 1], 10) || Infinity : Infinity;

// Mirrors lib/translate-queue.js needsTranslation, minus the in-process state.
function needsTranslation(t, updatedAtMs) {
  if (!t) return { needed: true, why: 'missing' };
  const editedAfter = (ts) => Boolean(updatedAtMs && ts && updatedAtMs > Date.parse(ts));

  if (t.status === 'complete') {
    return editedAfter(t.translated_at)
      ? { needed: true, why: 'stale (edited after translation)' }
      : { needed: false };
  }
  if (t.status === 'pending') return { needed: true, why: 'stuck pending' };
  if (t.status === 'failed') return { needed: true, why: `failed (${t.attempts || '?'} attempts)` };
  return { needed: true, why: `unknown status: ${t.status}` };
}

async function listJobs() {
  const { data, error } = await supabase
    .from('article_outlines')
    .select('article_id, keyword, client_name, updated_at, translations')
    .not('article_id', 'is', null);
  if (error) throw new Error(`Failed to list articles: ${error.message}`);

  const jobs = [];
  for (const row of data || []) {
    const updatedAtMs = row.updated_at ? Date.parse(row.updated_at) : null;
    const translations = row.translations || {};
    for (const lang of LANGS) {
      const check = needsTranslation(translations[lang], updatedAtMs);
      if (check.needed) {
        jobs.push({
          articleId: row.article_id,
          keyword: row.keyword,
          clientName: row.client_name,
          language: lang,
          why: check.why,
        });
      }
    }
  }
  return jobs;
}

async function triggerTranslate(articleId, language) {
  const res = await fetch(`${TRANSLATE_API}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId, language }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

(async () => {
  console.log(`[Backfill] Mode: ${commit ? 'COMMIT' : 'DRY RUN'} | Delay: ${delaySeconds}s | Limit: ${limit === Infinity ? 'none' : limit}`);
  console.log(`[Backfill] Scanning all articles for missing/stale/failed translations...`);

  let jobs = await listJobs();
  console.log(`[Backfill] Found ${jobs.length} translation(s) needed`);
  if (jobs.length > limit) {
    jobs = jobs.slice(0, limit);
    console.log(`[Backfill] Capped to first ${limit}`);
  }
  console.log();
  jobs.forEach((j, i) => {
    console.log(`  [${i + 1}/${jobs.length}] ${j.language.padEnd(2)} | ${j.articleId} | ${(j.keyword || '').slice(0, 50).padEnd(50)} | ${(j.clientName || '?').slice(0, 20).padEnd(20)} | ${j.why}`);
  });

  if (!commit) {
    console.log();
    console.log(`[Backfill] Dry run — no calls made. Re-run with --commit to actually trigger.`);
    return;
  }

  console.log();
  console.log(`[Backfill] Firing /translate calls sequentially...`);
  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    process.stdout.write(`  [${i + 1}/${jobs.length}] ${j.language} ${j.articleId} ${(j.keyword || '').slice(0, 50)}... `);
    try {
      await triggerTranslate(j.articleId, j.language);
      console.log('triggered');
      succeeded++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
    if (i < jobs.length - 1) {
      await new Promise((r) => setTimeout(r, delaySeconds * 1000));
    }
  }

  console.log();
  console.log(`[Backfill] Done. Triggered: ${succeeded}, failed: ${failed}.`);
  console.log(`[Backfill] Calls return 202 immediately; translations run async on the VPS.`);
  console.log(`[Backfill] Verify with a re-run (dry run) — the needed list should shrink to zero.`);
})();
