'use strict';

// Ported verbatim from n8n "Insert Legal Compliance Changes" code node

const { replaceOutsideTags } = require('./html-text');
const { SCAFFOLD_TOKENS } = require('./format-checker');

// A compliance "replacement" is substituted verbatim into the article body,
// so it must be reader-facing copy. The model sometimes returns its own
// recommendation as the replacement ("Verify or remove the specific section
// number") — publishing that is worse than leaving the flagged term alone,
// and the scaffold quality gate would fail the whole article for it.
function isInstructionText(replacement) {
  return SCAFFOLD_TOKENS.some(pattern => pattern.test(replacement));
}

/**
 * Apply compliance violation replacements to HTML.
 * @param {string} htmlContent
 * @param {{ violations: Array<{term: string, replacement: string}>, total: number }} complianceResult
 * @returns {{ htmlContent: string, changesApplied: number, changes: Array }}
 */
function applyCompliance(htmlContent, complianceResult) {
  if (!complianceResult || !complianceResult.violations || complianceResult.violations.length === 0) {
    return { htmlContent, changesApplied: 0, changes: [] };
  }

  let correctedHTML = htmlContent;
  const appliedChanges = [];

  complianceResult.violations.forEach((violation, index) => {
    const original = violation.term;
    const replacement = violation.replacement;

    if (!original || !replacement) return;

    if (isInstructionText(replacement)) {
      console.warn(`[Compliance] Skipping violation ${index + 1}: replacement is editor-note text, not article copy: "${replacement}"`);
      return;
    }

    const actualReplacement = replacement === '[REMOVE]' ? '' : replacement;
    const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');

    // Rewrite only the text between tags. A global replace over the raw HTML
    // also hit href, class, and title attributes, silently breaking links.
    const updated = replaceOutsideTags(correctedHTML, text => text.replace(regex, actualReplacement));

    if (updated !== correctedHTML) {
      correctedHTML = updated;

      appliedChanges.push({
        number: index + 1,
        original,
        replacement: actualReplacement || '[REMOVED]',
        category: violation.category,
        excerpt: violation.excerpt
      });
    }
  });

  return {
    htmlContent: correctedHTML,
    changesApplied: appliedChanges.length,
    changes: appliedChanges
  };
}

module.exports = { applyCompliance };
