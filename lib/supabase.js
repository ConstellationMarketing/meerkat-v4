'use strict';

const { createClient } = require('@supabase/supabase-js');

let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY,
      { db: { schema: 'meerkat' } }
    );
  }
  return _client;
}

/**
 * Upsert article data to Supabase.
 * @param {object} articleData
 * @returns {Promise<object>}
 */
async function upsertArticle(articleData) {
  const table = process.env.SUPABASE_TABLE || 'article_outlines';
  const client = getClient();

  const { data, error } = await client
    .from(table)
    .upsert(articleData, { onConflict: 'article_id' });

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}`);
  }

  return data;
}

/**
 * Fetch a single article by article_id.
 * @param {string} articleId
 * @returns {Promise<object|null>}
 */
async function getArticle(articleId) {
  const table = process.env.SUPABASE_TABLE || 'article_outlines';
  const client = getClient();

  const { data, error } = await client
    .from(table)
    .select('*')
    .eq('article_id', articleId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null; // not found
    throw new Error(`Supabase fetch failed: ${error.message}`);
  }

  return data;
}

/**
 * Merge translation data into the translations JSONB column for a given article.
 * @param {string} articleId
 * @param {string} language  e.g. 'es' | 'vi'
 * @param {object} data      { status, translated_at, content }
 */
// ES and VI translate concurrently for the same article, and this write is a
// read-merge-write of one shared JSONB column - interleaved, the later write
// silently drops the other language's freshly saved result (review finding,
// 2026-08-29). All translation writes happen in this process (the translate
// queue's pump), so a per-article promise chain serializes them.
// ponytail: in-process mutex; a second writer process would need an atomic
// jsonb || merge in SQL instead.
const translationWriteLocks = new Map();
async function updateTranslation(articleId, language, data) {
  const prev = translationWriteLocks.get(articleId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => doUpdateTranslation(articleId, language, data));
  translationWriteLocks.set(articleId, run);
  try {
    return await run;
  } finally {
    if (translationWriteLocks.get(articleId) === run) translationWriteLocks.delete(articleId);
  }
}

async function doUpdateTranslation(articleId, language, data) {
  const table = process.env.SUPABASE_TABLE || 'article_outlines';
  const client = getClient();

  // Fetch current translations value
  const { data: existing, error: fetchError } = await client
    .from(table)
    .select('translations')
    .eq('article_id', articleId)
    .single();

  if (fetchError) throw new Error(`Supabase fetch failed: ${fetchError.message}`);

  const translations = existing?.translations || {};
  translations[language] = data;

  const { error } = await client
    .from(table)
    .update({ translations })
    .eq('article_id', articleId);

  if (error) throw new Error(`Supabase translation update failed: ${error.message}`);
}

// Translation fields the reconciler reads. Selecting the whole `translations`
// column pulled every translated HTML body for every article, so the sweep
// grew with the table; these JSON paths keep it to a few bytes per article.
const TRANSLATION_STATE_FIELDS = ['status', 'attempts', 'translated_at', 'failed_at', 'queued_at'];
const TRANSLATION_STATE_LANGS = ['es', 'vi'];
const TRANSLATION_STATE_PAGE = 1000; // PostgREST's default max rows per request

const translationStateColumns = () => [
  'article_id',
  'updated_at',
  ...TRANSLATION_STATE_LANGS.flatMap((lang) =>
    TRANSLATION_STATE_FIELDS.map((field) => `${lang}_${field}:translations->${lang}->>${field}`)),
].join(',');

// Rebuild the `translations` shape needsTranslation() expects from the
// flattened JSON-path columns. A language with no status was never translated.
function translationStateRow(row) {
  const translations = {};
  for (const lang of TRANSLATION_STATE_LANGS) {
    if (row[`${lang}_status`] == null) continue;
    const t = {};
    for (const field of TRANSLATION_STATE_FIELDS) {
      const value = row[`${lang}_${field}`];
      if (value == null) continue;
      t[field] = field === 'attempts' ? Number(value) || 0 : value;
    }
    translations[lang] = t;
  }
  return { article_id: row.article_id, updated_at: row.updated_at, translations };
}

/**
 * Lightweight listing for the translation reconciler — timestamps and
 * translation state only, no article content (content columns are heavy).
 * Paged, so articles past the first 1,000 rows are still swept.
 * @returns {Promise<Array<{article_id: string, updated_at: string|null, translations: object}>>}
 */
async function listArticlesTranslationState({ client = getClient(), pageSize = TRANSLATION_STATE_PAGE } = {}) {
  const table = process.env.SUPABASE_TABLE || 'article_outlines';
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(table)
      .select(translationStateColumns())
      .not('article_id', 'is', null)
      .order('article_id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Supabase list failed: ${error.message}`);
    const page = data || [];
    rows.push(...page.map(translationStateRow));
    if (page.length < pageSize) return rows;
  }
}

module.exports = { upsertArticle, getArticle, updateTranslation, listArticlesTranslationState, translationStateRow };
