'use strict';

const crypto = require('crypto');

let _client = null;
function getAnthropicClient() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic();
  }
  return _client;
}

let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, { db: { schema: 'meerkat' } });
  }
  return _supabase;
}

const ARTICLE_TABLE = process.env.SUPABASE_TABLE || 'article_outlines';
const BATCH_TABLE = 'batch_jobs';
const DELAY_BETWEEN_ARTICLES_MS = 5000;

async function createOptimizeJob(batchId, total, userId) {
  const { error } = await getSupabase().from(BATCH_TABLE).insert({
    batch_id: batchId,
    status: 'processing',
    total_articles: total,
    completed_count: 0,
    failed_count: 0,
    errors: [],
    created_by: userId,
  });
  if (error) throw new Error(`Failed to create optimize job: ${error.message}`);
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`Page fetch failed: HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Page fetch timed out after 20 seconds');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function classifyWithOcb(url, clientName, keyword) {
  const baseUrl = process.env.OCB_URL || 'http://localhost:3008';
  const normalizeUrl = value => String(value || '').replace(/\/+$/, '');
  try {
    const startRes = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OCB_RUN_SECRET || ''}`,
      },
      body: JSON.stringify({
        urls: [{ url, ...(keyword ? { keyword } : {}) }],
        clientName,
        runBy: 'meerkat-m5',
      }),
    });
    if (!startRes.ok) throw new Error(`OCB classify failed: HTTP ${startRes.status}`);
    const { jobId } = await startRes.json();
    if (!jobId) throw new Error('OCB classify response missing jobId');

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const runRes = await fetch(`${baseUrl}/status/${encodeURIComponent(jobId)}`);
      if (!runRes.ok) throw new Error(`OCB run poll failed: HTTP ${runRes.status}`);
      const run = await runRes.json();
      const status = String(run.status || '').toLowerCase();
      if (['failed', 'error', 'cancelled'].includes(status)) throw new Error(`OCB run ${status}`);
      if (status === 'complete') {
        const candidates = Array.isArray(run.results) ? run.results : [];
        const entry = candidates.find(result => normalizeUrl(result && result.url) === normalizeUrl(url));
        if (!entry) return null;
        return {
          decision: entry.decision ?? entry.path ?? entry.verdict ?? entry.classification ?? null,
          confidence: entry.confidence ?? entry.score ?? entry.probability ?? null,
          reasoning: entry.reasoning ?? entry.rationale ?? entry.reason ?? entry.explanation ?? null,
          raw: entry,
        };
      }
    }
    throw new Error('OCB run timed out after 3 minutes');
  } catch (err) {
    console.warn(`[Optimize] OCB classification unavailable for ${url}: ${err.message}`);
    return null;
  }
}

function parseChangeReport(text) {
  const match = String(text || '').match(/<<<BULLETS>>>\s*([\s\S]*?)\s*<<<END_BULLETS>>>/);
  if (!match) return { bullets: [] };
  const bullets = match[1]
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:[-*]\s+|\d+\.\s+)/, '').trim())
    .filter(Boolean);
  return { bullets };
}

async function buildChangeReport(beforeText, afterHtml, keyword) {
  const prompt = `Keyword: ${keyword}\n\nBEFORE:\n${String(beforeText || '').slice(0, 4000)}\n\nAFTER:\n${htmlToText(afterHtml).slice(0, 4000)}\n\nList 3 to 6 concrete editorial changes made from BEFORE to AFTER, one per line, each specific (what changed, where). Output ONLY the lines between the sentinels.\n\n<<<BULLETS>>>\nline 1\nline 2\n<<<END_BULLETS>>>`;
  const response = await getAnthropicClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseChangeReport(response.content[0].text);
}

async function recordFailure(batchId, articleId, item, errorMsg) {
  const { data: job } = await getSupabase()
    .from(BATCH_TABLE)
    .select('errors, failed_count')
    .eq('batch_id', batchId)
    .single();
  const errors = job?.errors || [];
  errors.push({
    articleId,
    keyword: item.keyword,
    clientName: item.clientName,
    error: errorMsg,
    timestamp: new Date().toISOString(),
  });
  await getSupabase().from(BATCH_TABLE).update({
    errors,
    failed_count: (job?.failed_count || 0) + 1,
  }).eq('batch_id', batchId);
}

async function getCompletedCount(batchId) {
  const { data } = await getSupabase()
    .from(BATCH_TABLE)
    .select('completed_count')
    .eq('batch_id', batchId)
    .single();
  return data?.completed_count || 0;
}

async function startOptimizeBatch(batchId, items) {
  console.log(`[Optimize] Starting batch "${batchId}" with ${items.length} items`);
  await getSupabase().from(BATCH_TABLE).update({ status: 'processing' }).eq('batch_id', batchId);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const articleId = crypto.randomUUID();
    const { data: job } = await getSupabase()
      .from(BATCH_TABLE)
      .select('status')
      .eq('batch_id', batchId)
      .single();
    if (job?.status === 'cancelled') {
      console.log(`[Optimize] Cancelled at item ${i + 1}/${items.length}`);
      break;
    }

    await getSupabase().from(BATCH_TABLE).update({ current_keyword: item.keyword }).eq('batch_id', batchId);
    console.log(`[Optimize] [${i + 1}/${items.length}] Optimizing: "${item.keyword}" (${item.clientName})`);

    let beforeHtml;
    try {
      beforeHtml = await fetchPage(item.url);
    } catch (err) {
      await recordFailure(batchId, articleId, item, err.message);
      continue;
    }

    const ocb = await classifyWithOcb(item.url, item.clientName, item.keyword);
    const seedRow = {
      id: Math.random().toString(36).substring(2, 12),
      article_id: articleId,
      client_name: item.clientName,
      client_id: item.clientId || null,
      keyword: item.keyword,
      template: item.template || null,
      sections: item.sections,
      batch_id: batchId,
      version: `V${require('../package.json').version}`,
      updated_at: new Date().toISOString(),
      job_type: 'optimization',
      page_url: item.url,
      before_html: beforeHtml,
    };
    const { error: seedError } = await getSupabase().from(ARTICLE_TABLE).insert(seedRow);
    if (seedError) {
      await recordFailure(batchId, articleId, item, `Seed failed: ${seedError.message}`);
      continue;
    }

    const beforeText = htmlToText(beforeHtml).slice(0, 8000);
    const payload = {
      articleid: articleId,
      clientId: item.clientId || null,
      clientName: item.clientName,
      clientInfo: item.clientInfo || '',
      website: item.website || '',
      keyword: item.keyword,
      template: item.template || 'Practice Page',
      sections: item.sections,
      userId: item.userId || null,
    };

    try {
      const { runPipeline } = require('../pipeline');
      const result = await runPipeline({
        ...payload,
        optimization: { url: item.url, guidance: item.guidance, beforeText },
      });
      if (result.supabaseError) {
        await recordFailure(batchId, articleId, item, result.supabaseError);
      } else {
        let afterHtml = result.articleRecord && result.articleRecord['cleaned content'];
        if (!afterHtml) {
          const { data: row } = await getSupabase()
            .from(ARTICLE_TABLE)
            .select('cleaned content')
            .eq('article_id', articleId)
            .single();
          afterHtml = row && row['cleaned content'];
        }
        const generatedAt = new Date().toISOString();
        let report;
        try {
          report = await buildChangeReport(beforeText, afterHtml || '', item.keyword);
        } catch (err) {
          console.error(`[Optimize] Change report failed for "${item.keyword}":`, err.message);
          report = { bullets: [] };
        }
        await getSupabase().from(ARTICLE_TABLE).update({
          change_report: { bullets: report.bullets, ocb, generated_at: generatedAt },
        }).eq('article_id', articleId);
        await getSupabase().from(BATCH_TABLE).update({
          completed_count: (await getCompletedCount(batchId)) + 1,
        }).eq('batch_id', batchId);
      }
    } catch (err) {
      await recordFailure(batchId, articleId, item, err.message);
    }

    if (i < items.length - 1) await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ARTICLES_MS));
  }

  const { data: finalJob } = await getSupabase()
    .from(BATCH_TABLE)
    .select('status, completed_count, failed_count, total_articles')
    .eq('batch_id', batchId)
    .single();
  if (finalJob && finalJob.status !== 'cancelled') {
    const finalStatus = finalJob.failed_count === finalJob.total_articles ? 'failed' : 'completed';
    await getSupabase().from(BATCH_TABLE).update({ status: finalStatus, current_keyword: null }).eq('batch_id', batchId);
  }
}

module.exports = {
  createOptimizeJob,
  startOptimizeBatch,
  fetchPage,
  htmlToText,
  classifyWithOcb,
  buildChangeReport,
  parseChangeReport,
};
