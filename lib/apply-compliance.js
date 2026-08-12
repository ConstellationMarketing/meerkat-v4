'use strict';

// Ported verbatim from n8n "Insert Legal Compliance Changes" code node

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

    const actualReplacement = replacement === '[REMOVE]' ? '' : replacement;
    const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedOriginal}\\b`, 'gi');

    // Rewrite only the text between tags. A global replace over the raw HTML
    // also hit href, class, and title attributes, silently breaking links.
    const updated = correctedHTML
      .split(/(<[^>]*>)/)
      .map(part => (part.startsWith('<') ? part : part.replace(regex, actualReplacement)))
      .join('');

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
