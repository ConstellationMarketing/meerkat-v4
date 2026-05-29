'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { jsonrepair } = require('jsonrepair');
const { getArticle, updateTranslation } = require('./supabase');
const { publishTranslation } = require('./github-publish');

const client = new Anthropic();

const PROMPT_TEMPLATE = fs.readFileSync(
  path.join(__dirname, '../prompts/translator.md'),
  'utf8'
);

const LANGUAGE_CONFIGS = {
  es: {
    name: 'Spanish',
    standard: 'standard neutral Spanish as understood across all Spanish-speaking communities',
    htmlLang: 'es',
    label: 'Español',
  },
  vi: {
    name: 'Vietnamese',
    standard: 'standard neutral Vietnamese as understood by Vietnamese speakers regardless of regional background',
    htmlLang: 'vi',
    label: 'Tiếng Việt',
  },
};

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

function parsePrompt(template, vars) {
  const filled = fillTemplate(template, vars);
  const systemMatch = filled.match(/^SYSTEM:\s*([\s\S]+?)(?=\nUSER:)/m);
  const userMatch = filled.match(/\nUSER:\s*([\s\S]+)$/m);
  return {
    system: systemMatch ? systemMatch[1].trim() : '',
    user: userMatch ? userMatch[1].trim() : filled,
  };
}

// Legacy format: a single JSON object with the HTML in a "content" string.
// Kept as a fallback so a model response in the old shape still parses.
function parseLegacyJsonResponse(stripped) {
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (firstErr) {
    // Old failure mode: Haiku emits unescaped quotes inside the HTML content
    // string, breaking JSON.parse. jsonrepair fixes some of these.
    try {
      parsed = JSON.parse(jsonrepair(stripped));
      console.log('[Translate] parseTranslationResponse: recovered legacy JSON via jsonrepair');
    } catch (repairErr) {
      throw new Error(`Translator returned invalid JSON (repair also failed): ${firstErr.message}`);
    }
  }
  const { title, meta, slug, content } = parsed;
  if (typeof title !== 'string' || typeof meta !== 'string' || typeof slug !== 'string' || typeof content !== 'string') {
    throw new Error('Translator JSON missing one of: title, meta, slug, content');
  }
  return { title, meta, slug, content };
}

// Current format: a small JSON header (title/meta/slug) followed by the raw
// HTML body between <<<CONTENT>>> / <<<END_CONTENT>>> sentinels. This keeps the
// HTML out of JSON entirely so quotes in attributes (href/class/target/rel)
// never need escaping — the failure mode that broke Vietnamese translations,
// where longer output made Haiku drop an escape and produce unparseable JSON.
function parseTranslationResponse(raw) {
  const stripped = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  const contentMatch = stripped.match(/<<<CONTENT>>>\s*([\s\S]*?)\s*<<<END_CONTENT>>>/);
  if (!contentMatch) {
    // No sentinels — model may have fallen back to the legacy single-JSON shape.
    return parseLegacyJsonResponse(stripped);
  }

  const content = contentMatch[1].trim();
  const headerRaw = stripped.slice(0, stripped.indexOf('<<<CONTENT>>>')).trim();

  let header;
  try {
    header = JSON.parse(headerRaw);
  } catch (firstErr) {
    try {
      header = JSON.parse(jsonrepair(headerRaw));
      console.log('[Translate] parseTranslationResponse: recovered header via jsonrepair');
    } catch (repairErr) {
      throw new Error(`Translator header JSON invalid (repair also failed): ${firstErr.message}`);
    }
  }

  const { title, meta, slug } = header;
  if (typeof title !== 'string' || typeof meta !== 'string' || typeof slug !== 'string') {
    throw new Error('Translator header missing one of: title, meta, slug');
  }
  if (typeof content !== 'string' || !content) {
    throw new Error('Translator content empty between sentinels');
  }
  return { title, meta, slug, content };
}

async function runTranslation(articleId, language) {
  const config = LANGUAGE_CONFIGS[language];
  if (!config) throw new Error(`Unsupported language: ${language}`);

  console.log(`[Translate] Starting: articleId=${articleId} lang=${language}`);

  const article = await getArticle(articleId);
  if (!article) throw new Error(`Article not found: ${articleId}`);

  // Prefer the editor's final version (received_article.content) over the
  // immutable original pipeline draft (cleaned content). Editors restructure
  // articles substantially after generation — adding sections, expanding Why
  // Choose Us / What to Expect, fixing depth — and translations should
  // reflect what readers actually see in English, not the half-baked first
  // draft. Falls back to cleaned content if received_article is missing.
  const sourceContent = article.received_article?.content || article['cleaned content'];
  if (!sourceContent) throw new Error(`No content available to translate for article: ${articleId}`);

  // Same logic for title and meta — prefer the published values that came out
  // of the editor flow.
  const sourceTitle = article.received_article?.title || article.title_tag || '';
  const sourceMeta = article.received_article?.meta || article.meta_description || '';
  const sourceSlug = article['URL Slug'] || '';

  // Mark as pending immediately
  await updateTranslation(articleId, language, {
    status: 'pending',
    translated_at: null,
    title: null,
    meta: null,
    slug: null,
    content: null,
  });

  // Build prompt
  const { system, user } = parsePrompt(PROMPT_TEMPLATE, {
    LANGUAGE: config.name,
    LANGUAGE_STANDARD: config.standard,
    TITLE: sourceTitle,
    META: sourceMeta,
    SLUG: sourceSlug,
    CONTENT: sourceContent,
  });

  // Translate with Claude Haiku — single call, JSON output
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16384,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const translated = parseTranslationResponse(response.content[0].text);
  const translatedAt = new Date().toISOString();

  // Write to Supabase
  await updateTranslation(articleId, language, {
    status: 'complete',
    translated_at: translatedAt,
    title: translated.title,
    meta: translated.meta,
    slug: translated.slug,
    content: translated.content,
  });

  console.log(`[Translate] Supabase updated: articleId=${articleId} lang=${language}`);

  // Publish to GitHub — file path stays on English slug; translated fields get used in the page header
  const slug = article['URL Slug'];
  if (slug && process.env.GITHUB_TOKEN) {
    await publishTranslation({
      articleId,
      language,
      config,
      slug,
      clientName: article.client_name,
      keyword: article.keyword,
      translatedTitle: translated.title,
      translatedHtml: translated.content,
    });
  } else {
    console.log('[Translate] Skipping GitHub publish — no slug or GITHUB_TOKEN');
  }

  console.log(`[Translate] Complete: articleId=${articleId} lang=${language}`);
}

async function getTranslationStatus(articleId, language) {
  const article = await getArticle(articleId);
  if (!article) return { status: 'not_found' };

  const translations = article.translations || {};
  const lang = translations[language];
  if (!lang) return { status: 'none' };

  return { status: lang.status, translated_at: lang.translated_at };
}

module.exports = { runTranslation, getTranslationStatus };
