'use strict';

/**
 * Targeted structural repair pass.
 * Detects specific structural defects in compiled HTML and makes
 * focused Claude calls to fix only the broken piece.
 *
 * Runs after the article-review pass. Only makes API calls when
 * issues are actually found — no cost if article is clean.
 *
 * @param {string} html - Compiled article HTML
 * @param {object} options
 * @param {string} options.template - Page type (practice, supporting)
 * @param {string} options.keyword - Article keyword
 * @param {string} options.clientName - Client name
 * @param {string} options.website - Client website URL
 * @param {function} options.callClaude - Reference to pipeline's callClaude function
 * @returns {Promise<{ html: string, repairs: string[] }>}
 */
async function repairStructuralIssues(html, options = {}) {
  const repairs = [];
  let fixed = html;

  // ─── 1. H2 immediately followed by H3 with no intro paragraph ─────────
  // Detect all instances, repair each with a targeted Haiku call
  const h2h3Regex = /(<h2>([\s\S]*?)<\/h2>)\s*(<h3>)/gi;
  let h2h3Match;
  const h2h3Gaps = [];

  while ((h2h3Match = h2h3Regex.exec(fixed)) !== null) {
    h2h3Gaps.push({
      fullMatch: h2h3Match[0],
      h2Tag: h2h3Match[1],
      h2Text: h2h3Match[2].replace(/<[^>]+>/g, '').trim(),
      h3Tag: h2h3Match[3],
      index: h2h3Match.index
    });
  }

  if (h2h3Gaps.length > 0) {
    for (const gap of h2h3Gaps) {
      // Extract the full section content after this H2 to give Claude context
      const sectionStart = fixed.indexOf(gap.fullMatch);
      const nextH2 = fixed.indexOf('<h2>', sectionStart + gap.fullMatch.length);
      const sectionEnd = nextH2 > -1 ? nextH2 : fixed.length;
      const sectionContent = fixed.slice(sectionStart, sectionEnd);

      let bridgeInserted = false;

      // Try Claude-generated bridge first
      if (options.callClaude) {
        try {
          const bridgeText = await options.callClaude(
            'You write 1-2 introductory sentences for a law firm article section. Match the tone and style of the surrounding content. Output ONLY the 1-2 sentences — no headings, no HTML tags, no explanation.',
            `This section is titled "${gap.h2Text}" in an article about "${options.keyword || 'legal services'}" for ${options.clientName || 'a law firm'}.\n\nThe section content that follows the heading:\n${sectionContent}\n\nWrite 1-2 sentences that introduce this section before the sub-headings begin.`,
            'claude-haiku-4-5-20251001'
          );

          if (bridgeText && bridgeText.length > 10 && bridgeText.length < 500) {
            const cleanBridge = bridgeText.replace(/<[^>]+>/g, '').trim();
            fixed = fixed.replace(
              gap.fullMatch,
              `${gap.h2Tag}\n<p>${cleanBridge}</p>\n${gap.h3Tag}`
            );
            repairs.push(`Added intro paragraph for "${gap.h2Text}" section`);
            bridgeInserted = true;
          }
        } catch (err) {
          console.error(`[Repair] Claude failed for "${gap.h2Text}":`, err.message);
        }
      }

      // Deterministic fallback — generate a generic bridge from the section title
      if (!bridgeInserted) {
        const keyword = options.keyword || 'this topic';
        const fallback = `Here are key things to know about ${gap.h2Text.toLowerCase()}.`;
        fixed = fixed.replace(
          gap.fullMatch,
          `${gap.h2Tag}\n<p>${fallback}</p>\n${gap.h3Tag}`
        );
        repairs.push(`Added fallback intro for "${gap.h2Text}" section (Claude unavailable)`);
      }
    }
  }

  // ─── 2. CTA section too short on practice pages ────────────────────────
  if (options.template && options.template.toLowerCase().includes('practice') && options.callClaude) {
    const h2Parts = fixed.split(/<h2>/i);
    for (let i = h2Parts.length - 1; i >= 1; i--) {
      const part = h2Parts[i];
      const heading = (part.match(/^([^<]*)<\/h2>/) || [])[1] || '';
      if (/FAQ|Frequently/i.test(heading)) continue;

      // This is the CTA section (last non-FAQ H2)
      const ctaText = part.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const ctaWords = ctaText.split(/\s+/).length;

      if (ctaWords < 100) {
        // Extract the full CTA section HTML
        const ctaSectionStart = fixed.lastIndexOf('<h2>' + heading);
        if (ctaSectionStart === -1) break;

        // Find where this section ends (next H2 or end of content)
        const afterStart = fixed.indexOf('</h2>', ctaSectionStart) + 5;
        const nextH2 = fixed.indexOf('<h2>', afterStart);
        const ctaSectionEnd = nextH2 > -1 ? nextH2 : fixed.length;
        const ctaSectionHTML = fixed.slice(ctaSectionStart, ctaSectionEnd);

        try {
          const contactUrl = options.website ? `${options.website.replace(/\/+$/, '')}/contact` : '';
          const expandedCTA = await options.callClaude(
            'You expand a CTA (call-to-action) section for a law firm practice page. Output ONLY the expanded HTML — keep the existing H2 heading, expand the body to ~100-150 words. Include a link to the contact page. Use <p> tags for paragraphs. No explanation, no code fences.',
            `Expand this CTA section to ~100-150 words. The firm is ${options.clientName || 'the firm'}, the article is about "${options.keyword || 'legal services'}". The contact page URL is: ${contactUrl}\n\nCurrent CTA section HTML:\n${ctaSectionHTML}`,
            'claude-haiku-4-5-20251001'
          );

          if (expandedCTA && expandedCTA.includes('<h2>')) {
            const expandedText = expandedCTA.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const expandedWords = expandedText.split(/\s+/).length;
            // Only use if it's actually longer and not absurdly long
            if (expandedWords >= 80 && expandedWords <= 300) {
              fixed = fixed.slice(0, ctaSectionStart) + expandedCTA + fixed.slice(ctaSectionEnd);
              repairs.push(`Expanded CTA section from ${ctaWords} to ~${expandedWords} words`);
            }
          }
        } catch (err) {
          console.error('[Repair] Failed to expand CTA:', err.message);
        }
      }
      break;
    }
  }

  // ─── 3. Intro under 3 paragraphs ──────────────────────────────────────
  if (options.callClaude) {
    const introMatch = fixed.match(/(<h1>[^<]*<\/h1>)([\s\S]*?)(<h2>)/i);
    if (introMatch) {
      const introContent = introMatch[2];
      const introParagraphs = (introContent.match(/<p>/gi) || []).length;

      if (introParagraphs > 0 && introParagraphs < 3) {
        try {
          const expandedIntro = await options.callClaude(
            'You expand a law firm article introduction to have at least 3 full paragraphs. Keep the existing tagline (bold standalone phrase) if present. Keep all existing content — add new paragraphs to reach 3 total. Output ONLY the intro HTML between the H1 and the first H2 — no H1, no H2, no explanation, no code fences. Use <p> tags.',
            `This introduction for "${options.keyword || 'legal services'}" by ${options.clientName || 'a law firm'} only has ${introParagraphs} paragraph(s). Expand it to at least 3 paragraphs while keeping all existing content.\n\nCurrent intro HTML (between H1 and first H2):\n${introContent}`,
            'claude-haiku-4-5-20251001'
          );

          if (expandedIntro) {
            const newParaCount = (expandedIntro.match(/<p>/gi) || []).length;
            // Only use if it actually has more paragraphs and isn't garbage
            if (newParaCount >= 3 && expandedIntro.length > introContent.length * 0.8) {
              fixed = fixed.replace(
                introMatch[1] + introMatch[2] + introMatch[3],
                introMatch[1] + '\n' + expandedIntro + '\n' + introMatch[3]
              );
              repairs.push(`Expanded introduction from ${introParagraphs} to ${newParaCount} paragraphs`);
            }
          }
        } catch (err) {
          console.error('[Repair] Failed to expand introduction:', err.message);
        }
      }
    }
  }

  // ─── 4. Firm name missing from first 100 words (practice pages only) ────
  // SOP: supporting pages must NOT mention the firm by name in body sections
  const isSupportingPage = options.template && /supporting|resource/i.test(options.template);
  if (options.clientName && options.callClaude && !isSupportingPage) {
    const introMatch2 = fixed.match(/(<h1>[^<]*<\/h1>)([\s\S]*?)(<h2>)/i);
    if (introMatch2) {
      const introText = introMatch2[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const first100Words = introText.split(/\s+/).slice(0, 100).join(' ');

      if (!first100Words.toLowerCase().includes(options.clientName.toLowerCase())) {
        // Find the first <p> in the intro and ask Haiku to rewrite it with the firm name
        const firstParaMatch = introMatch2[2].match(/<p>([\s\S]*?)<\/p>/i);
        if (firstParaMatch) {
          try {
            const rewrittenPara = await options.callClaude(
              'You rewrite a single paragraph from a law firm article introduction. Your ONLY job is to naturally weave the firm name into the paragraph. Keep the same meaning, length, and tone. Output ONLY the rewritten paragraph text — no <p> tags, no HTML, no explanation.',
              `Rewrite this paragraph to naturally include the firm name "${options.clientName}" within the first 1-2 sentences. The article is about "${options.keyword || 'legal services'}" and the firm is located at ${options.website || 'their website'}.\n\nParagraph:\n${firstParaMatch[1]}`,
              'claude-haiku-4-5-20251001'
            );

            if (rewrittenPara && rewrittenPara.length > 20 && rewrittenPara.length < firstParaMatch[1].length * 2) {
              const cleanRewrite = rewrittenPara.replace(/<[^>]+>/g, '').trim();
              if (cleanRewrite.toLowerCase().includes(options.clientName.toLowerCase())) {
                fixed = fixed.replace(firstParaMatch[0], `<p>${cleanRewrite}</p>`);
                repairs.push(`Added firm name "${options.clientName}" to introduction`);
              }
            }
          } catch (err) {
            console.error('[Repair] Failed to add firm name to intro:', err.message);
          }
        }
      }
    }
  }

  // ─── 5. Missing statute citation ───────────────────────────────────────
  // SOP requires jurisdiction-specific statutes. If none found, ask Claude to add one.
  // Edit-mode optimizations opt out: the page being edited had no citation, and
  // preserving its substance beats the new-article SOP (skipStatute option).
  if (options.callClaude && options.keyword && !options.skipStatute) {
    const textOnly = fixed.replace(/<[^>]+>/g, ' ');
    // Hard citation patterns — a real statute reference like "O.C.G.A. § 40-6-391".
    const statutePatterns = [
      /§\s*[\d]/, /\bSection\s+\d+[\d.()-]*/i, /\bCode\s+§/i,
      /\bChapter\s+\d+/i, /\bTitle\s+\d+/i, /\d+\s+U\.S\.C\./i,
      /\bO\.C\.G\.A\.\s*§/i, /\bRev\.\s*Stat\./i, /\bPenal\s+Code\s+§/i,
      /\bVeh\.\s*Code\s+§/i, /\bFam\.\s*Code\s+§/i, /\bCiv\.\s*Code\s+§/i,
      /\bAnn\.\s*Code\s+§/i,
    ];
    // Qualified-jurisdiction-reference patterns — the fallback the prompts at
    // section-writer.md and the repair prompt below explicitly invite when the
    // model is not confident about an exact statute number (e.g., "Under
    // Michigan employment law", "pursuant to Texas family code", "as outlined
    // in California labor regulations"). These are not hard citations, but the
    // prompts treat them as the correct fallback — the validator must accept
    // them so we stop silently rejecting valid prompted output.
    const jurisdictionRefPatterns = [
      /\bUnder\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\s+(?:law|code|statutes?|regulations?|rules?)\b/,
      /\bpursuant\s+to\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\s+(?:law|code|statutes?|regulations?)\b/i,
      /\bas\s+outlined\s+in\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?\s+(?:law|code|statutes?|regulations?)\b/i,
      /\b[A-Z][a-zA-Z]+\s+(?:state\s+)?(?:employment|family|criminal|civil|tax|labor|insurance|tort|property|estate|probate|bankruptcy|immigration)\s+law\b/,
    ];
    const hasStatute = statutePatterns.some(p => p.test(textOnly))
      || jurisdictionRefPatterns.some(p => p.test(textOnly));

    if (!hasStatute) {
      // Find the best section to insert a statute — prefer "What to Expect" or the longest body section
      const h2Parts = fixed.split(/<h2>/i);
      let bestSection = null;
      let bestSectionIdx = -1;
      let bestLength = 0;

      for (let i = 1; i < h2Parts.length; i++) {
        const heading = (h2Parts[i].match(/^([^<]*)<\/h2>/) || [])[1] || '';
        if (/FAQ|Frequently/i.test(heading)) continue;
        const sectionText = h2Parts[i].replace(/<[^>]+>/g, ' ').trim();
        const sectionWords = sectionText.split(/\s+/).length;

        // Prefer "What to Expect" or process-related sections
        if (/expect|process|how|step|work/i.test(heading)) {
          bestSection = heading;
          bestSectionIdx = i;
          break;
        }
        if (sectionWords > bestLength) {
          bestLength = sectionWords;
          bestSection = heading;
          bestSectionIdx = i;
        }
      }

      if (bestSection && bestSectionIdx > 0) {
        try {
          const statuteText = await options.callClaude(
            'You add a specific statute or code citation to a law firm article paragraph. Identify the jurisdiction from the keyword and add ONE specific, real statute reference. CRITICAL: Only cite statutes you are 100% certain exist. Use the full official citation format. If you are not confident about the exact statute number, reference the legal concept generally (e.g., "Under Michigan employment law" or "as outlined in state labor regulations") instead of fabricating a citation. Use qualified language — "under", "as outlined in", "pursuant to" — never absolute language like "ensures" or "guarantees". Output ONLY one rewritten paragraph — no explanation, no HTML tags, no code fences.',
            `The article is about "${options.keyword}" for ${options.clientName || 'a law firm'}. The section "${bestSection}" has no specific statute citations. Find the most relevant paragraph and rewrite it to include a jurisdiction-specific legal reference. ONLY use a specific statute number if you are certain it is correct. Otherwise, reference the applicable area of law generally.\n\nSection content:\n<h2>${h2Parts[bestSectionIdx]}`,
            'claude-haiku-4-5-20251001'
          );

          if (statuteText && statuteText.length > 30 && statuteText.length < 1000) {
            const cleanStatute = statuteText.replace(/<[^>]+>/g, '').trim();
            // Accept either a hard citation OR the qualified jurisdiction-reference
            // fallback the prompt above explicitly invites. The previous version
            // accepted only hard citations, which silently rejected the prompt's
            // own fallback wording and shipped the article without any reference.
            const hasHardCitation = statutePatterns.some(p => p.test(cleanStatute));
            const hasJurisdictionRef = jurisdictionRefPatterns.some(p => p.test(cleanStatute));
            if (hasHardCitation || hasJurisdictionRef) {
              // Find the first <p> in the target section and replace it
              const sectionStart = fixed.indexOf('<h2>' + h2Parts[bestSectionIdx].split('</h2>')[0] + '</h2>');
              if (sectionStart > -1) {
                const afterH2 = fixed.indexOf('</h2>', sectionStart) + 5;
                const firstPara = fixed.indexOf('<p>', afterH2);
                const firstParaEnd = fixed.indexOf('</p>', firstPara) + 4;
                if (firstPara > -1 && firstParaEnd > firstPara) {
                  fixed = fixed.slice(0, firstPara) + `<p>${cleanStatute}</p>` + fixed.slice(firstParaEnd);
                  const refType = hasHardCitation ? 'statute citation' : 'jurisdiction reference';
                  repairs.push(`Added ${refType} in "${bestSection}" section`);
                }
              }
            } else {
              // Log a snippet of the actual response so we can see what shape
              // it's coming back in. Previously this just said "skipping"
              // with no indication of why, making the chronic statute
              // failure undebuggable.
              const snippet = cleanStatute.slice(0, 200).replace(/\s+/g, ' ');
              console.warn(`[Repair] Claude response contained neither a hard statute citation nor a qualified jurisdiction reference — skipping. Response (first 200 chars): "${snippet}"`);
            }
          }
        } catch (err) {
          console.error('[Repair] Failed to add statute citation:', err.message);
        }
      }
    }
  }

  return { html: fixed, repairs };
}

module.exports = { repairStructuralIssues };
