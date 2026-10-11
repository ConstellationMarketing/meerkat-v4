'use strict';

// Unit tests for the October 2026 translation fixes:
//  - responseText refuses a reply cut off at the output limit (it used to
//    surface as "Translator returned invalid JSON ... line 2 column 1")
//  - listArticlesTranslationState pages past 1,000 rows and selects only the
//    translation state, never the translated HTML
//
// Run: node test-translate-state.js

const assert = require('assert');
const { responseText } = require('./lib/translate');
const { listArticlesTranslationState, translationStateRow } = require('./lib/supabase');
const { needsTranslation } = require('./lib/translate-queue');

let failed = 0;
async function check(name, fn) {
  try { await fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); failed++; }
}

// A fake supabase-js query builder that serves `total` rows in pages.
function fakeClient(total, seen) {
  return {
    from() {
      const q = {
        select(cols) { seen.cols = cols; return q; },
        not() { return q; },
        order() { return q; },
        range(from, to) {
          seen.ranges.push([from, to]);
          const data = [];
          for (let i = from; i <= Math.min(to, total - 1); i++) {
            data.push({ article_id: `a${String(i).padStart(5, '0')}`, updated_at: '2026-09-08T14:29:35Z', es_status: 'failed', es_attempts: '1', es_failed_at: '2026-09-08T14:30:21Z', vi_status: null });
          }
          return Promise.resolve({ data, error: null });
        },
      };
      return q;
    },
  };
}

(async () => {
  await check('responseText returns the text of a complete reply', () => {
    const text = responseText({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'def' }] });
    assert.strictEqual(text, 'abcdef');
  });

  await check('responseText refuses a reply cut off at max_tokens', () => {
    assert.throws(
      () => responseText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"title":"t"}\n<<<CONTENT>>>\n<p>half' }] }),
      /cut off at the 64000-token output limit/,
    );
  });

  await check('responseText refuses an empty reply', () => {
    assert.throws(() => responseText({ stop_reason: 'end_turn', content: [] }), /empty reply/);
  });

  await check('listing pages past 1,000 rows', async () => {
    const seen = { ranges: [] };
    const rows = await listArticlesTranslationState({ client: fakeClient(2350, seen) });
    assert.strictEqual(rows.length, 2350);
    assert.deepStrictEqual(seen.ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  });

  await check('listing stops after an exactly full last page', async () => {
    const seen = { ranges: [] };
    const rows = await listArticlesTranslationState({ client: fakeClient(2000, seen) });
    assert.strictEqual(rows.length, 2000);
    assert.deepStrictEqual(seen.ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  });

  await check('listing selects JSON paths, never the translated content', async () => {
    const seen = { ranges: [] };
    await listArticlesTranslationState({ client: fakeClient(1, seen) });
    assert.ok(seen.cols.includes('es_status:translations->es->>status'));
    assert.ok(seen.cols.includes('vi_failed_at:translations->vi->>failed_at'));
    assert.ok(!/content/.test(seen.cols), 'no content column');
    assert.ok(!/(^|,)translations(,|$)/.test(seen.cols), 'no whole translations column');
  });

  await check('row rebuilds the translations shape (attempts numeric, missing language absent)', () => {
    const row = translationStateRow({ article_id: 'x', updated_at: 'u', es_status: 'failed', es_attempts: '1', es_failed_at: 'f', es_translated_at: null, vi_status: null, vi_attempts: null });
    assert.deepStrictEqual(row, { article_id: 'x', updated_at: 'u', translations: { es: { status: 'failed', attempts: 1, failed_at: 'f' } } });
  });

  await check('a September failure at 1 attempt is picked up by the reconciler', () => {
    const row = translationStateRow({ article_id: 'kzl5gaw78j', updated_at: '2026-09-06T19:15:29.951+00:00', es_status: 'failed', es_attempts: '1', es_failed_at: '2026-09-06T19:17:02.864Z' });
    assert.strictEqual(needsTranslation(row.translations.es, Date.parse(row.updated_at), Date.parse('2026-10-11T00:00:00Z')), true);
    assert.strictEqual(needsTranslation(row.translations.vi, Date.parse(row.updated_at), Date.parse('2026-10-11T00:00:00Z')), true);
  });

  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})();
