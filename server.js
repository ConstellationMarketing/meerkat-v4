'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { runPipeline } = require('./pipeline');
const { runTranslation, getTranslationStatus } = require('./lib/translate');
const { queueTranslation, startReconciler } = require('./lib/translate-queue');
const { cancelBatch, retryFailed, getBatchStatus, getActiveBatch, markOrphanedBatches } = require('./lib/batch');
const { enqueueBatch, pump } = require('./lib/queue');
const { enrichArticles } = require('./lib/enrich');
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
    // The batch loop is sequential and runs in this same VPS process; a second
    // concurrent batch would share Anthropic rate limits, race on status
    // updates, and confuse the UI. So the engine still runs ONE batch at a
    // time — but instead of refusing while busy (a clash once multiple editors
    // launch work), the batch is enqueued and starts automatically in FIFO
    // order. See lib/queue.js.
    const enrichedArticles = (await enrichArticles(articles)).map(article => ({
      ...article,
      userId: userId || null,
    }));

    const { ahead } = await enqueueBatch({
      batchId,
      kind: 'generate',
      payload: enrichedArticles,
      total: enrichedArticles.length,
      userId,
      csvData: articles, // original CSV data kept for /batch/retry
    });

    res.status(202).json({
      status: 'accepted',
      batchId,
      totalArticles: enrichedArticles.length,
      queued: ahead > 0,
      ahead,
      message: ahead > 0
        ? `Queued behind ${ahead} batch${ahead === 1 ? '' : 'es'}. The engine runs one batch at a time and starts this one automatically.`
        : 'Batch generation started. Poll /batch/status for progress.'
    });

  } catch (err) {
    console.error('[Server] Batch start error:', err);
    res.status(err.status || 500).json(err.body || { error: err.message });
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

    // One lane: a retry must not run beside the queue's active batch. The
    // atomic claim inside retryFailed is the backstop; this check exists so
    // the caller hears "busy" instead of a 202 that silently does nothing.
    const active = await getActiveBatch();
    if (active && active.batch_id !== batchId) {
      return res.status(409).json({ error: `The engine is busy with batch "${active.batch_id}" - retry when it finishes.` });
    }

    res.status(202).json({
      status: 'retrying',
      batchId,
      retryCount: enrichedArticles.length,
      scope: requestedKeywords ? 'selected' : 'all',
      message: 'Retry started. Poll /batch/status for progress.'
    });

    retryFailed(batchId, enrichedArticles, requestedKeywords ? [...requestedKeywords] : null)
      .then(() => console.log(`[Server] Batch "${batchId}" retry complete`))
      .catch(err => console.error(`[Server] Batch "${batchId}" retry failed:`, err))
      .finally(() => pump()); // a retry occupies the lane outside the queue — drain queued batches when it ends

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Frontend API routes (ported from Netlify Functions) ──────────────────
app.use('/api', frontendApi);
app.use('/os', require('./routes/os-api'));

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
      req.path.startsWith('/os') ||
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
  markOrphanedBatches()
    .catch(err => console.error('[Batch] Orphan sweep error:', err))
    // Queued batches survive restarts (payload lives in queue_payload) — once
    // the orphan sweep clears the lane, start the oldest queued batch.
    .finally(() => pump());

  // Safety net: pump() is normally event-driven (enqueue, retry completion,
  // startup). If a transient DB error ever drops that chain, a queued batch
  // would sit until the next event; this timer bounds the wait.
  setInterval(() => pump(), 5 * 60 * 1000).unref();

  // Keep ES/VI translations in sync with article edits. Sweeps for missing,
  // stale, stuck, and failed translations. Disable with TRANSLATE_RECONCILER=0.
  if (process.env.TRANSLATE_RECONCILER !== '0') {
    startReconciler();
  }
});
