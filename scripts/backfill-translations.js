'use strict';

/**
 * Backfill ES + VI translations for existing articles.
 *
 * For every article in meerkat.article_outlines, generate any missing
 * translation (status !== "complete") so all articles have Spanish and
 * Vietnamese ready without an editor clicking "Translate".
 *
 * Translates the CURRENT content (received_article.content, falling back to
 * "cleaned content"), so it reflects the latest editor version.
 *
 * Usage (run on the VPS where .env + ANTHROPIC_API_KEY live):
 *   node scripts/backfill-translations.js --dry-run   # list what would run
 *   node scripts/backfill-translations.js --commit    # actually translate
 *
 * Notes:
 *   - Runs sequentially to avoid hammering the model API.
 *   - runTranslation also publishes the translation to GitHub if GITHUB_TOKEN
 *     is set (same behavior as the in-app Translate button).
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { runTranslation } = require('../lib/translate');

const LANGS = ['es', 'vi'];
const COMMIT = process.argv.includes('--commit');

function db() {
  const url =
    process.env.VITE_SUPABASE_URL || 'https://cwligyakhxevopxiksdm.supabase.co';
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY is not set in the environment');
  return createClient(url, key, { db: { schema: 'meerkat' } });
}

async function main() {
  const supabase = db();
  const { data, error } = await supabase
    .from('article_outlines')
    .select('article_id, keyword, translations');
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);

  const tasks = [];
  for (const row of data || []) {
    const tr = row.translations || {};
    for (const lang of LANGS) {
      if (tr[lang] && tr[lang].status === 'complete') continue;
      tasks.push({ articleId: row.article_id, keyword: row.keyword, lang });
    }
  }

  console.log(
    `Scanned ${data ? data.length : 0} articles — ${tasks.length} missing translations.`,
  );
  for (const t of tasks) {
    console.log(`  - ${t.lang.toUpperCase()}  ${t.keyword || '(no keyword)'}  ${t.articleId}`);
  }

  if (!COMMIT) {
    console.log('\nDRY RUN — nothing generated. Re-run with --commit to execute.');
    return;
  }

  let ok = 0;
  let fail = 0;
  for (const t of tasks) {
    try {
      console.log(`Translating ${t.articleId} -> ${t.lang} ...`);
      await runTranslation(t.articleId, t.lang);
      ok++;
    } catch (e) {
      console.error(`  FAILED ${t.articleId} ${t.lang}: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} succeeded, ${fail} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
