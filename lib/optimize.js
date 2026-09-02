'use strict';

const crypto = require('crypto');
const MODEL = require('./model');

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
const { CONCURRENCY, makeChain, runPool } = require('./pool');
// Serialized lanes: batch_jobs progress writes are read-modify-write, and OCB
// classification goes one page at a time so concurrent items never pile jobs
// into the OCB service's own queue past its 3-minute poll deadline.
const progress = makeChain();
const ocbLane = makeChain();

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

// A firewall/captcha interstitial is not the page. SiteGround's challenge
// answers HTTP 200 with a tiny meta-refresh document, which used to get stored
// as before_html and "optimized" as if it were the client's content — and its
// meta refresh then broke the editor's original-page preview (ATT
// cuban-adjustment-act, found 2026-08-31). A real meta-refresh redirect stub is
// equally not the content, so both ride the compose fallback.
function looksLikeInterstitial(html) {
  const text = String(html || '');
  if (!text.trim()) return false;
  if (/sgcaptcha/i.test(text)) return true;
  return text.length < 4096 && /http-equiv\s*=\s*["']?refresh/i.test(text);
}

// Statuses a hosting firewall answers with when it is refusing OUR IP rather
// than reporting a broken page. A 404/500 is the client's page and stays final.
const BLOCKED_STATUSES = new Set([401, 403, 406, 429, 503]);

function blocked(message) {
  const err = new Error(message);
  err.blocked = true;
  return err;
}

async function fetchDirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (BLOCKED_STATUSES.has(res.status)) throw blocked(`Page fetch blocked: HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Page fetch failed: HTTP ${res.status}`);
    const html = await res.text();
    if (looksLikeInterstitial(html)) {
      throw blocked("Page fetch blocked: the site's firewall answered with a challenge page instead of the content");
    }
    return html;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Page fetch timed out after 20 seconds');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Firecrawl fetches from its own IPs, and OCB already reads every client page
// through it, so it is the second pair of hands when the VPS itself is flagged.
async function fetchViaFirecrawl(url) {
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false, timeout: 30000 }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Firecrawl`);
  const data = await res.json();
  const html = data?.data?.rawHtml || '';
  const status = Number(data?.data?.metadata?.statusCode) || 0;
  if (status >= 400) throw new Error(`HTTP ${status} through Firecrawl`);
  if (!html.trim() || looksLikeInterstitial(html)) throw new Error('Firecrawl was challenged as well');
  return html;
}

// SiteGround's Anti-Bot flagged the VPS's own IP and served ~220 Batch #22
// optimizations a captcha stub instead of the page (2026-08-29), so every one
// of them was composed from scratch. A blocked direct fetch now retries through
// Firecrawl before giving up; a real HTTP error on the client's site stays final.
async function fetchPage(url) {
  try {
    return await fetchDirect(url);
  } catch (err) {
    if (!err.blocked || !process.env.FIRECRAWL_API_KEY) throw err;
    console.warn(`[Optimize] ${err.message} (${url}) — retrying through Firecrawl`);
    try {
      return await fetchViaFirecrawl(url);
    } catch (retryErr) {
      throw new Error(`${err.message}; Firecrawl retry failed: ${retryErr.message}`);
    }
  }
}

// Out-of-range entities stay as written: String.fromCodePoint throws above
// U+10FFFF, and a malformed page must not take the pipeline down.
function codePoint(original, value) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : original;
}

// Named typographic entities sites actually use in headings and anchors.
// Left undecoded, "Workers&rsquo; Compensation" becomes a preservation
// requirement no model output can ever match (Sabbeth proof run, 2026-08-30).
function decodeNamedEntities(text) {
  return text
    .replace(/&(rsquo|lsquo|apos);/gi, "'")
    .replace(/&(rdquo|ldquo);/gi, '"')
    .replace(/&(ndash|mdash);/gi, '-')
    .replace(/&hellip;/gi, '...');
}

function htmlToText(html) {
  return decodeNamedEntities(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => codePoint(match, parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (match, decimal) => codePoint(match, parseInt(decimal, 10))))
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
    .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_match, dq, sq, uq, label) => {
      const anchor = htmlToText(label);
      // Spaces and parens break the markdown round-trip ("tel:(802) 457-1112"
      // compiles back to a truncated href) — percent-encode them so the link
      // survives model echo, compile, and the preservation comparison intact.
      const href = String(dq ?? sq ?? uq ?? '').trim()
        .replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
      return anchor && href ? `[${anchor}](${href})` : anchor || '';
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
    .replace(/&#x([0-9a-f]+);?/gi, (match, hex) => codePoint(match, parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (match, decimal) => codePoint(match, parseInt(decimal, 10)))
    .replace(/&(rsquo|lsquo|apos);/gi, "'")
    .replace(/&(rdquo|ldquo);/gi, '"')
    .replace(/&(ndash|mdash);/gi, '-')
    .replace(/&hellip;/gi, '...')
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
  const headings = [...body.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const introText = cleanIntroText(htmlToBlockText(body.slice(0, headings[0]?.index ?? body.length)));
  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const match = headings[i];
    const heading = htmlToText(match[2]);
    const start = match.index + match[0].length;
    const end = headings[i + 1]?.index ?? body.length;
    const text = htmlToBlockText(body.slice(start, end));
    const words = countWords(text);
    if (!heading || JUNK_HEADING.test(heading)) continue;
    // A heading with almost no body is a theme widget, not a content section —
    // except a linked CTA ("Contact Us" + one link), which is real page content
    // the rewrite must carry so the preservation gate's demand is producible.
    if (words < 10 && !(CTA_HEADING.test(heading) && /\]\(/.test(text))) continue;
    sections.push({ heading, level: Number(match[1]), text, words });
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

// Map the parsed page onto edit-in-place jobs only. An optimization preserves
// the source page's heading skeleton; it never appends house-template sections.
function buildEditSections(parsed, _templateSections) {
  const hasIntro = parsed.intro.words > 0;
  const jobs = [{
    name: 'Page opening',
    details: hasIntro
      ? 'Edit the existing page opening in place. Keep the H1 and improve only the tagline or introduction already present.'
      : 'Keep the H1 exactly. Do not add a tagline or introduction when the source page has neither.',
    wordCount: hasIntro ? Math.max(parsed.intro.words, 60) : 1,
    originalText: [parsed.h1 ? `# ${parsed.h1}` : '', parsed.intro.text].filter(Boolean).join('\n'),
    mode: 'edit',
  }];
  for (const s of parsed.sections) {
    jobs.push({
      name: s.heading,
      details: '',
      wordCount: Math.max(s.words, 40),
      originalText: `${'#'.repeat(s.level || 2)} ${s.heading}\n${s.text}`,
      mode: 'edit',
    });
  }

  // Sections routinely land ~20% under their brief, so the ask has to carry that
  // headroom: at 1250 the finished edit came back around 1000 words, which is the
  // bottom of the Silver Standard's 900-1199 band (2 of 4 points). Asking for 1550
  // puts the delivered draft inside the 1200-2400 band that scores full marks.
  // ponytail: calibrated on observed yield, re-tune if drafts drift out of band.
  const targetTotal = 1550;
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

// Structured {anchor, href} pairs from block text carrying markdown links —
// the same representation buildEditSections hands the section editor, so every
// link the gate demands is one the model was actually shown.
function markdownLinks(text) {
  return [...String(text || '').matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map(match => ({ anchor: normalizePreservedText(match[1]), href: normalizePreservedUrl(match[2]) }))
    .filter(link => link.anchor && link.href);
}

function buildPreservationRequirements(html, parsed) {
  // The parsed structure is the same content buildEditSections turns into edit
  // jobs, which keeps one invariant: the gate only demands content the model
  // was handed. The whole-region fallback below swept in theme furniture on
  // non-Divi sites (footer phone links, "Practice Areas" sidebars, skip-links,
  // repeated consultation popups) — chrome no article rewrite could contain,
  // so those rows failed on every relaunch (Batch #22/#27, 2026-08-30).
  if (parsed && Array.isArray(parsed.sections) && parsed.sections.length) {
    const headings = [parsed.h1, ...parsed.sections.map(section => section.heading)]
      .map(normalizePreservedText)
      .filter(Boolean);
    const links = [
      ...markdownLinks(parsed.intro && parsed.intro.text),
      ...parsed.sections.flatMap(section => markdownLinks(section.text)),
    ];
    return { headings, links };
  }
  const region = contentRegion(html);
  const headings = [...region.matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map(match => normalizePreservedText(match[2]))
    .filter(Boolean);
  const links = extractAnchors(region);
  return { headings, links };
}

// Legal compliance rewrites reader-facing text deliberately (unverifiable
// claims, raw statute citations). When that rewords a protected heading or
// anchor, the requirement follows the rewrite: the gate exists to catch
// accidental loss, not to veto the pipeline's own compliance fixes. Mutates
// the shared preservation object so every later check sees the update.
function applyComplianceToPreservation(preservation, changes) {
  if (!preservation || !Array.isArray(changes) || !changes.length) return preservation;
  const rewrite = (text) => changes.reduce((acc, change) => {
    if (!change || !change.original) return acc;
    const to = change.replacement === '[REMOVED]' ? '' : String(change.replacement || '');
    const escaped = String(change.original).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return acc.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
  }, String(text || ''));
  if (Array.isArray(preservation.headings)) {
    preservation.headings = preservation.headings
      .map(heading => normalizePreservedText(rewrite(heading)))
      .filter(Boolean);
  }
  if (Array.isArray(preservation.links)) {
    preservation.links = preservation.links
      .map(link => ({ ...link, anchor: normalizePreservedText(rewrite(link.anchor)) }))
      .filter(link => link.anchor);
  }
  return preservation;
}

// Content-map rows sometimes carry site-relative URLs ("/some-page/"). The
// client's own website is known, so resolve instead of failing the row and
// bouncing it back for a data fix.
function resolvePageUrl(url, website) {
  const raw = String(url || '').trim();
  if (/^https?:\/\//i.test(raw) || !raw.startsWith('/') || !website) return raw;
  const base = /^https?:\/\//i.test(website) ? website : `https://${website}`;
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

function consumeExact(items, expected, key) {
  const index = items.findIndex(item => key(item) === key(expected));
  if (index === -1) return false;
  items.splice(index, 1);
  return true;
}

// Case restyling is not content loss: models title-case shouty original
// headings ("DO I NEED A LAWYER..." → "Do I Need a Lawyer...") and failing
// the whole article for it burned a full generation per retry. Duplicate
// counts still hold — two required instances need two in the output.
const foldCase = (value) => String(value ?? '').toLowerCase();

function preservationIssues(html, requirements = {}) {
  const headings = [...String(html || '').matchAll(/<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi)]
    .map(match => normalizePreservedText(match[2]));
  const links = extractAnchors(html);
  const issues = [];
  for (const heading of requirements.headings || []) {
    if (!consumeExact(headings, normalizePreservedText(heading), foldCase)) issues.push(`Missing original heading: ${heading}`);
  }
  for (const link of requirements.links || []) {
    const expected = { href: normalizePreservedUrl(link.href), anchor: normalizePreservedText(link.anchor) };
    if (!consumeExact(links, expected, value => foldCase(`${value.anchor}\n${value.href}`))) {
      issues.push(`Missing original link: ${link.anchor} (${link.href})`);
    }
  }
  return issues;
}

function markdownAssets(text) {
  const source = String(text || '');
  return {
    links: [...source.matchAll(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)]
      .map(match => `[${normalizePreservedText(match[1])}](${match[2].trim()})`),
    headings: [...source.matchAll(/^#{1,3}[ \t]+(.+)$/gm)]
      .map(match => normalizePreservedText(match[1])),
  };
}

// What an edited section lost against the original it was handed. The section
// editor works in markdown, so this compares markdown to markdown and feeds the
// section's own retry loop — catching a loss one call later costs one retry,
// catching it at the quality gate costs the whole batch.
function missingSectionSource(originalText, output) {
  const want = markdownAssets(originalText);
  const got = markdownAssets(output);
  const missing = [];
  for (const heading of want.headings) {
    if (!consumeExact(got.headings, heading, foldCase)) missing.push(`heading "${heading}"`);
  }
  for (const link of want.links) {
    if (!consumeExact(got.links, link, foldCase)) missing.push(`link ${link}`);
  }
  return missing;
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
    model: MODEL,
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
  return progress(async () => {
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
  });
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
  console.log(`[Optimize] Starting batch "${batchId}" with ${items.length} items (concurrency ${CONCURRENCY})`);
  await getSupabase().from(BATCH_TABLE).update({ status: 'processing' }).eq('batch_id', batchId);

  let cancelled = false;
  await runPool(items.length, async (i) => {
    if (cancelled) return;
    const item = items[i];
    const articleId = crypto.randomUUID();
    const { data: job } = await getSupabase()
      .from(BATCH_TABLE)
      .select('status')
      .eq('batch_id', batchId)
      .single();
    if (cancelled || job?.status === 'cancelled') {
      if (!cancelled) console.log(`[Optimize] Cancelled at item ${i + 1}/${items.length}`);
      cancelled = true;
      return;
    }

    await progress(() => getSupabase().from(BATCH_TABLE).update({ current_keyword: item.keyword }).eq('batch_id', batchId));
    console.log(`[Optimize] [${i + 1}/${items.length}] Optimizing: "${item.keyword}" (${item.clientName})`);

    const pageUrl = resolvePageUrl(item.url, item.website);
    // An unreachable page never fails the row: compose a fresh draft from the
    // template outline instead (same lane unparseable pages already use), and
    // say so on the change report. Editors review every draft either way.
    let beforeHtml = '';
    let fetchError = null;
    try {
      beforeHtml = await fetchPage(pageUrl);
    } catch (err) {
      fetchError = err.message;
      console.warn(`[Optimize] Could not fetch ${pageUrl} (${err.message}) — composing a fresh draft from the template outline instead`);
    }

    // OCB fetches the page itself, so a dead URL would just burn its 3-minute
    // poll deadline — skip it and generate without recommendations.
    const ocb = fetchError ? null : await ocbLane(() => classifyWithOcb(pageUrl, item.clientName, item.keyword));
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
      page_url: pageUrl,
      before_html: beforeHtml,
    };
    const { error: seedError } = await getSupabase().from(ARTICLE_TABLE).insert(seedRow);
    if (seedError) {
      await recordFailure(batchId, articleId, item, `Seed failed: ${seedError.message}`);
      return;
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
          url: pageUrl,
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
        if (fetchError) {
          // Nothing to diff against — the note IS the change report.
          report = { bullets: [`Original page could not be fetched (${fetchError}) — this draft was composed fresh from the template instead of edited in place.`] };
        } else {
          try {
            report = await buildChangeReport(beforeText, afterHtml || '', item.keyword);
          } catch (err) {
            console.error(`[Optimize] Change report failed for "${item.keyword}":`, err.message);
            report = { bullets: [] };
          }
        }
        await getSupabase().from(ARTICLE_TABLE).update({
          change_report: { bullets: report.bullets, ocb, recommendations, mode: editMode ? 'edit' : 'compose', generated_at: generatedAt, ...(fetchError ? { fetch_error: fetchError } : {}) },
        }).eq('article_id', articleId);
        await progress(async () => getSupabase().from(BATCH_TABLE).update({
          completed_count: (await getCompletedCount(batchId)) + 1,
        }).eq('batch_id', batchId));
      }
    } catch (err) {
      await recordFailure(batchId, articleId, item, err.message);
    }

    if (i < items.length - 1) await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_ARTICLES_MS));
  });

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
  applyComplianceToPreservation,
  markdownLinks,
  resolvePageUrl,
  missingSectionSource,
  preservationIssues,
  failureRecord,
  fetchPage,
  looksLikeInterstitial,
  htmlToText,
  classifyWithOcb,
  buildChangeReport,
  parseChangeReport,
  extractRecommendations,
};
