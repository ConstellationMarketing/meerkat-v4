'use strict';

// Unit tests for lib/seed.js: a batch item's article row survives a short
// Supabase outage (Batch #66, 2026-09-28: 520/525 for a few minutes lost eight
// October optimizations), and a retry never writes the row twice.
//
// Run: node test-seed-retry.js

const assert = require('assert');
const { seedArticleRow, shortError, SEED_ATTEMPTS } = require('./lib/seed');

const CF_520 = '<!DOCTYPE html>\n<html><head><title>supabase.co | 520: Web server is returning an unknown error</title></head><body>...</body></html>';

// A fake client: `inserts` scripts each insert's answer; `landed` says whether
// the row is already there when a retry looks for it.
function fakeSupabase({ inserts, landed = () => false }) {
  const calls = { insert: 0, select: 0 };
  return {
    calls,
    from() {
      return {
        insert: async () => inserts[calls.insert++] || { error: null, status: 201 },
        select: () => ({ eq: () => ({ limit: async () => ({ data: landed(calls) ? [{ id: 'x' }] : [], error: null }) }) }),
      };
    },
  };
}

const quiet = { warn() {} };
const noSleep = async () => {};
const row = { article_id: 'a-1', keyword: 'Federal Criminal Defense Lawyers' };

let passed = 0;
async function t(name, fn) {
  await fn();
  console.log(`  ✓ ${name}`);
  passed++;
}

(async () => {
  console.log('seedArticleRow:');

  await t('first try succeeds with one insert', async () => {
    const sb = fakeSupabase({ inserts: [{ error: null, status: 201 }] });
    const out = await seedArticleRow(sb, 't', row, { sleep: noSleep, log: quiet });
    assert.strictEqual(out.error, null);
    assert.strictEqual(sb.calls.insert, 1);
  });

  await t('a 520 then success is retried and saved', async () => {
    const sb = fakeSupabase({ inserts: [{ error: { message: CF_520 }, status: 520 }, { error: null, status: 201 }] });
    const out = await seedArticleRow(sb, 't', row, { sleep: noSleep, log: quiet });
    assert.strictEqual(out.error, null);
    assert.strictEqual(sb.calls.insert, 2);
  });

  await t('an HTML error page with no status is retried', async () => {
    const sb = fakeSupabase({ inserts: [{ error: { message: CF_520 } }, { error: null, status: 201 }] });
    const out = await seedArticleRow(sb, 't', row, { sleep: noSleep, log: quiet });
    assert.strictEqual(out.error, null);
  });

  await t('a failed answer whose row did land is not inserted again', async () => {
    const sb = fakeSupabase({ inserts: [{ error: { message: CF_520 }, status: 520 }], landed: () => true });
    const out = await seedArticleRow(sb, 't', row, { sleep: noSleep, log: quiet });
    assert.strictEqual(out.error, null);
    assert.strictEqual(sb.calls.insert, 1);
  });

  await t('a 4xx is not retried', async () => {
    const sb = fakeSupabase({ inserts: [{ error: { message: 'null value in column "client_name"' }, status: 400 }] });
    const out = await seedArticleRow(sb, 't', row, { sleep: noSleep, log: quiet });
    assert.ok(out.error);
    assert.strictEqual(sb.calls.insert, 1);
    assert.strictEqual(out.message, 'null value in column "client_name"');
  });

  await t('a lasting outage gives up after every attempt with a short message', async () => {
    const down = { error: { message: CF_520 }, status: 520 };
    const sb = fakeSupabase({ inserts: Array(SEED_ATTEMPTS).fill(down) });
    const waits = [];
    const out = await seedArticleRow(sb, 't', row, { sleep: async (ms) => waits.push(ms), log: quiet });
    assert.ok(out.error);
    assert.strictEqual(sb.calls.insert, SEED_ATTEMPTS);
    assert.strictEqual(waits.length, SEED_ATTEMPTS - 1);
    assert.strictEqual(out.message, 'supabase.co | 520: Web server is returning an unknown error');
  });

  console.log('shortError:');
  await t('keeps a plain message', async () => {
    assert.strictEqual(shortError({ message: '  duplicate key  ' }), 'duplicate key');
  });

  console.log(`\n${passed} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
