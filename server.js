'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { runPipeline } = require('./pipeline');
const { runTranslation, getTranslationStatus } = require('./lib/translate');
const { queueTranslation, startReconciler } = require('./lib/translate-queue');
const { startBatch, cancelBatch, retryFailed, getBatchStatus, getActiveBatch, markOrphanedBatches } = require('./lib/batch');
const frontendApi = require('./routes/frontend-api');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS — allow requests from os.goconstellation.com
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'https://os.goconstellation.com',
    'https://meerkatv3.netlify.app'
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'meerkat-service', table: process.env.SUPABASE_TABLE || 'article_outlines' });
});

// Main generation endpoint — same path the web app will call
app.post('/generate', async (req, res) => {
  const payload = req.body;

  // Validate required fields
  const required = ['articleid', 'clientId', 'keyword', 'sections'];
  const missing = required.filter(f => !payload[f]);
  if (missing.length > 0) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  if (!Array.isArray(payload.sections) || payload.sections.length === 0) {
    return res.status(400).json({ error: 'sections must be a non-empty array' });
  }

  console.log(`\n[Server] POST /generate | articleId=${payload.articleid} | keyword="${payload.keyword}" | sections=${payload.sections.length}`);

  // Respond immediately — generation is async
  res.status(202).json({
    status: 'accepted',
    articleId: payload.articleid,
    message: 'Article generation started. Results will be written to Supabase.'
  });

  // Run pipeline in background
  runPipeline(payload)
    .then(result => {
      console.log(`[Server] Complete: articleId=${result.articleId} | words=${result.wordCount} | flesch=${result.fleschScore} | url=${result.pageUrl}`);
    })
    .catch(err => {
      console.error(`[Server] Pipeline failed for articleId=${payload.articleid}:`, err);
    });
});

// Trigger translation
app.post('/translate', async (req, res) => {
  const { articleId, language } = req.body;

  if (!articleId || !language) {
    return res.status(400).json({ error: 'Missing required fields: articleId, language' });
  }
  if (!['es', 'vi'].includes(language)) {
    return res.status(400).json({ error: 'Unsupported language. Accepted values: es, vi' });
  }

  console.log(`\n[Server] POST /translate | articleId=${articleId} | language=${language}`);

  res.status(202).json({
    status: 'accepted',
    articleId,
    language,
    message: 'Translation started. Poll /translate/status for progress.',
  });

  runTranslation(articleId, language)
    .then(() => console.log(`[Server] Translation complete: articleId=${articleId} lang=${language}`))
    .catch(err => console.error(`[Server] Translation failed: articleId=${articleId} lang=${language}:`, err));
});

// Debounced translation trigger — called by the autosave path on every save.
// Translation (all languages) fires ~30s after the article goes quiet.
app.post('/translate/queue', (req, res) => {
  const { articleId } = req.body;

  if (!articleId) {
    return res.status(400).json({ error: 'Missing required field: articleId' });
  }

  queueTranslation(articleId);
  res.status(202).json({ status: 'queued', articleId });
});

// Poll translation status
app.get('/translate/status', async (req, res) => {
  const { articleId, language } = req.query;

  if (!articleId || !language) {
    return res.status(400).json({ error: 'Missing query params: articleId, language' });
  }

  try {
    const status = await getTranslationStatus(articleId, language);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Batch generation endpoints ───────────────────────────────────────────

// Start a batch run
app.post('/batch/start', async (req, res) => {
  const { articles, userId } = req.body;

  if (!articles || !Array.isArray(articles) || articles.length === 0) {
    return res.status(400).json({ error: 'articles must be a non-empty array' });
  }

  // Validate each article has required fields
  const invalid = articles.filter(a => !a.keyword || !a.clientName);
  if (invalid.length > 0) {
    return res.status(400).json({
      error: `${invalid.length} article(s) missing required fields (keyword, clientName)`,
      invalid: invalid.map(a => ({ keyword: a.keyword, clientName: a.clientName }))
    });
  }

  const batchId = `batch-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`\n[Server] POST /batch/start | batchId=${batchId} | articles=${articles.length}`);

  try {
    // Active-batch lock: refuse to start a new batch while another is running.
    // The batch loop is sequential and runs in this same VPS process; a second
    // concurrent batch would share Anthropic rate limits, race on status
    // updates, and confuse the UI. User must cancel the existing batch first.
    const active = await getActiveBatch();
    if (active) {
      return res.status(409).json({
        error: 'Another batch is already running. Cancel it before starting a new one.',
        activeBatchId: active.batch_id,
        progress: `${active.completed_count || 0}/${active.total_articles || 0}`,
      });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: "meerkat" } });

    // Resolve clientInfo, website, clientId from client_folders. Fetch ALL
    // folders so we can fuzzy-match user-supplied names against the canonical
    // values — punctuation differences ("Robert R Hopkins" vs "Robert R.
    // Hopkins", "Chip Herrington Attorney" vs "Chip Herrington, Attorney")
    // shouldn't block validation. Mirrors the template-alias treatment.
    const uniqueClients = [...new Set(articles.map(a => a.clientName))];
    const { data: folders, error: folderError } = await supabase
      .from('client_folders')
      .select('name, id, website, client_info');

    if (folderError) {
      return res.status(500).json({ error: `Failed to lookup clients: ${folderError.message}` });
    }

    const normalizeClient = (s) => (s || '')
      .toString()
      .toLowerCase()
      .replace(/[.,]/g, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const clientAliasToCanonical = {};
    const clientByCanonical = {};
    (folders || []).forEach(f => {
      const key = normalizeClient(f.name);
      if (key) clientAliasToCanonical[key] = f.name;
      clientByCanonical[f.name] = { clientId: f.id, website: f.website, clientInfo: f.client_info };
    });

    const resolveClient = (raw) => clientAliasToCanonical[normalizeClient(raw)] || null;

    const unresolved = uniqueClients.filter(c => resolveClient(c) === null);
    if (unresolved.length > 0) {
      return res.status(400).json({
        error: `${unresolved.length} client(s) not found in client_folders`,
        unresolved
      });
    }

    // Resolve template sections. Fetch ALL templates so we can fuzzy-match
    // user-supplied values against both `id` and `name` (e.g., spreadsheet
    // entries like "Practice Page" or "Supporting Page" should resolve to
    // their canonical IDs without forcing editors to remember the slug
    // format).
    const { data: templates, error: templateError } = await supabase
      .from('templates')
      .select('id, name, sections');

    if (templateError) {
      return res.status(500).json({ error: `Failed to lookup templates: ${templateError.message}` });
    }

    // Build an alias → canonical-id map. Each template contributes its id and
    // its name (and several normalized variants) so common CSV inputs
    // resolve. Normalization: lowercase, hyphens/underscores → spaces, then
    // collapse whitespace.
    const normalize = (s) => (s || '')
      .toString()
      .toLowerCase()
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const aliasToId = {};
    (templates || []).forEach(t => {
      if (!t.id) return;
      [t.id, t.name].forEach(alias => {
        const key = normalize(alias);
        if (key) aliasToId[key] = t.id;
      });
    });

    const templateMap = {};
    (templates || []).forEach(t => { templateMap[t.id] = t.sections; });

    // Resolve each article's user-supplied template value to its canonical id.
    // Default to practice-page when blank.
    const resolveTemplate = (raw) => {
      const candidate = (raw && raw.trim()) ? raw : 'practice-page';
      return aliasToId[normalize(candidate)] || null;
    };

    // Build the set of unique resolved IDs (or null for unresolved) to surface
    // unresolved values back to the caller before kicking off generation.
    const unresolvedRawValues = [...new Set(
      articles
        .filter(a => resolveTemplate(a.template) === null)
        .map(a => a.template || '(blank)')
    )];
    if (unresolvedRawValues.length > 0) {
      return res.status(400).json({
        error: `${unresolvedRawValues.length} template value(s) not found in Supabase templates table`,
        unresolvedTemplates: unresolvedRawValues,
        hint: 'Use one of the template names or IDs from Settings → Templates. "Practice Page" / "Supporting Page" / "practice-page" / "supporting-page" all resolve.',
      });
    }

    // All resolved — also fail-loud if a resolved id maps to empty sections.
    const resolvedIds = [...new Set(articles.map(a => resolveTemplate(a.template)))];
    const emptySectionIds = resolvedIds.filter(
      id => !templateMap[id] || !Array.isArray(templateMap[id]) || templateMap[id].length === 0
    );
    if (emptySectionIds.length > 0) {
      return res.status(400).json({
        error: `${emptySectionIds.length} template(s) resolved but have no sections`,
        unresolvedTemplates: emptySectionIds,
        hint: 'Edit the template via Settings → Templates and add at least one section.',
      });
    }

    // Enrich each article. Use the canonical client name so downstream
    // storage (article_outlines.client_name, batch_jobs metadata) is
    // consistent regardless of how the user typed it in the CSV.
    const enrichedArticles = articles.map(a => {
      const canonicalName = resolveClient(a.clientName);
      const client = clientByCanonical[canonicalName];
      const templateId = resolveTemplate(a.template);
      const sections = templateMap[templateId] || [];

      return {
        keyword: a.keyword,
        clientName: canonicalName,
        clientId: client.clientId,
        clientInfo: client.clientInfo || '',
        website: client.website || '',
        template: templateId === 'practice-page' ? 'Practice Page' : 'Supporting/Resource Page',
        userId: userId || null,
        sections: sections.map((s, idx) => ({
          sectionNumber: idx + 1,
          name: s.title || s.name || `Section ${idx + 1}`,
          details: s.description || s.details || '',
          wordCount: s.wordCount || null,
        })),
      };
    });

    // Create batch_jobs row
    const { error: insertError } = await supabase.from('batch_jobs').insert({
      batch_id: batchId,
      created_by: userId || null,
      total_articles: enrichedArticles.length,
      csv_data: articles, // store original CSV data for retry
    });

    if (insertError) {
      return res.status(500).json({ error: `Failed to create batch job: ${insertError.message}` });
    }

    // Respond immediately
    res.status(202).json({
      status: 'accepted',
      batchId,
      totalArticles: enrichedArticles.length,
      message: 'Batch generation started. Poll /batch/status for progress.'
    });

    // Fire batch processing in background
    startBatch(batchId, enrichedArticles)
      .then(() => console.log(`[Server] Batch "${batchId}" processing complete`))
      .catch(err => console.error(`[Server] Batch "${batchId}" failed:`, err));

  } catch (err) {
    console.error('[Server] Batch start error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Poll batch status
app.get('/batch/status', async (req, res) => {
  const { batchId } = req.query;
  if (!batchId) return res.status(400).json({ error: 'Missing query param: batchId' });

  try {
    const status = await getBatchStatus(batchId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel a running batch
app.post('/batch/cancel', async (req, res) => {
  const { batchId } = req.body;
  if (!batchId) return res.status(400).json({ error: 'Missing field: batchId' });

  try {
    await cancelBatch(batchId);
    res.json({ status: 'cancelled', batchId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retry failed articles from a batch.
//   body.batchId           — required
//   body.articleKeywords   — optional array of keywords to retry. If present,
//                            only those (intersected with the batch's failed
//                            set) are re-run. If absent, every failed article
//                            in the batch is retried (existing behavior).
app.post('/batch/retry', async (req, res) => {
  const { batchId, articleKeywords } = req.body;
  if (!batchId) return res.status(400).json({ error: 'Missing field: batchId' });
  if (articleKeywords !== undefined && !Array.isArray(articleKeywords)) {
    return res.status(400).json({ error: 'articleKeywords must be an array if provided' });
  }

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: "meerkat" } });
    const { data: job } = await supabase.from('batch_jobs').select('csv_data, errors').eq('batch_id', batchId).single();

    if (!job || !job.errors || job.errors.length === 0) {
      return res.status(400).json({ error: 'No failed articles to retry' });
    }

    // Determine which failed articles to retry. Default = all failed in this
    // batch. If articleKeywords supplied, intersect with the failed set so
    // callers cannot retry a keyword that didn't fail (or doesn't exist).
    const failedKeywords = new Set(job.errors.map(e => e.keyword));
    const requestedKeywords = Array.isArray(articleKeywords) && articleKeywords.length > 0
      ? new Set(articleKeywords)
      : null;
    const targetKeywords = requestedKeywords
      ? new Set([...failedKeywords].filter(k => requestedKeywords.has(k)))
      : failedKeywords;

    if (targetKeywords.size === 0) {
      return res.status(400).json({
        error: 'No matching failed articles for retry',
        hint: requestedKeywords
          ? 'None of the supplied articleKeywords appear in the batch failure set.'
          : 'Batch has no failed articles.',
      });
    }

    const failedArticles = (job.csv_data || []).filter(a => targetKeywords.has(a.keyword));

    // Same fuzzy client + template resolution as /batch/start.
    const { data: folders } = await supabase.from('client_folders').select('name, id, website, client_info');
    const normalizeClient = (s) => (s || '').toString().toLowerCase().replace(/[.,]/g, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const clientAliasToCanonical = {};
    const clientByCanonical = {};
    (folders || []).forEach(f => {
      const key = normalizeClient(f.name);
      if (key) clientAliasToCanonical[key] = f.name;
      clientByCanonical[f.name] = { clientId: f.id, website: f.website, clientInfo: f.client_info };
    });
    const resolveClient = (raw) => clientAliasToCanonical[normalizeClient(raw)] || null;

    const { data: templates } = await supabase.from('templates').select('id, name, sections');
    const normalize = (s) => (s || '').toString().toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
    const aliasToId = {};
    (templates || []).forEach(t => {
      if (!t.id) return;
      [t.id, t.name].forEach(alias => {
        const key = normalize(alias);
        if (key) aliasToId[key] = t.id;
      });
    });
    const templateMap = {};
    (templates || []).forEach(t => { templateMap[t.id] = t.sections; });
    const resolveTemplate = (raw) => {
      const candidate = (raw && raw.trim()) ? raw : 'practice-page';
      return aliasToId[normalize(candidate)] || null;
    };

    const enrichedArticles = failedArticles.map(a => {
      const canonicalName = resolveClient(a.clientName);
      const client = canonicalName ? clientByCanonical[canonicalName] : {};
      const templateId = resolveTemplate(a.template) || 'practice-page';
      const sections = templateMap[templateId] || [];
      return {
        keyword: a.keyword,
        clientName: canonicalName || a.clientName,
        clientId: client.clientId || null,
        clientInfo: client.clientInfo || '',
        website: client.website || '',
        template: templateId === 'practice-page' ? 'Practice Page' : 'Supporting/Resource Page',
        userId: null,
        sections: sections.map((s, idx) => ({
          sectionNumber: idx + 1,
          name: s.title || s.name || `Section ${idx + 1}`,
          details: s.description || s.details || '',
          wordCount: s.wordCount || null,
        })),
      };
    });

    res.status(202).json({
      status: 'retrying',
      batchId,
      retryCount: enrichedArticles.length,
      scope: requestedKeywords ? 'selected' : 'all',
      message: 'Retry started. Poll /batch/status for progress.'
    });

    retryFailed(batchId, enrichedArticles, requestedKeywords ? [...requestedKeywords] : null)
      .then(() => console.log(`[Server] Batch "${batchId}" retry complete`))
      .catch(err => console.error(`[Server] Batch "${batchId}" retry failed:`, err));

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Frontend API routes (ported from Netlify Functions) ──────────────────
app.use('/api', frontendApi);

// Also mount get-article and get-article-revisions at their legacy paths
// so the frontend can call /.netlify/functions/get-article → /get-article
app.use('/.netlify/functions', frontendApi);

// ─── Serve frontend static files ──────────────────────────────────────────
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

// SPA fallback — serve index.html for all non-API routes (client-side routing)
app.get('*', (req, res) => {
  // Don't serve index.html for API or health check routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/generate') ||
      req.path.startsWith('/translate') || req.path.startsWith('/batch') ||
      req.path.startsWith('/.netlify/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Meerkat service running on port ${PORT}`);
  console.log(`Supabase table: ${process.env.SUPABASE_TABLE || 'article_outlines'}`);
  console.log(`Static files: ${publicDir}`);
  // Sweep any orphaned batches left behind by a previous process. The batch
  // loop runs as a background promise inside this process, so any restart
  // (deploy, crash, OOM) abandons in-flight batches in 'processing' status.
  // Mark them as 'orphaned' so the active-batch lock below can let new
  // batches proceed.
  markOrphanedBatches().catch(err => console.error('[Batch] Orphan sweep error:', err));

  // Keep ES/VI translations in sync with article edits. Sweeps for missing,
  // stale, stuck, and failed translations. Disable with TRANSLATE_RECONCILER=0.
  if (process.env.TRANSLATE_RECONCILER !== '0') {
    startReconciler();
  }
});
