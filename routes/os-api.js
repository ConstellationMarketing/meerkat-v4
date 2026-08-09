'use strict';

const express = require('express');
const crypto = require('crypto');
const { getActiveBatch } = require('../lib/batch');
const { enrichArticles } = require('../lib/enrich');
const { startOptimizeBatch, createOptimizeJob } = require('../lib/optimize');
const { queueTranslation } = require('../lib/translate-queue');

const router = express.Router();

// Shared-secret gate. Fail closed: an instance without the secret refuses.
router.use((req, res, next) => {
  const secret = process.env.OS_RUN_SECRET;
  if (!secret) return res.status(503).json({ error: 'OS_RUN_SECRET is not configured on this instance' });
  if (req.headers['x-os-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

router.post('/optimize/start', async (req, res) => {
  const { items, userId } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'items must be a non-empty array' });
  }
  const invalid = items.filter((i) => !i.keyword || !i.url || !i.clientName);
  if (invalid.length > 0) {
    return res.status(400).json({ error: `${invalid.length} item(s) missing keyword, url or clientName` });
  }
  try {
    const active = await getActiveBatch();
    if (active) {
      return res.status(409).json({ error: `Batch "${active.batch_id}" is already processing`, activeBatchId: active.batch_id });
    }
    const enriched = await enrichArticles(items.map((i) => ({
      keyword: i.keyword, clientName: i.clientName, template: i.template || 'Practice Page',
    })));
    const merged = items.map((i, n) => ({ ...enriched[n], url: i.url, guidance: i.guidance || '', userId: userId || null }));
    const batchId = `opt-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    await createOptimizeJob(batchId, merged.length, userId || null);
    res.status(202).json({ batchId, total: merged.length });
    startOptimizeBatch(batchId, merged).catch((err) => console.error(`[OS-API] Optimize batch ${batchId} crashed:`, err));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/translate/queue', (req, res) => {
  const { articleId } = req.body || {};
  if (!articleId) return res.status(400).json({ error: 'Missing articleId' });
  queueTranslation(articleId);
  res.status(202).json({ status: 'queued', articleId });
});

module.exports = router;
