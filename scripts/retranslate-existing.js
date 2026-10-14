#!/usr/bin/env node
/**
 * Re-trigger translation for every article that already has a translation.
 *
 * Triggered by the 2026-04-30 finding that translations were generated
 * against `cleaned content` (immutable pipeline draft) instead of
 * `received_article.content` (editor's final version). After PR #49
 * lands and deploys, run this once to redo every existing translation
 * against the correct source.
 *
 * Usage:
 *   node scripts/retranslate-existing.js                # dry run — list what would run
 *   node scripts/retranslate-existing.js --commit       # actually fire the calls
 *   node scripts/retranslate-existing.js --commit --delay 8   # custom delay between calls (seconds)
 *
 * Default delay between articles is 5s — gives the VPS time to finish each
 * Haiku call before kicking off the next, keeping load predictable.
 *
 * Env: SUPABASE_URL, SUPABASE_KEY (service role) for the listing query.
 */
'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TRANSLATE_API = process.env.TRANSLATE_API_URL || 'https://meerkat-api.goconstellation.com';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const delayIdx = args.indexOf('--delay');
const delaySeconds = delayIdx > -1 ? parseInt(args[delayIdx + 1], 10) || 5 : 5;

async function listExistingTranslations() {
  const { data, error } = await supabase
    .from('article_outlines')
    .select('article_id, keyword, client_name, translations')
    .not('translations', 'is', null);
  if (error) throw new Error(`Failed to list translations: ${error.message}`);

  const jobs = [];
  for (const row of data || []) {
    const t = row.translations || {};
    for (const [lang, info] of Object.entries(t)) {
      if (info && info.status === 'complete') {
        jobs.push({
          articleId: row.article_id,
          keyword: row.keyword,
          clientName: row.client_name,
          language: lang,
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
  console.log(`[Retranslate] Mode: ${commit ? 'COMMIT' : 'DRY RUN'} | Delay: ${delaySeconds}s between calls`);
  console.log(`[Retranslate] Listing existing translations...`);

  const jobs = await listExistingTranslations();
  console.log(`[Retranslate] Found ${jobs.length} translation(s) to re-run`);
  console.log();
  jobs.forEach((j, i) => {
    console.log(`  [${i + 1}/${jobs.length}] ${j.language.padEnd(2)} | ${j.articleId} | ${(j.keyword || '').slice(0, 60)} | ${j.clientName || '?'}`);
  });

  if (!commit) {
    console.log();
    console.log(`[Retranslate] Dry run — no calls made. Re-run with --commit to actually trigger.`);
    return;
  }

  console.log();
  console.log(`[Retranslate] Firing /translate calls sequentially...`);
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
      await new Promise(r => setTimeout(r, delaySeconds * 1000));
    }
  }

  console.log();
  console.log(`[Retranslate] Done. Triggered: ${succeeded}, failed: ${failed}.`);
  console.log(`[Retranslate] Each call returns immediately; actual translation happens async on the VPS.`);
  console.log(`[Retranslate] Verify by polling Supabase translations.translated_at — newer timestamps mean fresh translation completed.`);
})();
