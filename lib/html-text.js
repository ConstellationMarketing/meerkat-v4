'use strict';

// A tag matcher that tolerates ">" inside quoted attribute values, so
// `<a title="x > y" href="/g/">` is one tag rather than two fragments.
// A tag must start `</?letter` or `<!`; a bare "<" in prose ("< 5 years")
// is text, not a tag start, or it would swallow everything up to the next
// real tag's ">" and hide that text from rewriting.
const TAG = /(<\/?[a-zA-Z!][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>)/;

/**
 * Rewrite only the text between tags, leaving markup and attributes alone.
 * Post-processors that regex the whole document corrupt hrefs; ones that
 * rebuild from tag-stripped text delete links outright.
 * @param {string} html
 * @param {(text: string) => string} rewrite
 * @returns {string}
 */
function replaceOutsideTags(html, rewrite) {
  return String(html || '')
    .split(new RegExp(TAG.source, 'g'))
    .map(part => (TAG.test(part) && part.startsWith('<') ? part : rewrite(part)))
    .join('');
}

module.exports = { replaceOutsideTags };
