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
async function updateTranslation(articleId, language, data) {
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

/**
 * Lightweight listing for the translation reconciler — timestamps and
 * translation state only, no article content (content columns are heavy).
 * @returns {Promise<Array<{article_id: string, updated_at: string|null, translations: object|null}>>}
 */
async function listArticlesTranslationState() {
  const table = process.env.SUPABASE_TABLE || 'article_outlines';
  const client = getClient();

  const { data, error } = await client
    .from(table)
    .select('article_id, updated_at, translations')
    .not('article_id', 'is', null);

  if (error) throw new Error(`Supabase list failed: ${error.message}`);
  return data || [];
}

module.exports = { upsertArticle, getArticle, updateTranslation, listArticlesTranslationState };
