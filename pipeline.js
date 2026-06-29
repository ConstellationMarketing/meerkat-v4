'use strict';

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { compileArticle } = require('./lib/article-compiler');
const { insertLinks } = require('./lib/insert-links');
const { applyCompliance } = require('./lib/apply-compliance');
const { scoreArticle } = require('./lib/scoring');
const { upsertArticle } = require('./lib/supabase');
const { publishArticle } = require('./lib/github-publish');
const { runTranslation } = require('./lib/translate');
const { checkAndFixFormat } = require('./lib/format-checker');
const { checkCrossArticleDuplicates, getPriorClientPhrases } = require('./lib/cross-article-dupe-check');
const { repairStructuralIssues } = require('./lib/structural-repair');

const client = new Anthropic();

// Load prompts at startup
const PROMPTS_DIR = path.join(__dirname, 'prompts');
const prompts = {};
['section-writer', 'external-links', 'internal-links', 'title-meta', 'legal-compliance', 'schema-generator', 'slug-url', 'article-review'].forEach(name => {
  prompts[name] = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
});

// Fill template placeholders
function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// Parse SYSTEM/USER sections from prompt file
function parsePrompt(template, vars) {
  const filled = fillTemplate(template, vars);
  const systemMatch = filled.match(/^SYSTEM:\s*([\s\S]+?)(?=\nUSER:)/m);
  const userMatch = filled.match(/\nUSER:\s*([\s\S]+)$/m);
  return {
    system: systemMatch ? systemMatch[1].trim() : '',
    user: userMatch ? userMatch[1].trim() : filled
  };
}

// Call Claude and return text output
async function callClaude(systemPrompt, userPrompt, model = 'claude-haiku-4-5-20251001') {
  const MAX_API_RETRIES = 3;
  const BASE_DELAY_MS = 5000;

  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      });
      return msg.content[0].text.trim();
    } catch (err) {
      const isRetryable = err.status === 429 || err.status === 500 || err.status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (isRetryable && attempt < MAX_API_RETRIES) {
        const delay = BASE_DELAY_MS * attempt;
        console.warn(`[callClaude] ${err.status || err.code} on attempt ${attempt}/${MAX_API_RETRIES} — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// Parse JSON from Claude output. Handles three observed failure modes:
//   1. Code-fence wrappers (```json ... ```)
//   2. Leading prose ("Here are the links: [...]")
//   3. Trailing prose ("[...] I hope this helps.") — observed in batch
//      smoke test logs as "Unexpected non-whitespace character after JSON
//      at position N" failures, which were silently dropping every external
//      link the model generated.
function parseJSON(raw) {
  let cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // Strip leading prose
  if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
    const jsonStart = cleaned.search(/[\[{]/);
    if (jsonStart !== -1) cleaned = cleaned.slice(jsonStart);
  }

  // Direct parse first — when the model returns clean JSON, this is fastest
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall through to bracket-balance extraction below
  }

  // Walk forward tracking nesting depth and string state. Slice at the
  // matched closing bracket/brace. Strips any trailing prose the model
  // added after a valid JSON value.
  const opener = cleaned[0];
  if (opener !== '[' && opener !== '{') throw new Error('parseJSON: no opening bracket/brace found');
  const closer = opener === '[' ? ']' : '}';

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIdx = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }

  if (endIdx === -1) throw new Error('parseJSON: unbalanced brackets/braces');
  return JSON.parse(cleaned.slice(0, endIdx + 1));
}

// Post-processing: enforce single H1 — strip all but the first, or promote first H2
function enforceSingleH1(html) {
  const h1Count = (html.match(/<h1>/gi) || []).length;

  if (h1Count === 0) {
    // No H1 found — promote the first H2 to H1
    let promoted = false;
    html = html.replace(/<h2>([\s\S]*?)<\/h2>/i, (match, content) => {
      if (!promoted) {
        promoted = true;
        return `<h1>${content}</h1>`;
      }
      return match;
    });
  } else if (h1Count > 1) {
    // Multiple H1s — keep first, demote rest to H2
    let foundFirst = false;
    html = html.replace(/<h1>([\s\S]*?)<\/h1>/gi, (match) => {
      if (!foundFirst) {
        foundFirst = true;
        return match;
      }
      return match.replace(/<h1>/i, '<h2>').replace(/<\/h1>/i, '</h2>');
    });
  }

  return html;
}

// Post-processing: replace bracketed placeholders with client name or fallback
function stripPlaceholders(html, clientName) {
  const fallback = clientName || 'our firm';
  return html
    .replace(/\[Firm [Nn]ame\]/g, fallback)
    .replace(/\[firm name\]/gi, fallback)
    .replace(/\[Attorney [Nn]ame\]/g, fallback)
    .replace(/\[City\]/gi, '')
    .replace(/\[State\]/gi, '')
    .replace(/\[Phone\]/gi, '')
    .replace(/\[Contact\]/gi, '');
}

// Sanitize HTML returned by the article-review pass. The reviewer model has
// been observed leaving its own reasoning artifacts inside `fixed_article`
// (HTML comments, "Note:" / "Issue:" / "Fixed:" prefixes, or a preamble
// before the first tag). Editors flagged these leaking into published copy.
// Strip the known artifact patterns before applying the reviewed HTML.
function sanitizeReviewedHTML(html) {
  if (!html) return html;
  let out = html;
  // Drop HTML comments — review notes sometimes ship as <!-- Issue #5: ... -->
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // Drop any preamble before the first HTML tag (e.g., "Here's the corrected article:")
  const firstTag = out.search(/<[a-zA-Z!]/);
  if (firstTag > 0) out = out.slice(firstTag);
  // Drop trailing prose after the last closing tag
  const lastTagClose = out.lastIndexOf('>');
  if (lastTagClose > -1 && lastTagClose < out.length - 1) {
    out = out.slice(0, lastTagClose + 1);
  }
  // Drop standalone note-prefixed paragraphs the reviewer occasionally emits
  // inside the article body. Conservative match: only strips a <p> whose entire
  // content begins with a known reviewer-prefix label.
  out = out.replace(
    /<p>\s*(?:Note|Issue|Fixed|Internal note|TODO|Reviewer note)\s*[:\-—].*?<\/p>/gi,
    ''
  );
  return out;
}

// Post-processing: remove links from inside heading tags
function stripLinksFromHeadings(html) {
  return html.replace(/<(h[1-3])>([\s\S]*?)<\/\1>/gi, (match, tag, content) => {
    const cleaned = content.replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    return `<${tag}>${cleaned}</${tag}>`;
  });
}

// Post-processing: fix malformed H3 tags where body content is inside the heading
// e.g. <h3>Title\nBody paragraph text...</h3> → <h3>Title</h3>\n<p>Body paragraph text...</p>
function fixMalformedH3(html) {
  return html.replace(/<h3([^>]*)>([\s\S]*?)<\/h3>/gi, (match, attrs, inner) => {
    const trimmed = inner.trim();
    // Leave short headings and FAQ questions alone
    const textOnly = trimmed.replace(/<[^>]+>/g, '').trim();
    if (textOnly.length < 150 || textOnly.endsWith('?')) return match;

    // Split on first newline — title is before, body is after
    const nlIdx = trimmed.indexOf('\n');
    if (nlIdx > 0) {
      const title = trimmed.substring(0, nlIdx).trim();
      const body = trimmed.substring(nlIdx + 1).trim();
      return `<h3${attrs}>${title}</h3>\n<p>${body}</p>`;
    }
    return match;
  });
}

// Post-processing: force H1 to match the exact keyword
function lockH1ToKeyword(html, keyword) {
  if (!keyword) return html;
  const h1Match = html.match(/<h1>([\s\S]*?)<\/h1>/i);
  if (!h1Match) return html;

  const h1Text = h1Match[1].replace(/<[^>]+>/g, '').trim();
  const kwLower = keyword.toLowerCase().trim();
  const h1Lower = h1Text.toLowerCase();

  // If H1 already matches keyword exactly (case-insensitive), leave it
  if (h1Lower === kwLower) return html;

  // Allow minor variation: H1 starts with keyword but has appended content (colon, dash, pipe)
  // or H1 is substantially longer than keyword — replace with exact keyword
  if (h1Lower.startsWith(kwLower) && h1Text.length > keyword.length * 1.2) {
    return html.replace(/<h1>[\s\S]*?<\/h1>/i, `<h1>${keyword}</h1>`);
  }

  // If H1 doesn't even start with the keyword, replace entirely
  if (!h1Lower.startsWith(kwLower)) {
    return html.replace(/<h1>[\s\S]*?<\/h1>/i, `<h1>${keyword}</h1>`);
  }

  return html;
}

// Post-processing: enforce tagline is max 7 words
function enforceTaglineLength(html) {
  // Tagline is a bold-dominant short paragraph in the intro (between H1 and first H2)
  const introMatch = html.match(/(<h1>[\s\S]*?<\/h1>)([\s\S]*?)(<h2>)/i);
  if (!introMatch) return html;

  const intro = introMatch[2];
  // Match any <p> that contains <strong> and is primarily bold text
  // Handles: <p><strong>...</strong></p>, <p><em><strong>...</strong></em></p>,
  // <p> <strong>...</strong> </p>, etc.
  const taglineRegex = /<p[^>]*>\s*(?:<[^>]+>\s*)*<strong>([\s\S]*?)<\/strong>(?:\s*<\/[^>]+>)*\s*<\/p>/i;
  const taglineMatch = intro.match(taglineRegex);
  if (!taglineMatch) return html;

  const taglineText = taglineMatch[1].replace(/<[^>]+>/g, '').trim();
  const words = taglineText.split(/\s+/).filter(w => w.length > 0);

  if (words.length <= 7) return html;

  // Tagline exceeds 7 words. Blind-slicing at word 7 ships broken fragments
  // like "Your business built your life. Make a." — instead, keep the longest
  // complete-sentence prefix that fits in 7 words. If no sentence fits, drop
  // the tagline entirely (editors prefer no tagline over a broken one).
  const sentences = splitSentences(taglineText) || [];
  let kept = '';
  let keptWords = 0;
  for (const s of sentences) {
    const sWords = s.trim().split(/\s+/).filter(w => w.length > 0).length;
    if (keptWords + sWords > 7) break;
    kept = (kept + ' ' + s.trim()).trim();
    keptWords += sWords;
  }

  const oldTag = taglineMatch[0];
  if (kept) {
    const newTag = `<p><strong>${kept}</strong></p>`;
    return html.replace(oldTag, newTag);
  }
  console.warn(`[Pipeline] Tagline exceeds 7 words with no fitting sentence prefix — dropping: "${taglineText.slice(0, 120)}"`);
  return html.replace(oldTag, '');
}

// Shared sentence splitter that handles legal abbreviations (U.S., D.U.I., etc.)
function splitSentences(text) {
  // Protect common abbreviations from being treated as sentence endings
  const protected_ = text
    .replace(/\bU\.S\./g, 'U\x00S\x00')
    .replace(/\bD\.U\.I\./g, 'D\x00U\x00I\x00')
    .replace(/\bD\.W\.I\./g, 'D\x00W\x00I\x00')
    .replace(/\bD\.C\./g, 'D\x00C\x00')
    .replace(/\bN\.J\./g, 'N\x00J\x00')
    .replace(/\bN\.Y\./g, 'N\x00Y\x00')
    .replace(/\bv\./g, 'v\x00')
    .replace(/\bvs\./g, 'vs\x00')
    .replace(/\bDr\./g, 'Dr\x00')
    .replace(/\bMr\./g, 'Mr\x00')
    .replace(/\bMrs\./g, 'Mrs\x00')
    .replace(/\bSt\./g, 'St\x00')
    .replace(/\bJr\./g, 'Jr\x00')
    .replace(/\bSr\./g, 'Sr\x00')
    .replace(/\be\.g\./g, 'e\x00g\x00')
    .replace(/\bi\.e\./g, 'i\x00e\x00')
    .replace(/§\s*[\d.-]+/g, m => m.replace(/\./g, '\x00'));

  const sentences = protected_.match(/[^.!?]*[.!?]+/g);
  if (!sentences) return null;
  return sentences.map(s => s.replace(/\x00/g, '.'));
}

// Post-processing: replace forbidden words with safe alternatives
const FORBIDDEN_WORDS = {
  'victims': 'those affected',
  'victim': 'injured person',
};

function stripForbiddenWords(html) {
  let result = html;
  for (const [word, replacement] of Object.entries(FORBIDDEN_WORDS)) {
    // Word-boundary match, skip content inside heading tags
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    result = result.replace(regex, (match, offset) => {
      // Check if we're inside a heading tag
      const before = result.slice(Math.max(0, offset - 200), offset);
      if (/<h[1-3][^>]*>[^<]*$/i.test(before)) return match;
      // Preserve original case pattern
      if (match[0] === match[0].toUpperCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1);
      }
      return replacement;
    });
  }
  return result;
}

// Post-processing: remove duplicate link URLs — keep first occurrence only
function deduplicateLinks(html) {
  const seenUrls = new Set();
  return html.replace(/<a\s+([^>]*href="([^"]*)"[^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, url, text) => {
    const normalizedUrl = url.toLowerCase().replace(/\/+$/, '');
    if (seenUrls.has(normalizedUrl)) {
      // Already linked this URL — keep the text, strip the <a> wrapper
      return text;
    }
    seenUrls.add(normalizedUrl);
    return match;
  });
}

// Post-processing: strip phone numbers from article body
function stripPhoneNumbers(html) {
  // Match common US phone formats, ordered from most specific to least
  return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, content) => {
    const cleaned = content
      .replace(/1[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '')  // 1-800-555-1234, 1 (800) 555-1234
      .replace(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/g, '')             // (555) 555-5555, 555-555-5555, 555.555.5555
      .replace(/\s+(or|and|at)\s+[.,]/g, '.')                         // Clean dangling conjunctions
      .replace(/\s+(or|and|at)\s*$/g, '')                             // Clean trailing conjunctions
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned !== content) {
      return `<p>${cleaned}</p>`;
    }
    return match;
  });
}

// Post-processing: replace homepage links with contact page links in CTA sections
function fixCTALinks(html, website) {
  if (!website) return html;
  const domain = website.replace(/\/+$/, '');
  const homepage = domain;
  const homepageSlash = domain + '/';
  const contactUrl = domain + '/contact';

  // Find the last H2 section that isn't FAQ — that's the CTA
  const h2Parts = html.split(/<h2>/i);
  for (let i = h2Parts.length - 1; i >= 1; i--) {
    const heading = (h2Parts[i].match(/^([^<]*)<\/h2>/) || [])[1] || '';
    if (/FAQ|Frequently/i.test(heading)) continue;

    // This is the CTA section — replace homepage links with contact page
    const original = h2Parts[i];
    const fixed = original.replace(
      new RegExp(`href="${homepage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?\\s*"`, 'gi'),
      `href="${contactUrl}"`
    );
    if (fixed !== original) {
      h2Parts[i] = fixed;
      return h2Parts.map((p, idx) => idx === 0 ? p : '<h2>' + p).join('');
    }
    break;
  }
  return html;
}

// Post-processing: truncate FAQ answers to max 2 sentences
function truncateFAQAnswers(html) {
  // Find the FAQ section — H2 containing "FAQ" or "Frequently Asked"
  const faqHeaderIdx = html.search(/<h2>[^<]*(FAQ|Frequently Asked)[^<]*<\/h2>/i);
  if (faqHeaderIdx === -1) return html;

  const beforeFaq = html.slice(0, faqHeaderIdx);
  let faqSection = html.slice(faqHeaderIdx);

  // Process each <p> after an H3 within the FAQ section
  // Relaxed: H3 doesn't need to end with ? (some questions are phrased as statements)
  faqSection = faqSection.replace(
    /(<h3>[^<]*<\/h3>\s*)(<p>)([\s\S]*?)(<\/p>)/gi,
    (match, h3, pOpen, answerContent, pClose) => {
      const textOnly = answerContent.replace(/<[^>]+>/g, '').trim();
      const sentences = splitSentences(textOnly);
      if (!sentences || sentences.length <= 2) return match;

      // Keep first 2 sentences
      const truncated = sentences.slice(0, 2).join('').trim();
      return `${h3}${pOpen}${truncated}${pClose}`;
    }
  );

  return beforeFaq + faqSection;
}

// Post-processing: split paragraphs with 4+ sentences into max 3 sentences each
function splitLongParagraphs(html) {
  return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, content) => {
    // Skip very short paragraphs or those that are just a tagline/bold phrase
    const textOnly = content.replace(/<[^>]+>/g, '').trim();
    if (textOnly.length < 50) return match;

    // Check sentence count using abbreviation-aware splitter
    const sentences = splitSentences(textOnly);
    if (!sentences || sentences.length <= 3) return match;

    // For paragraphs with inline HTML (links, bold, etc.), use the original
    // content and split on sentence boundaries within the HTML
    const hasInlineHtml = /<[^/][^>]*>/.test(content);
    if (hasInlineHtml) {
      // Split the raw HTML content on sentence-ending punctuation followed by whitespace
      // This preserves inline tags within each sentence
      const htmlSentences = content.split(/(?<=[.!?])\s+(?=[A-Z<])/);
      if (htmlSentences.length <= 3) return match;
      const paragraphs = [];
      for (let i = 0; i < htmlSentences.length; i += 3) {
        const chunk = htmlSentences.slice(i, i + 3).join(' ').trim();
        if (chunk) paragraphs.push(`<p>${chunk}</p>`);
      }
      return paragraphs.join('\n');
    }

    // Plain text paragraphs — simple split
    const paragraphs = [];
    for (let i = 0; i < sentences.length; i += 3) {
      const chunk = sentences.slice(i, i + 3).join('').trim();
      if (chunk) paragraphs.push(`<p>${chunk}</p>`);
    }
    return paragraphs.join('\n');
  });
}

// Post-processing: strip links to legal directories (Justia, FindLaw, Avvo, etc.)
const BLOCKED_DOMAINS = [
  'justia.com', 'findlaw.com', 'avvo.com', 'lawyers.com',
  'martindale.com', 'nolo.com', 'lawinfo.com'
];

function stripDirectoryLinks(html) {
  return html.replace(/<a\s+([^>]*href="([^"]*)"[^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, url, text) => {
    const urlLower = url.toLowerCase();
    if (BLOCKED_DOMAINS.some(domain => urlLower.includes(domain))) {
      return text; // Keep text, strip link
    }
    return match;
  });
}

// Post-processing: strip internal links with anchor text under 3 words (too generic)
function enforceAnchorTextLength(html) {
  return html.replace(/<a\s+([^>]*href="([^"]*)"[^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, url, text) => {
    // Only check internal links (skip external)
    if (/class="legal-reference"/i.test(attrs)) {
      const plainText = text.replace(/<[^>]+>/g, '').trim();
      const wordCount = plainText.split(/\s+/).length;
      if (wordCount < 3) {
        return text; // Too short/generic — strip the link, keep text
      }
    }
    return match;
  });
}

// Post-processing: detect and remove duplicate phrases within paragraphs
function deduplicatePhrases(html) {
  return html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, content) => {
    const textOnly = content.replace(/<[^>]+>/g, '').trim();
    if (textOnly.length < 20) return match;

    // Detect repeated phrases: 2-6 word sequences that appear back-to-back
    // Handles "from day one from day one", "clear guidance, clear guidance", etc.
    let fixed = textOnly;
    // Match phrase repeated with optional comma/space between
    fixed = fixed.replace(/\b((?:\w+\s+){1,5}\w+)[\s,]+\1\b/gi, '$1');
    // Match single repeated words: "help help", "the the"
    fixed = fixed.replace(/\b(\w+)\s+\1\b/gi, '$1');

    if (fixed !== textOnly) {
      // Replace in the original HTML-containing content, preserving tags
      // Use the text-only version since dedup may shift positions
      return `<p>${fixed}</p>`;
    }
    return match;
  });
}

// Post-processing: verify external links exist, warn if missing
function countExternalLinks(html) {
  const externalLinkRegex = /<a\s+[^>]*class="legal-reference"[^>]*>/gi;
  const matches = html.match(externalLinkRegex) || [];
  return matches.length;
}

// Post-processing: check for statute citations in the article
function hasStatuteCitation(html) {
  const textOnly = html.replace(/<[^>]+>/g, ' ');
  // Match common statute patterns: §, Section ###, Code §, state code references
  const statutePatterns = [
    /§\s*[\d]/, // § followed by number
    /\bSection\s+\d+[\d.()-]*/i, // Section 123
    /\bCode\s+§/i, // Code §
    /\bChapter\s+\d+/i, // Chapter 7
    /\bTitle\s+\d+/i, // Title 42
    /\d+\s+U\.S\.C\./i, // 42 U.S.C.
    /\bO\.C\.G\.A\.\s*§/i, // Georgia code
    /\bRev\.\s*Stat\./i, // Revised Statutes
    /\bPenal\s+Code\s+§/i, // Penal Code §
    /\bVeh\.\s*Code\s+§/i, // Vehicle Code §
    /\bFam\.\s*Code\s+§/i, // Family Code §
    /\bCiv\.\s*Code\s+§/i, // Civil Code §
    /\bBus\.\s*&\s*Prof\.\s*Code\s+§/i, // Business & Professions Code §
    /\bAnn\.\s*Code\s+§/i, // Annotated Code §
  ];
  return statutePatterns.some(p => p.test(textOnly));
}

// Post-processing: cap H3s at 5 per section — convert excess to bold paragraph
// labels. Cap raised from 2 → 5 to match the new richer Why Choose Us /
// What to Expect briefs (which call for 3–5 H3 sub-headings). Previously,
// capH3Density was the silent reason articles shipped with only 2 H3s
// regardless of what the model produced or what the brief requested.
function capH3Density(html) {
  const parts = html.split(/(<h2>)/i);
  let result = parts[0];

  for (let i = 1; i < parts.length; i += 2) {
    const h2Tag = parts[i];
    const sectionContent = parts[i + 1] || '';
    let h3Count = 0;

    const fixed = sectionContent.replace(/<h3>([\s\S]*?)<\/h3>/gi, (match, heading) => {
      h3Count++;
      if (h3Count > 5) {
        // Beyond 5 — convert to bold paragraph label instead of H3
        return `<p><strong>${heading.trim()}</strong></p>`;
      }
      return match;
    });

    result += h2Tag + fixed;
  }
  return result;
}

// Word count targets by template for quality gating
const TEMPLATE_WORD_TARGETS = {
  'Practice Page': 2007,
  'Supporting/Resource Page': 1150,
  'practice': 2007,
  'supporting': 1150,
};

// Pre-upsert quality gate — returns { pass, issues[] }
function qualityGate(content, sections, template, wordCount, formatWarnings = []) {
  const issues = [];

  // 1. Check for failed sections
  const failedCount = (content.match(/\[Section \d+ generation failed\]/g) || []).length;
  const totalSections = sections.length;
  if (failedCount > 0) {
    const failRatio = failedCount / totalSections;
    issues.push(`${failedCount}/${totalSections} sections failed (${Math.round(failRatio * 100)}%)`);
    if (failRatio > 0.5) {
      return { pass: false, issues, reason: 'majority-sections-failed' };
    }
  }

  // 2. Check for placeholder content
  if (content.includes('Section content unavailable')) {
    issues.push('Contains "Section content unavailable" placeholder');
    return { pass: false, issues, reason: 'placeholder-content' };
  }

  // 3. Article-level word count gate
  const target = TEMPLATE_WORD_TARGETS[template] || TEMPLATE_WORD_TARGETS['practice'];
  const minWords = Math.round(target * 0.5);
  if (wordCount < minWords) {
    issues.push(`Word count ${wordCount} below minimum ${minWords} (50% of ${target} target)`);
    return { pass: false, issues, reason: 'below-word-count' };
  }

  // 4. Must have at least one H1
  if (!/<h1/i.test(content)) {
    issues.push('Missing H1 heading');
    return { pass: false, issues, reason: 'missing-h1' };
  }

  // 5. Hard-block scaffold/brief text leaks. Editors have flagged these as
  // visibly templated copy multiple times; never publish them.
  const scaffoldLeaks = (formatWarnings || []).filter(w => w.startsWith('SCAFFOLD:'));
  if (scaffoldLeaks.length > 0) {
    issues.push(...scaffoldLeaks);
    return { pass: false, issues, reason: 'scaffold-text-leaked' };
  }

  return { pass: true, issues };
}

// Generate one section with QC retry loop
async function generateSection(payload, section) {
  const vars = {
    keyword: payload.keyword,
    clientName: payload.clientName,
    clientId: payload.clientId,
    website: payload.website,
    clientInfo: payload.clientInfo,
    articleId: payload.articleId,
    template: payload.template || 'practice',
    sectionNumber: section.sectionNumber,
    sectionName: section.name || section.title || '',
    details: section.details || section.description || '',
    wordCount: section.wordCount
  };

  const { system, user } = parsePrompt(prompts['section-writer'], vars);

  // Cross-article dedup prevention: when CROSS_ARTICLE_DEDUP_PREVENT is on,
  // payload.priorPhrases carries sentences from this client's last 3 articles.
  // Append them as a "do not reuse verbatim" block so the model varies
  // phrasing at generation time rather than us catching repeats post-hoc.
  let priorPhrasesBlock = '';
  if (payload.priorPhrases && payload.priorPhrases.length) {
    const bulleted = payload.priorPhrases.map(s => `- ${s}`).join('\n');
    priorPhrasesBlock = `\n\n## RECENTLY USED PHRASES FOR THIS CLIENT — DO NOT REUSE VERBATIM\n\nThe sentences below have already appeared in recent articles for ${payload.clientName || 'this client'}. Do not use them verbatim or near-verbatim in this section. Vary the wording substantially, choose different facts/examples, or omit the point entirely if a varied alternative would feel forced. This is critical — editors flag repeated boilerplate as a quality issue.\n\n${bulleted}`;
  }

  let lastOutput = null;
  let lastScore = null;
  let lastWordCount = null;
  const MAX_RETRIES = 2;
  const targetWords = section.wordCount ? parseInt(section.wordCount, 10) : null;
  // Section passes QC if word count is at least 80% of target (allows minor variance)
  const minWords = targetWords ? Math.floor(targetWords * 0.8) : null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let userMsg = user + priorPhrasesBlock;
    if (attempt > 0) {
      const issues = [];
      if (lastScore !== null && lastScore < 70) {
        issues.push(`Flesch score was ${lastScore}/100 — shorten sentences, simplify vocabulary.`);
      }
      if (minWords && lastWordCount < minWords) {
        issues.push(`Word count was ${lastWordCount} — target is ${targetWords}. Expand with more substantive detail. Do not pad with filler.`);
      }
      userMsg += `\n\nPrevious output needs revision: ${issues.join(' ')}`;
    }

    const output = await callClaude(system, userMsg, 'claude-sonnet-4-6');
    const { rawScore, wordCount: outputWords } = scoreArticle(output);
    lastOutput = output;
    lastScore = rawScore;
    lastWordCount = outputWords;

    const fleschOk = rawScore >= 70;
    const wordCountOk = !minWords || outputWords >= minWords;

    if (fleschOk && wordCountOk) break;

    if (attempt === MAX_RETRIES) {
      const failures = [];
      if (!fleschOk) failures.push(`flesch=${rawScore}`);
      if (!wordCountOk) failures.push(`words=${outputWords}/${targetWords}`);
      console.warn(`Section ${section.sectionNumber} QC issues after ${MAX_RETRIES + 1} attempts (${failures.join(', ')}) — using as-is`);
    }
  }

  return { output: lastOutput, fleschScore: lastScore, sectionNumber: section.sectionNumber };
}

// Parse internal URLs from clientInfo (extract URLs)
function extractInternalUrls(clientInfo) {
  if (!clientInfo) return '';
  const urlRegex = /https?:\/\/[^\s,\]>)"}]+/g;
  const matches = clientInfo.match(urlRegex) || [];
  return matches.join('\n');
}

/**
 * Main pipeline: generate article from webhook payload.
 * @param {object} payload - Webhook body
 * @returns {Promise<object>} Final article data
 */
async function runPipeline(payload) {
  const {
    articleid: articleId,
    clientId,
    clientName,
    clientInfo,
    website,
    keyword,
    sections,
    template,
    userId,
    webhookUrl
  } = payload;

  console.log(`[Pipeline] Starting: articleId=${articleId}, keyword="${keyword}", sections=${sections.length}`);

  // Cross-article dedup prevention: fetch this client's recent phrases once,
  // pass to every parallel section call. No-op (returns []) unless
  // CROSS_ARTICLE_DEDUP_PREVENT=1 in env.
  let priorPhrases = [];
  try {
    priorPhrases = await getPriorClientPhrases(clientName, articleId);
    if (priorPhrases.length) {
      console.log(`[Pipeline] Dedup prevention: ${priorPhrases.length} prior-article phrases will be injected into section prompts`);
    }
  } catch (e) {
    console.warn('[Pipeline] getPriorClientPhrases threw — skipping:', e.message);
  }

  // ─── 1. Parallel section generation ───────────────────────────────────────
  console.log(`[Pipeline] Generating ${sections.length} sections in parallel...`);
  const sectionResults = await Promise.all(
    sections.map(section =>
      generateSection({ articleId, clientId, clientName, clientInfo, website, keyword, template, priorPhrases }, section)
        .catch(err => {
          console.error(`Section ${section.sectionNumber} failed:`, err.message);
          return { output: `[Section ${section.sectionNumber} generation failed]`, fleschScore: 0, sectionNumber: section.sectionNumber };
        })
    )
  );

  // Sort by original section order
  sectionResults.sort((a, b) => a.sectionNumber - b.sectionNumber);
  const sectionTexts = sectionResults.map(r => r.output);

  // ─── 2. Compile HTML + post-processing ──────────────────────────────────────
  console.log('[Pipeline] Compiling HTML...');
  let htmlContent = compileArticle(sectionTexts);
  htmlContent = enforceSingleH1(htmlContent);
  htmlContent = stripPlaceholders(htmlContent, clientName);
  htmlContent = stripLinksFromHeadings(htmlContent);
  htmlContent = fixMalformedH3(htmlContent);
  htmlContent = lockH1ToKeyword(htmlContent, keyword);
  htmlContent = enforceTaglineLength(htmlContent);
  htmlContent = stripForbiddenWords(htmlContent);
  htmlContent = truncateFAQAnswers(htmlContent);
  htmlContent = splitLongParagraphs(htmlContent);
  htmlContent = stripPhoneNumbers(htmlContent);
  htmlContent = capH3Density(htmlContent);

  // ─── 3. Parallel: external links + internal links + title/meta ─────────────
  console.log('[Pipeline] Running link enrichment and title/meta in parallel...');
  const internalUrls = extractInternalUrls(clientInfo);

  const [externalLinksRaw, internalLinksRaw, titleMetaRaw] = await Promise.all([
    callClaude(
      ...Object.values(parsePrompt(prompts['external-links'], { htmlContent })),
      'claude-haiku-4-5-20251001'
    ).catch(err => { console.error('External links failed:', err.message); return '[]'; }),

    callClaude(
      ...Object.values(parsePrompt(prompts['internal-links'], { htmlContent, internalUrls })),
      'claude-haiku-4-5-20251001'
    ).catch(err => { console.error('Internal links failed:', err.message); return '[]'; }),

    callClaude(
      ...Object.values(parsePrompt(prompts['title-meta'], { keyword, htmlContent })),
      'claude-haiku-4-5-20251001'
    ).catch(err => { console.error('Title/meta failed:', err.message); return '{"titleTag":"","description":""}'; })
  ]);

  // ─── 4. Parse and merge links ──────────────────────────────────────────────
  let externalLinks = [];
  let internalLinks = [];
  try { externalLinks = parseJSON(externalLinksRaw); } catch (e) { console.error('Parse external links failed:', e.message); }
  try { internalLinks = parseJSON(internalLinksRaw); } catch (e) { console.error('Parse internal links failed:', e.message); }

  // ─── 4a. Retry external links if none returned ────────────────────────────
  if (!Array.isArray(externalLinks) || externalLinks.length === 0) {
    console.log('[Pipeline] No external links from first attempt — retrying with Sonnet...');
    try {
      const retryRaw = await callClaude(
        ...Object.values(parsePrompt(prompts['external-links'], { htmlContent })),
        'claude-sonnet-4-6'
      );
      const retryLinks = parseJSON(retryRaw);
      if (Array.isArray(retryLinks) && retryLinks.length > 0) {
        externalLinks = retryLinks;
        console.log(`[Pipeline] Retry succeeded: ${externalLinks.length} external link(s)`);
      } else {
        console.warn('[Pipeline] ⚠ Retry returned 0 external links — article will lack authoritative sources');
      }
    } catch (err) {
      console.error('[Pipeline] External links retry failed:', err.message);
    }
  }

  const allLinks = [...externalLinks, ...internalLinks];
  let { htmlContent: linkedHTML } = insertLinks(htmlContent, allLinks);
  linkedHTML = deduplicateLinks(linkedHTML);
  linkedHTML = stripDirectoryLinks(linkedHTML);
  linkedHTML = enforceAnchorTextLength(linkedHTML);
  linkedHTML = deduplicatePhrases(linkedHTML);
  linkedHTML = stripPhoneNumbers(linkedHTML);
  linkedHTML = fixCTALinks(linkedHTML, website);
  linkedHTML = capH3Density(linkedHTML);

  // ─── 5. Build full content with SEO header ─────────────────────────────────
  let titleMeta = { titleTag: '', description: '' };
  try { titleMeta = parseJSON(titleMetaRaw); } catch (e) { console.error('Parse title/meta failed:', e.message); }

  // const seoHeader = `\n<div class="seo-header">\n  <h1>${titleMeta.titleTag}</h1>\n  <p class="meta-description">${titleMeta.description}</p>\n</div>\n`;
  // const fullContent = seoHeader + linkedHTML;
  //03.10.2026 replaced variables with below to prevent margin bleed
  let fullContent = linkedHTML;

  // ─── 5b. Whole-article structural review ──────────────────────────────────
  console.log('[Pipeline] Running whole-article structural review...');
  let reviewResult = { issues: [], fixed_article: '' };
  try {
    const reviewRaw = await callClaude(
      ...Object.values(parsePrompt(prompts['article-review'], {
        htmlContent: fullContent,
        template: template || 'practice',
        clientName: clientName || '',
        keyword: keyword || ''
      })),
      'claude-sonnet-4-6'
    );
    reviewResult = parseJSON(reviewRaw);

    if (reviewResult.issues && reviewResult.issues.length > 0) {
      console.log(`[Pipeline] Review found ${reviewResult.issues.length} issue(s):`);
      reviewResult.issues.forEach(issue => {
        console.log(`  - [${issue.type}] ${issue.description}`);
      });
      if (reviewResult.fixed_article) {
        fullContent = sanitizeReviewedHTML(reviewResult.fixed_article);
        // Re-run post-processing after review fixes (review may reintroduce issues)
        fullContent = enforceSingleH1(fullContent);
        fullContent = stripPlaceholders(fullContent, clientName);
        fullContent = stripLinksFromHeadings(fullContent);
        fullContent = fixMalformedH3(fullContent);
        fullContent = lockH1ToKeyword(fullContent, keyword);
        fullContent = enforceTaglineLength(fullContent);
        fullContent = stripForbiddenWords(fullContent);
        fullContent = deduplicateLinks(fullContent);
        fullContent = truncateFAQAnswers(fullContent);
        fullContent = splitLongParagraphs(fullContent);
        fullContent = stripDirectoryLinks(fullContent);
        fullContent = enforceAnchorTextLength(fullContent);
        fullContent = deduplicatePhrases(fullContent);
        fullContent = stripPhoneNumbers(fullContent);
        fullContent = fixCTALinks(fullContent, website);
        fullContent = capH3Density(fullContent);
        console.log('[Pipeline] Applied structural fixes from review');
      }
    } else {
      console.log('[Pipeline] Review passed — no structural issues found');
    }
  } catch (e) {
    console.error('Article review failed:', e.message);
    // Non-fatal — continue with original content
  }

  // ─── 5c. Targeted structural repair ────────────────────────────────────
  console.log('[Pipeline] Running targeted structural repair...');
  try {
    const repairResult = await repairStructuralIssues(fullContent, {
      template: template || 'practice',
      keyword,
      clientName,
      website,
      callClaude
    });
    if (repairResult.repairs.length > 0) {
      fullContent = repairResult.html;
      console.log(`[Pipeline] Structural repairs applied (${repairResult.repairs.length}):`);
      repairResult.repairs.forEach(r => console.log(`  ✓ ${r}`));
      // Re-run deterministic post-processing after repairs
      fullContent = enforceSingleH1(fullContent);
      fullContent = stripPlaceholders(fullContent, clientName);
      fullContent = stripLinksFromHeadings(fullContent);
      fullContent = fixMalformedH3(fullContent);
      fullContent = lockH1ToKeyword(fullContent, keyword);
      fullContent = enforceTaglineLength(fullContent);
      fullContent = stripForbiddenWords(fullContent);
      fullContent = deduplicateLinks(fullContent);
      fullContent = truncateFAQAnswers(fullContent);
      fullContent = splitLongParagraphs(fullContent);
      fullContent = stripDirectoryLinks(fullContent);
      fullContent = enforceAnchorTextLength(fullContent);
      fullContent = deduplicatePhrases(fullContent);
      fullContent = stripPhoneNumbers(fullContent);
      fullContent = fixCTALinks(fullContent, website);
      fullContent = capH3Density(fullContent);
    } else {
      console.log('[Pipeline] No structural repairs needed');
    }
  } catch (e) {
    console.error('Structural repair failed:', e.message);
    // Non-fatal — continue with current content
  }

  // ─── 6. Legal ethics compliance ───────────────────────────────────────────
  console.log('[Pipeline] Running legal compliance check...');
  let complianceResult = { violations: [], total: 0, categories: [] };
  try {
    const complianceRaw = await callClaude(
      ...Object.values(parsePrompt(prompts['legal-compliance'], { htmlContent: fullContent })),
      'claude-sonnet-4-6'
    );
    complianceResult = parseJSON(complianceRaw);
  } catch (e) {
    console.error('Compliance check failed:', e.message);
  }

  let { htmlContent: cleanedContent } = applyCompliance(fullContent, complianceResult);
  // Re-run post-processing after compliance fixes
  cleanedContent = enforceSingleH1(cleanedContent);
  cleanedContent = stripPlaceholders(cleanedContent, clientName);
  cleanedContent = stripLinksFromHeadings(cleanedContent);
  cleanedContent = fixMalformedH3(cleanedContent);
  cleanedContent = lockH1ToKeyword(cleanedContent, keyword);
  cleanedContent = enforceTaglineLength(cleanedContent);
  cleanedContent = stripForbiddenWords(cleanedContent);
  cleanedContent = deduplicateLinks(cleanedContent);
  cleanedContent = truncateFAQAnswers(cleanedContent);
  cleanedContent = splitLongParagraphs(cleanedContent);
  cleanedContent = stripDirectoryLinks(cleanedContent);
  cleanedContent = enforceAnchorTextLength(cleanedContent);
  cleanedContent = deduplicatePhrases(cleanedContent);
  cleanedContent = stripPhoneNumbers(cleanedContent);
  cleanedContent = fixCTALinks(cleanedContent, website);
  cleanedContent = capH3Density(cleanedContent);

  // ─── 6b. Validate external links and statute citations ────────────────────
  const externalLinkCount = countExternalLinks(cleanedContent);
  const hasStatutes = hasStatuteCitation(cleanedContent);
  if (externalLinkCount === 0) {
    console.warn('[Pipeline] ⚠ No external links after retry — editor must add manually');
  } else {
    console.log(`[Pipeline] External links: ${externalLinkCount}`);
  }
  if (!hasStatutes) {
    console.warn('[Pipeline] ⚠ No statute citation after repair attempt — editor must add manually');
  }

  // ─── 6c. Statute verification — check citations are plausible ──────────────
  if (hasStatutes) {
    try {
      const statuteCheckRaw = await callClaude(
        'You are a legal citation verifier. Check every statute citation in this article (anything with § or "Section" followed by numbers, or state code references). For each citation, determine if it appears to be a real, correctly cited statute for the jurisdiction. Return ONLY a JSON array of objects with: {"citation": "the exact citation", "status": "valid" or "suspicious", "reason": "brief explanation"}. If all citations look valid, return an empty array []. No prose, no code fences.',
        `Verify the statute citations in this article about "${keyword}":\n\n${cleanedContent}`,
        'claude-sonnet-4-6'
      );

      try {
        const statuteResults = parseJSON(statuteCheckRaw);
        const suspicious = (Array.isArray(statuteResults) ? statuteResults : []).filter(s => s.status === 'suspicious');
        if (suspicious.length > 0) {
          console.warn(`[Pipeline] ⚠ ${suspicious.length} suspicious statute citation(s) found:`);
          suspicious.forEach(s => {
            console.warn(`  - "${s.citation}": ${s.reason}`);
            // Remove the suspicious citation from the article — keep the legal concept, strip the number
            const escaped = s.citation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleanedContent = cleanedContent.replace(new RegExp(escaped, 'g'), (match) => {
              // Replace specific citation with general reference
              return match.replace(/§\s*[\d.-]+|Section\s+[\d.-]+/gi, '').replace(/\s{2,}/g, ' ').trim();
            });
          });
          formatResult.warnings = formatResult.warnings || [];
          formatResult.warnings.push(`Removed ${suspicious.length} suspicious statute citation(s) — editor should verify and add correct references`);
        } else {
          console.log('[Pipeline] Statute citations verified');
        }
      } catch (parseErr) {
        console.warn('[Pipeline] Could not parse statute verification response — skipping');
      }
    } catch (err) {
      console.warn('[Pipeline] Statute verification failed:', err.message);
    }
  }

  // ─── 7. Format check + auto-fix ──────────────────────────────────────────
  console.log('[Pipeline] Running format checker...');
  const formatResult = checkAndFixFormat(cleanedContent, { keyword, website, template, clientInfo });
  if (formatResult.fixes.length > 0) {
    console.log(`[Pipeline] Format auto-fixes applied: ${formatResult.fixes.join(', ')}`);
    cleanedContent = formatResult.html;
  }
  // Add external link and statute warnings to format warnings (pipeline tried to fix these — warning means it couldn't)
  if (externalLinkCount === 0) {
    formatResult.warnings.push('REQUIRED: No external links to authoritative sources — pipeline retry failed, editor must add 2-3 manually');
  }
  if (!hasStatutes) {
    formatResult.warnings.push('REQUIRED: No jurisdiction-specific statute citations — pipeline repair failed, editor must add at least one');
  }

  // Cross-article duplicate check (gated by CROSS_ARTICLE_DUPE_CHECK env var,
  // default off). Surfaces verbatim/near-verbatim sentences shared with recent
  // articles for the same client — the May 2026 Dostart/Sabbeth pattern.
  try {
    const dupeWarnings = await checkCrossArticleDuplicates(cleanedContent, clientName, articleId);
    dupeWarnings.forEach(w => formatResult.warnings.push(w));
  } catch (e) {
    console.warn('[Pipeline] cross-article dupe check threw — skipping:', e.message);
  }

  if (formatResult.warnings.length > 0) {
    console.log(`[Pipeline] Format warnings (${formatResult.warnings.length}):`);
    formatResult.warnings.forEach(w => console.log(`  ⚠ ${w}`));
  } else {
    console.log('[Pipeline] Format check passed — no issues found');
  }

  // ─── 8. Parallel: schema + slug ────────────────────────────────────────────
  console.log('[Pipeline] Generating schema and slug in parallel...');
  const [schemaRaw, slugRaw] = await Promise.all([
    callClaude(
      ...Object.values(parsePrompt(prompts['schema-generator'], { htmlContent: cleanedContent })),
      'claude-haiku-4-5-20251001'
    ).catch(err => { console.error('Schema failed:', err.message); return ''; }),

    callClaude(
      ...Object.values(parsePrompt(prompts['slug-url'], { website, content: cleanedContent })),
      'claude-haiku-4-5-20251001'
    ).catch(err => { console.error('Slug failed:', err.message); return '{"articleTitle":"","urlSlug":"","pageUrl":""}'; })
  ]);

  let schema = null;
  let slugData = { articleTitle: '', urlSlug: '', pageUrl: '' };
  try { schema = schemaRaw; } catch (e) { console.error('Schema parse failed:', e.message); }
  try { slugData = parseJSON(slugRaw); } catch (e) { console.error('Slug parse failed:', e.message); }

  // ─── 8. Score final article ────────────────────────────────────────────────
  const scores = scoreArticle(cleanedContent);

  // ─── 9. Upsert to Supabase ────────────────────────────────────────────────
  const skipPublish = process.env.SKIP_PUBLISH === '1';
  if (skipPublish) {
    console.log('[Pipeline] SKIP_PUBLISH=1 — writing HTML to test-output/ instead');
    const outputDir = path.join(__dirname, 'test-output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(outputDir, `${articleId}.html`), cleanedContent);
    console.log(`[Pipeline] Saved: test-output/${articleId}.html`);
  }
  const articleRecord = {
    received_article: {
      content: cleanedContent,
      title: titleMeta.titleTag || null,
      meta: titleMeta.description || null,
      receivedAt: new Date().toISOString()
    },
    id: Math.random().toString(36).substring(2, 12),
    client_id: clientId,
    keyword,
    client_name: clientName,
    article_id: articleId,
    sections: sections,
    Schema: schema,
    template: template || null,
    'word count': scores.wordCount,
    'flesch score': scores.fleschScore,
    'Page URL': slugData.pageUrl,
    'URL Slug': slugData.urlSlug,
    user_id: userId,
    'cleaned content': cleanedContent,
    title_tag: titleMeta.titleTag || null,
    meta_description: titleMeta.description || null,
    version: `V${require('./package.json').version}`,
    format_warnings: formatResult.warnings.length > 0 ? formatResult.warnings : null
  };

  // ─── 9a. Quality gate — block upsert if article is broken ─────────────────
  const qc = qualityGate(cleanedContent, sections, template, scores.wordCount, formatResult.warnings);
  if (!qc.pass) {
    console.error(`[Pipeline] ✗ QUALITY GATE FAILED for articleId=${articleId}:`);
    qc.issues.forEach(i => console.error(`  - ${i}`));
    console.error(`[Pipeline] Reason: ${qc.reason} — skipping Supabase upsert`);
  } else {
    if (qc.issues.length > 0) {
      console.log(`[Pipeline] Quality gate passed with warnings:`);
      qc.issues.forEach(i => console.log(`  ⚠ ${i}`));
    }
  }

  let supabaseError = null;
  if (!qc.pass) {
    supabaseError = `Quality gate failed: ${qc.reason}`;
  } else if (!skipPublish) {
    try {
      await upsertArticle(articleRecord);
      console.log('[Pipeline] Supabase upsert success');
    } catch (err) {
      supabaseError = err.message;
      console.error('[Pipeline] Supabase upsert failed:', err.message);
    }
  } else {
    console.log('[Pipeline] Skipping Supabase upsert (SKIP_PUBLISH=1)');
  }

  // ─── 10. Publish to internal.goconstellation.com ─────────────────────────
  let publishedUrl = null;
  if (!skipPublish) {
    try {
      publishedUrl = await publishArticle({
      articleId,
      clientName,
      keyword,
      slug: slugData.urlSlug || articleId,
      htmlContent: cleanedContent,
      fleschScore: scores.fleschScore,
      wordCount: scores.wordCount,
      pageUrl: slugData.pageUrl,
      userId
    });
    } catch (err) {
      console.error('[Pipeline] Publish failed:', err.message);
    }
  } else {
    console.log('[Pipeline] Skipping publish (SKIP_PUBLISH=1)');
  }

  // ─── 11. Auto-translate to all languages (fire-and-forget) ────────────────
  // Generate ES + VI in the background so translations are ready without an
  // editor clicking "Translate". Non-blocking and fully isolated: a translation
  // failure must never affect article generation. NOTE: this translates the
  // freshly generated draft — substantial later editor edits should be
  // re-translated (the backfill script re-runs the current content).
  if (!skipPublish && !supabaseError) {
    for (const lang of ['es', 'vi']) {
      runTranslation(articleId, lang)
        .then(() => console.log(`[Pipeline] Auto-translated ${articleId} -> ${lang}`))
        .catch((err) =>
          console.error(`[Pipeline] Auto-translate ${lang} failed for ${articleId}:`, err.message),
        );
    }
  }

  return {
    articleId,
    keyword,
    wordCount: scores.wordCount,
    fleschScore: scores.fleschScore,
    pageUrl: slugData.pageUrl,
    urlSlug: slugData.urlSlug,
    supabaseError,
    publishedUrl,
    table: process.env.SUPABASE_TABLE || 'article_outlines',
    articleRecord,
  };
}

module.exports = { runPipeline, enforceTaglineLength };
