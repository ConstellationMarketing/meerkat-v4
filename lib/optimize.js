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
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_match, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Like htmlToText, but keeps block boundaries as newlines and list items as
// "- " bullets so the section editor can see the original's real structure
// (paragraph breaks, existing lists) instead of one flattened line.
function htmlToBlockText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => {
      const anchor = htmlToText(label);
      return anchor ? `[${anchor}](${href})` : '';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|h1|h2|h3|h4|h5|ul|ol|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// Parse the live page into its actual content structure so the rewrite can
// edit sections in place instead of composing a fresh article from the house
// template. Jacqueline's dangerlaw before/after pair (2026-08-10) is the
// standard: an optimization keeps the H1, the section architecture, and the
// substance — it must be recognizably the same page, improved.
const JUNK_HEADING = /related (posts|articles|pages)|recent (posts|articles)|^(categories|archives|search|sidebar|newsletter)$|leave a (comment|reply)|share this|follow us|post navigation|as featured|as seen (in|on)|office locations|our locations/i;
// Hero-widget button labels and standalone all-caps chrome that land between
// the H1 and the first H2 on themed pages — not page content.
const BUTTON_LINE = /^(get in touch|contact us|call (now|today|us)|learn more|read more|book (now|online)|schedule|get started|free consultation)\b/i;
const FAQ_HEADING = /faq|frequently asked|common questions/i;
const CTA_HEADING = /contact|call (us|now|today)|speak (with|to)|talk to|get started|schedule|free consultation|reach out/i;

function cleanIntroText(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const words = line.trim().split(/\s+/).filter(Boolean);
      if (!words.length) return false;
      if (words.length > 6) return true;
      const isAllCaps = /^[^a-z]+$/.test(line) && /[A-Z]/.test(line);
      return !isAllCaps && !BUTTON_LINE.test(line.trim());
    })
    .join('\n');
}

function extractPageSections(html) {
  let region = String(html || '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = region.match(/<main\b[\s\S]*?<\/main>/i) || region.match(/<article\b[\s\S]*?<\/article>/i);
  if (main) region = main[0];
  region = region
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ');

  const h1Match = region.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1Match ? htmlToText(h1Match[1]) : null;
  // Anything before the H1 is theme chrome (breadcrumbs, hero widgets) —
  // the page's own content starts after it.
  const body = h1Match ? region.slice(region.indexOf(h1Match[0]) + h1Match[0].length) : region;

  const countWords = (text) => (text ? text.split(/\s+/).filter(Boolean).length : 0);
  const parts = body.split(/<h2\b[^>]*>/i);
  const introText = cleanIntroText(htmlToBlockText(parts[0]));
  const sections = [];
  for (let i = 1; i < parts.length; i++) {
    const closeIdx = parts[i].search(/<\/h2>/i);
    if (closeIdx === -1) continue;
    const heading = htmlToText(parts[i].slice(0, closeIdx));
    const text = htmlToBlockText(parts[i].slice(closeIdx + 5));
    const words = countWords(text);
    if (!heading || JUNK_HEADING.test(heading)) continue;
    // A heading with almost no body is a theme widget, not a content section.
    if (words < 10) continue;
    sections.push({ heading, text, words });
  }

  const last = sections[sections.length - 1];
  const hasFaq = sections.some(s => FAQ_HEADING.test(s.heading));
  const hasCta = sections.some(s => CTA_HEADING.test(s.heading))
    || Boolean(last && /contact|consultation|call/i.test(last.text.slice(-400)));
  const introWords = countWords(introText);
  return {
    h1,
    intro: { text: introText, words: introWords },
    sections,
    hasFaq,
    hasCta,
    totalWords: introWords + sections.reduce((n, s) => n + s.words, 0),
  };
}

// Map the parsed page onto pipeline section jobs. Every real section becomes
// an edit-in-place job sized to its current length; CTA and FAQ are appended
// as compose jobs (reusing the house template's brief when one exists) only
// when the page lacks them — the same two additions the human optimization
// example made.
function buildEditSections(parsed, templateSections) {
  const fromTemplate = (re) => (templateSections || []).find(s => re.test(String(s.name || '')));
  const jobs = [{
    name: 'Page opening',
    details: 'Edit the existing page opening in place. Keep the H1. Refresh the tagline if one exists, and make sure a short introduction follows.',
    wordCount: Math.max(parsed.intro.words, 60),
    originalText: [parsed.h1 ? `# ${parsed.h1}` : '', parsed.intro.text].filter(Boolean).join('\n'),
    mode: 'edit',
  }];
  for (const s of parsed.sections) {
    jobs.push({
      name: s.heading,
      details: '',
      wordCount: Math.max(s.words, 40),
      originalText: `## ${s.heading}\n${s.text}`,
      mode: 'edit',
    });
  }
  if (!parsed.hasCta) {
    const t = fromTemplate(/cta|call to action/i);
    jobs.push({
      name: (t && t.name) || 'CTA',
      details: (t && t.details) || 'Write a short call to action inviting the reader to contact the firm about this topic.',
      wordCount: (t && t.wordCount) || 80,
      mode: 'add',
    });
  }
  if (!parsed.hasFaq) {
    const t = fromTemplate(/faq|frequently asked/i);
    jobs.push({
      name: (t && t.name) || 'FAQ',
      details: (t && t.details) || 'Write a FAQ of up to 5 questions derived only from topics the page already covers.',
      wordCount: (t && t.wordCount) || 250,
      mode: 'add',
    });
  }

  const targetTotal = 1250;
  let deficit = targetTotal - jobs.reduce((total, job) => total + job.wordCount, 0);
  const substantive = jobs.filter(job => job.mode === 'edit' && job.name !== 'Page opening');
  const expandable = substantive.length ? substantive : jobs.filter(job => job.mode === 'edit');
  const weight = expandable.reduce((total, job) => total + job.wordCount, 0);
  expandable.forEach((job, index) => {
    if (deficit <= 0) return;
    const extra = index === expandable.length - 1
      ? deficit
      : Math.floor((targetTotal - jobs.reduce((total, item) => total + item.wordCount, 0)) * job.wordCount / weight);
    job.wordCount += extra;
    deficit -= extra;
  });

  return jobs.map((job, idx) => ({ ...job, sectionNumber: idx + 1 }));
}

function minimumWordCount(target, editMode = false) {
  const requested = Number(target) || 0;
  const minimum = Math.round(requested * (editMode ? 0.8 : 0.5));
  return editMode ? Math.max(1000, minimum) : minimum;
}

// Generators routinely re-typeset ’ as ', – as -, and … as "..." while leaving
// the wording untouched. Compare on ASCII punctuation so typography alone never
// reads as lost content.
function normalizePreservedText(value) {
  return htmlToText(value)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePreservedUrl(value) {
  return String(value || '').replace(/&amp;/gi, '&').trim();
}

function extractAnchors(html) {
  return [...String(html || '').matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(match => ({
      anchor: normalizePreservedText(match[4]),
      href: normalizePreservedUrl(match[1] ?? match[2] ?? match[3]),
    }));
}

function contentRegion(html) {
  let region = String(html || '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const main = region.match(/<main\b[\s\S]*?<\/main>/i) || region.match(/<article\b[\s\S]*?<\/article>/i);
  if (main) region = main[0];
  region = region
    .replace(/<header\b[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside\b[\s\S]*?<\/aside>/gi, ' ');
  const h1 = region.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/i);
  return h1 ? region.slice(region.indexOf(h1[0])) : region;
}

function buildPreservationRequirements(html) {
  const region = contentRegion(html);
  const headings = [...region.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map(match => normalizePreservedText(match[1]))
    .filter(Boolean);
  const links = extractAnchors(region);
  return { headings, links };
}

function consumeExact(items, expected, key) {
  const index = items.findIndex(item => key(item) === key(expected));
  if (index === -1) return false;
  items.splice(index, 1);
  return true;
}

function preservationIssues(html, requirements = {}) {
  const headings = [...String(html || '').matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)]
    .map(match => normalizePreservedText(match[1]));
  const links = extractAnchors(html);
  const issues = [];
  for (const heading of requirements.headings || []) {
    if (!consumeExact(headings, normalizePreservedText(heading), value => value)) issues.push(`Missing original heading: ${heading}`);
  }
  for (const link of requirements.links || []) {
    const expected = { href: normalizePreservedUrl(link.href), anchor: normalizePreservedText(link.anchor) };
    if (!consumeExact(links, expected, value => `${value.anchor}\n${value.href}`)) {
      issues.push(`Missing original link: ${link.anchor} (${link.href})`);
    }
  }
  return issues;
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
        if (!entry || entry.error) return null;
        const decision = entry.decision ?? entry.path ?? entry.verdict ?? entry.classification ?? null;
        if (typeof decision !== 'string' || !decision.trim() || decision.trim().toLowerCase() === 'error') return null;
        return {
          decision,
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

// OCB's per-check output carries the actionable fix text. Failed checks with a
// fix become the recommendations the rewrite must apply; identical fix texts
// collapse into one entry (A1/A2/A3 often share a single CONFLICT note).
function extractRecommendations(ocb) {
  const checks = ocb && ocb.raw && ocb.raw.checks;
  if (!checks || typeof checks !== 'object') return [];
  const byFix = new Map();
  for (const [id, check] of Object.entries(checks)) {
    if (!check || check.status !== 'fail') continue;
    const fix = String(check.fix || '').trim();
    if (!fix) continue;
    if (!byFix.has(fix)) byFix.set(fix, { checks: [], fix });
    byFix.get(fix).checks.push(id);
  }
  return [...byFix.values()];
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

function failureRecord(articleId, item, errorMsg, timestamp = new Date().toISOString()) {
  return {
    articleId,
    osBatchItemId: item.os_batch_item_id || null,
    keyword: item.keyword,
    clientName: item.clientName,
    error: errorMsg,
    timestamp,
  };
}

async function recordFailure(batchId, articleId, item, errorMsg) {
  const { data: job } = await getSupabase()
    .from(BATCH_TABLE)
    .select('errors, failed_count')
    .eq('batch_id', batchId)
    .single();
  const errors = job?.errors || [];
  errors.push(failureRecord(articleId, item, errorMsg));
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
    const recommendations = extractRecommendations(ocb);
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

    // Edit-in-place: derive the section jobs from the page's own structure so
    // the rewrite edits what exists. Fall back to the template outline when the
    // page doesn't parse into enough real content to edit.
    const parsed = extractPageSections(beforeHtml);
    const editMode = parsed.sections.length >= 2 && parsed.totalWords >= 200;
    if (editMode) {
      console.log(`[Optimize] Edit-in-place: ${parsed.sections.length} sections, ${parsed.totalWords} words`
        + `${parsed.hasCta ? '' : ', +CTA'}${parsed.hasFaq ? '' : ', +FAQ'}`);
    } else {
      console.log(`[Optimize] Page structure unparseable (${parsed.sections.length} sections, ${parsed.totalWords} words) — composing from template outline`);
    }

    const beforeText = htmlToText(beforeHtml).slice(0, 16000);
    const payload = {
      articleid: articleId,
      clientId: item.clientId || null,
      clientName: item.clientName,
      clientInfo: item.clientInfo || '',
      website: item.website || '',
      keyword: item.keyword,
      template: item.template || 'Practice Page',
      sections: editMode ? buildEditSections(parsed, item.sections) : item.sections,
      userId: item.userId || null,
    };

    try {
      const { runPipeline } = require('../pipeline');
      const result = await runPipeline({
        ...payload,
        optimization: {
          url: item.url,
          guidance: item.guidance,
          beforeText,
          recommendations,
          editMode,
          keepH1: editMode && Boolean(parsed.h1),
          originalWords: parsed.totalWords,
          preservation: editMode ? buildPreservationRequirements(beforeHtml, parsed) : null,
        },
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
          change_report: { bullets: report.bullets, ocb, recommendations, mode: editMode ? 'edit' : 'compose', generated_at: generatedAt },
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
  htmlToBlockText,
  extractPageSections,
  buildEditSections,
  minimumWordCount,
  buildPreservationRequirements,
  preservationIssues,
  failureRecord,
  fetchPage,
  htmlToText,
  classifyWithOcb,
  buildChangeReport,
  parseChangeReport,
  extractRecommendations,
};
