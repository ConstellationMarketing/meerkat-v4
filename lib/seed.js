'use strict';

// Seeding the article row is the one write every batch item needs before any
// work starts. On 2026-09-28 Supabase answered 520/525 for a few minutes in the
// middle of Batch #66: eight October optimizations were never saved, six of
// them could not even record that they failed, and the batch still reported
// completed. The insert is now retried with backoff. A retry first checks
// whether the earlier attempt actually landed (a 5xx can arrive after the row
// was written), so a retry never creates a second row for the same article.

const SEED_BACKOFF_MS = [2000, 5000, 15000];
const SEED_ATTEMPTS = SEED_BACKOFF_MS.length + 1;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A Cloudflare error page arrives as the whole HTML document in error.message.
// Keep its <title> ("supabase.co | 520: Web server is returning an unknown
// error") instead of 2 KB of markup on the batch record.
function shortError(error) {
  const message = String((error && error.message) || error || '').trim();
  const title = /<title>([^<]*)<\/title>/i.exec(message);
  if (title) return title[1].replace(/\s+/g, ' ').trim();
  return message.replace(/\s+/g, ' ').slice(0, 300);
}

// A 4xx is the request's own fault (a constraint, a bad column) and will fail
// the same way again. Everything else, including an HTML error page with no
// status, is treated as the database not answering.
function isRetryable(status) {
  return !(status >= 400 && status < 500);
}

async function seedArticleRow(supabase, table, row, { sleep = defaultSleep, log = console } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await sleep(SEED_BACKOFF_MS[attempt - 2]);
      const { data, error } = await supabase.from(table).select('id').eq('article_id', row.article_id).limit(1);
      if (!error && Array.isArray(data) && data.length) return { error: null, attempts: attempt };
    }
    const { error, status } = await supabase.from(table).insert(row);
    if (!error) return { error: null, attempts: attempt };
    lastError = error;
    log.warn(`[Seed] Attempt ${attempt}/${SEED_ATTEMPTS} failed for "${row.keyword}": ${shortError(error)}`);
    if (!isRetryable(status)) break;
  }
  return { error: lastError, message: shortError(lastError) };
}

module.exports = { seedArticleRow, shortError, SEED_ATTEMPTS, SEED_BACKOFF_MS };
