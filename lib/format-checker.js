'use strict';

/**
 * Post-generation format checker.
 * Validates compiled HTML for common formatting issues and returns
 * a list of warnings. Optionally auto-fixes what it can.
 *
 * @param {string} html - Compiled article HTML
 * @param {object} options - Optional context
 * @param {string} options.keyword - Article keyword
 * @param {string} options.website - Client website URL
 * @param {string} options.template - Page type (practice, supporting, etc.)
 * @returns {{ warnings: string[], fixes: string[], html: string }}
 */
function checkAndFixFormat(html, options = {}) {
  const warnings = [];
  const fixes = [];
  let fixed = html;

  // ─── 1. Unclosed <strong> tags ──────────────────────────────────────────
  const openStrong = (fixed.match(/<strong>/g) || []).length;
  const closeStrong = (fixed.match(/<\/strong>/g) || []).length;
  if (openStrong > closeStrong) {
    warnings.push(`Unclosed <strong> tags: ${openStrong} open vs ${closeStrong} close`);
    // Auto-fix: close them at the end of the paragraph they're in
    fixed = fixed.replace(/<strong>([^<]*?)(<\/p>|<\/li>|<\/h[1-6]>)/g, (match, content, closer) => {
      if (!match.includes('</strong>')) {
        fixes.push('Auto-closed unclosed <strong> tag');
        return `<strong>${content}</strong>${closer}`;
      }
      return match;
    });
  }

  // ─── 2. Stray horizontal rules ─────────────────────────────────────────
  const hrMatches = fixed.match(/<p>\s*[-*]{3,}\s*<\/p>/g);
  if (hrMatches) {
    warnings.push(`Found ${hrMatches.length} horizontal rule(s) rendered as paragraphs`);
    fixed = fixed.replace(/<p>\s*[-*]{3,}\s*<\/p>/g, '');
    fixes.push(`Removed ${hrMatches.length} stray horizontal rule(s)`);
  }

  // ─── 3. Broken ordered lists (consecutive <ol> with single items) ──────
  const singleItemOls = fixed.match(/<ol>\s*<li>[^<]*<\/li>\s*<\/ol>/g);
  if (singleItemOls && singleItemOls.length > 1) {
    // Check for consecutive single-item <ol> tags and merge them
    const before = fixed;
    fixed = fixed.replace(
      /(<ol>\s*<li>[^<]*<\/li>\s*<\/ol>\s*){2,}/g,
      (match) => {
        const items = [];
        match.replace(/<li>([^<]*)<\/li>/g, (_, content) => {
          items.push(content);
        });
        return '<ol>\n' + items.map(item => `<li>${item}</li>`).join('\n') + '\n</ol>';
      }
    );
    if (fixed !== before) {
      fixes.push('Merged consecutive single-item ordered lists into proper <ol>');
    }
    warnings.push(`Found ${singleItemOls.length} consecutive single-item <ol> tags (likely a broken numbered list)`);
  }

  // ─── 4. Word count check ───────────────────────────────────────────────
  // Strip HTML tags, count words
  const textOnly = fixed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const wordCount = textOnly.split(/\s+/).length;

  // Find FAQ section and estimate its word count
  const faqMatch = fixed.match(/<h[23]>[^<]*FAQ[^<]*<\/h[23]>([\s\S]*?)(?=<h2>|$)/i);
  const faqText = faqMatch ? faqMatch[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const faqWordCount = faqText ? faqText.split(/\s+/).length : 0;
  const bodyWordCount = wordCount - faqWordCount;

  if (bodyWordCount < 1000) {
    warnings.push(`Body word count is ${bodyWordCount} (minimum 1,000) — FAQ: ${faqWordCount} words`);
  }

  // ─── 5. Introduction length check ──────────────────────────────────────
  // Removed — structural repair step 3 already expands short intros via Claude

  // ─── 6. H3 density check ──────────────────────────────────────────────
  // Split by H2 sections and count H3s in each
  const h2Sections = fixed.split(/<h2>/);
  for (let i = 1; i < h2Sections.length; i++) {
    const section = h2Sections[i];
    const sectionTitle = (section.match(/^([^<]*)<\/h2>/) || [])[1] || `Section ${i}`;
    const h3Count = (section.match(/<h3>/g) || []).length;
    // The new richer Why Choose Us / What to Expect briefs ask for 3–5 H3s.
    // Threshold raised from >3 to >5 to match the brief's allowed range.
    if (h3Count > 5) {
      warnings.push(`Section "${sectionTitle}" has ${h3Count} H3 sub-headings (max 5 recommended)`);
    }
  }

  // ─── 7. Internal link check ────────────────────────────────────────────
  if (options.website) {
    const domain = options.website.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const internalLinkRegex = new RegExp(`href="[^"]*${domain.replace(/\./g, '\\.')}[^"]*"`, 'g');
    const internalLinks = fixed.match(internalLinkRegex) || [];
    if (internalLinks.length < 3) {
      warnings.push(`Only ${internalLinks.length} internal link(s) to ${domain} (minimum 3)`);
    }
  }

  // ─── 8. Multiple H1 tags ──────────────────────────────────────────────
  // Removed — enforceSingleH1() already runs 4 times in the pipeline
  const h1Count = (fixed.match(/<h1>/g) || []).length;
  if (h1Count === 0) {
    warnings.push('No H1 tag found');
  }

  // ─── 9. Bold entire paragraphs — auto-fix ──────────────────────────────
  // A paragraph where the entire content is wrapped in <strong> and over 100 chars
  // is almost always a formatting error — strip the bold wrapper, keep the text
  const boldParaCount = (fixed.match(/<p>\s*<strong>[^<]{100,}<\/strong>\s*<\/p>/g) || []).length;
  if (boldParaCount > 0) {
    fixed = fixed.replace(/<p>\s*<strong>([^<]{100,})<\/strong>\s*<\/p>/g, '<p>$1</p>');
    fixes.push(`Removed bold from ${boldParaCount} entirely-bold paragraph(s)`);
  }

  // ─── 10. Links in headings ─────────────────────────────────────────────
  // Removed — stripLinksFromHeadings() already runs 4 times in the pipeline

  // ─── 11. Client info quality check ─────────────────────────────────────
  // Practice pages depend on rich clientInfo to populate Why Choose Us with
  // specific differentiators (attorney names, years, focus areas, geographic
  // coverage). When clientInfo is empty or thin, the section-writer either
  // skips Why Choose Us depth or fills it with generic boilerplate, both of
  // which editors then expand by hand. Surface this signal pre-publish so
  // editors know to expect a sparse Why Choose Us before they open the article.
  if (options.clientInfo !== undefined) {
    const infoLength = (options.clientInfo || '').length;
    const isPracticeContext = !options.template || /practice/i.test(options.template);
    if (infoLength === 0) {
      warnings.push('Client info is empty — Why Choose Us and What to Expect sections will be generic and need manual review');
    } else if (isPracticeContext && infoLength < 250) {
      warnings.push(`Client info is sparse (${infoLength} chars) — practice pages need 250+ chars of attorney names, years, focus areas, and service area for Why Choose Us depth. Expect a shallow section here.`);
    }
  }

  // ─── 12. Required sections check (practice pages) ─────────────────────
  // Heading-text regex checks were removed: contextual, reader-facing H2s
  // (per the loosened section-writer prompt) won't match rigid regex like
  // /how we can help/ or /why choose/, so these produced consistent false
  // positives. Required-section coverage is enforced at generation time by
  // prompts/section-writer.md + the Supabase template. As a lightweight
  // structural sanity check we still flag practice pages with an unusually
  // low number of H2s, since that's a reliable "something is missing" signal.
  const isPracticePage = !options.template || /practice/i.test(options.template);
  if (isPracticePage) {
    const h2Count = (fixed.match(/<h2[^>]*>/gi) || []).length;
    // Under the current template, the Introduction shares the H1 section and
    // does NOT get its own H2. So a fully-formed practice page lands at
    // exactly 5 H2s: How We Can Help, Why Choose Us, What to Expect, CTA,
    // FAQ. Anything under 5 is missing one of those required sections.
    if (h2Count < 5) {
      warnings.push(`Only ${h2Count} H2 section(s) — practice pages should have 5 (How We Can Help, Why Choose Us, What to Expect, CTA, FAQ). Article is missing required sections.`);
    }
  }

  // ─── 13. Firm name in body on supporting pages ────────────────────────
  const isSupportingPage = options.template && /supporting|resource/i.test(options.template);
  if (isSupportingPage && options.clientInfo) {
    // Check if firm name appears in body sections (not CTA)
    // SOP: supporting pages must NOT mention firm in body sections
    // This is a warning — the structural repair already skips firm name insertion
  }

  // ─── 14. Scaffold / brief text leaking into published body ─────────────
  // The section-writer prompt instructs the model to paraphrase the section
  // brief into a contextual H2 and body. Sometimes the model emits the brief
  // text verbatim instead. These literal strings are unmistakable scaffolding
  // — if they reach format-check, an editor will see them as published copy.
  // Treat as a critical warning and surface to qualityGate via the dedicated
  // marker prefix `SCAFFOLD:`.
  const SCAFFOLD_TOKENS = [
    /\bCTA\s*\/\s*Conclusion\b/i,
    /\bSoft\s+CTA\b/i,
    /\bShort\s+introduction\b/i,
    /\bShort\s+intro\b/i,
    // Broadened from "Verify or remove this citation" — observed leak in
    // batch smoke test was "Verify or remove the specific section number"
    // which the narrower regex missed. "Verify or remove" is editor-note
    // phrasing that should never appear in published copy.
    /\bVerify\s+or\s+remove\b/i,
    // Same shape — "confirm the controlling code section before citing" is
    // editor-note boilerplate that leaked alongside the verify-or-remove
    // text in the smoke article.
    /\bconfirm\s+the\s+(controlling|exact|specific)\s+(code|section|statute)/i,
    /\[Internal\s+note\]/i,
    /\bInternal\s+note:/i,
    /<!--\s*Issue/i,
  ];
  for (const pattern of SCAFFOLD_TOKENS) {
    const match = fixed.match(pattern);
    if (match) {
      warnings.push(`SCAFFOLD: Brief/scaffold text "${match[0].trim()}" appears in article body — pipeline did not paraphrase`);
    }
  }

  // ─── 14b. Why Choose Us depth — practice pages only ───────────────────
  // Per section-writer.md, supporting pages must NOT have a Why Choose Us
  // section, but practice pages MUST include 3+ specific differentiators
  // (credentials, years, focus, geographic coverage, results). Editors have
  // expanded sparse Why Choose Us sections from one H3 up to 5–6 H3s during
  // edit. Flag practice-page Why Choose Us that ships shallow so the editor
  // sees it in admin and we can audit upstream.
  if (isPracticePage) {
    // Find a Why Choose Us section — H2 text matches the SOP-required label
    // OR a paraphrase containing "why" + ("choose"|"us"|firm-name fragments).
    // Be conservative — only run depth check if we clearly identify the section.
    const sections = fixed.split(/<h2[^>]*>/i);
    let whyChooseSection = null;
    for (let i = 1; i < sections.length; i++) {
      const headingMatch = sections[i].match(/^([\s\S]*?)<\/h2>/i);
      if (!headingMatch) continue;
      const heading = headingMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      if (/^why\s+(choose|hire|work\s+with|select|trust)\b/i.test(heading)
          || /\b(stands?\s+out|sets\s+(this|us|our\s+firm)\s+apart|reasons\s+to\s+choose)\b/i.test(heading)) {
        // Take section content up to next H2 (or end)
        const sectionEnd = sections[i].indexOf('<h2', headingMatch[0].length);
        whyChooseSection = sectionEnd > -1
          ? sections[i].slice(0, sectionEnd)
          : sections[i];
        break;
      }
    }
    if (whyChooseSection) {
      const h3Count = (whyChooseSection.match(/<h3[^>]*>/gi) || []).length;
      const sectionWords = whyChooseSection.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).length;
      // Thresholds reflect the editor expansion pattern observed: editors
      // routinely add 4–6 H3s and grow the section to 200+ words. Anything
      // sparser than 3 H3s OR 200 words is shipping below SOP.
      if (h3Count < 3) {
        warnings.push(`"Why Choose Us" section has only ${h3Count} H3 sub-heading(s) — practice pages should have 3+ differentiator sub-points (credentials, focus, geographic coverage, results)`);
      }
      if (sectionWords < 200) {
        warnings.push(`"Why Choose Us" section is only ${sectionWords} words — practice pages should have 200+ words of specific firm differentiators`);
      }
    }
  }

  // ─── 15. Generic / template H2 titles ──────────────────────────────────
  // Section briefs include generic working titles like "Key Information" and
  // "Additional Context" that the section-writer prompt tells Claude to rewrite
  // into a topic-specific H2. When the model emits the brief title verbatim it
  // ships an unmistakably templated heading. Flag every case so editors see
  // the warning in admin and we can audit upstream prompt compliance.
  const GENERIC_H2_PATTERNS = [
    /^Key Information$/i,
    /^Additional Context$/i,
    /^Get Legal Guidance$/i,
    /^Soft CTA$/i,
    /^CTA\s*\/\s*Conclusion$/i,
    /^Overview$/i,
    /^Background$/i,
    /^Introduction$/i,
    /^Conclusion$/i,
  ];
  const h2Iter = fixed.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi);
  for (const m of h2Iter) {
    const text = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (GENERIC_H2_PATTERNS.some(p => p.test(text))) {
      warnings.push(`SCAFFOLD: Generic H2 "${text}" — section-writer should have replaced this with a contextual heading`);
    }
  }

  // ─── 16. Tagline must be followed by an H2 ─────────────────────────────
  // Section 1 emits ONLY H1 + tagline (per section-writer prompt); section 2
  // owns the first H2 + intro body. May 2026 editor feedback surfaced ~20
  // articles where section 1 emitted H1 + tagline + intro body, leaving no
  // H2 between the tagline and the body. Flag it so editors see the warning
  // and we can audit upstream prompt compliance (same pattern as the generic
  // H2 check above — warn, don't auto-fix).
  const taglineRegex = /<p[^>]*>\s*(?:<[^>]+>\s*)*<strong>([\s\S]*?)<\/strong>(?:\s*<\/[^>]+>)*\s*<\/p>/i;
  const taglineMatch = fixed.match(taglineRegex);
  if (taglineMatch) {
    const taglineEnd = taglineMatch.index + taglineMatch[0].length;
    const afterTagline = fixed.slice(taglineEnd).replace(/^\s+/, '');
    if (!/^<h2[\s>]/i.test(afterTagline)) {
      const peek = afterTagline.slice(0, 80).replace(/\s+/g, ' ');
      warnings.push(`STRUCTURE: No <h2> follows the tagline — section 1 should emit only H1 + tagline, with section 2's H2 next. Got: "${peek}..."`);
    }
  }

  return { warnings, fixes, html: fixed };
}

module.exports = { checkAndFixFormat };
