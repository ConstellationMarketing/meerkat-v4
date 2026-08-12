'use strict';

// Ported verbatim from n8n "Article Compiler" code node
const unescapeContent = (text) => {
  if (!text) return '';

  let unescaped = text;
  let previousText;
  let iterations = 0;

  do {
    previousText = unescaped;
    unescaped = unescaped
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\\\/g, '\\');
    iterations++;
  } while (previousText !== unescaped && iterations < 5);

  return unescaped;
};

const convertToHTML = (text) => {
  if (!text) return '';

  text = unescapeContent(text);

  // Normalize spacing
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\n\s*[*-]\s*\n/g, '\n');

  // Remove horizontal rules (--- or ***) — these shouldn't appear in article output
  text = text.replace(/\n\s*[-*]{3,}\s*\n/g, '\n\n');
  text = text.replace(/^\s*[-*]{3,}\s*$/gm, '');

  // Collapse blank-line-separated numbered list items into a single block
  // e.g. "1. Foo\n\n2. Bar\n\n3. Baz" → "1. Foo\n2. Bar\n3. Baz"
  text = text.replace(
    /(\d+\.\s+[^\n]+)\n\n(?=\d+\.\s+)/g,
    '$1\n'
  );

  // Same for unordered lists separated by blank lines
  text = text.replace(
    /([-*]\s+[^\n]+)\n\n(?=[-*]\s+)/g,
    '$1\n'
  );

  // Markdown links
  text = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic (single asterisks)
  text = text.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Clean up any unclosed bold markers that didn't match the pattern above
  // This prevents bold from "bleeding" into subsequent text
  text = text.replace(/\*\*/g, '');

  // Split consecutive bold-label lines into separate paragraphs
  // e.g. "**Label A** — desc\n**Label B** — desc" → separate blocks
  text = text.replace(
    /(<strong>[^<]+<\/strong>\s*[—:\-–.][^\n]+)\n(?=<strong>)/g,
    '$1\n\n'
  );

  const blocks = text.split('\n\n').filter(b => b.trim());

  const renderBlock = (block) => {
    const trimmed = block.trim();

    // Skip empty blocks or leftover horizontal rule fragments
    if (!trimmed || /^[-*]{3,}$/.test(trimmed)) return '';

    // Headings. The model often omits the blank line between a heading and the
    // text under it; without this split the whole block landed inside the
    // heading tag, which deleted the section's real heading and buried its body.
    const heading = trimmed.match(/^(#{1,3})[ \t]*([^\n]*)(?:\n([\s\S]*))?$/);
    if (heading) {
      const level = heading[1].length;
      const tag = `<h${level}>${heading[2].trim()}</h${level}>`;
      const rest = (heading[3] || '').trim();
      return rest ? `${tag}\n\n${renderBlock(rest)}` : tag;
    }

    const lines = trimmed.split('\n');

    // Unordered list (all lines are list items)
    if (lines.every(l => l.trim().match(/^[-*]\s+/))) {
      return (
        '<ul>\n' +
        lines
          .map(l => '<li>' + l.replace(/^[-*]\s*/, '') + '</li>')
          .join('\n') +
        '\n</ul>'
      );
    }

    // Ordered list (all lines are list items)
    if (lines.every(l => l.trim().match(/^\d+\.\s+/))) {
      return (
        '<ol>\n' +
        lines
          .map(l => '<li>' + l.replace(/^\d+\.\s*/, '') + '</li>')
          .join('\n') +
        '\n</ol>'
      );
    }

    // Mixed-content block: some lines are list items, some aren't
    // Split into runs of list vs non-list lines and render each appropriately
    const hasListItems = lines.some(l => l.trim().match(/^[-*]\s+/) || l.trim().match(/^\d+\.\s+/));
    if (hasListItems && !lines.every(l => l.trim().match(/^[-*]\s+/) || l.trim().match(/^\d+\.\s+/))) {
      const parts = [];
      let currentRun = [];
      let currentType = null; // 'ul', 'ol', or 'text'

      for (const line of lines) {
        const trimLine = line.trim();
        let lineType;
        if (trimLine.match(/^[-*]\s+/)) lineType = 'ul';
        else if (trimLine.match(/^\d+\.\s+/)) lineType = 'ol';
        else lineType = 'text';

        if (lineType !== currentType && currentRun.length > 0) {
          parts.push({ type: currentType, lines: currentRun });
          currentRun = [];
        }
        currentType = lineType;
        currentRun.push(trimLine);
      }
      if (currentRun.length > 0) {
        parts.push({ type: currentType, lines: currentRun });
      }

      return parts.map(part => {
        if (part.type === 'ul') {
          return '<ul>\n' + part.lines.map(l => '<li>' + l.replace(/^[-*]\s*/, '') + '</li>').join('\n') + '\n</ul>';
        }
        if (part.type === 'ol') {
          return '<ol>\n' + part.lines.map(l => '<li>' + l.replace(/^\d+\.\s*/, '') + '</li>').join('\n') + '\n</ol>';
        }
        return part.lines.map(l => '<p>' + l + '</p>').join('\n');
      }).join('\n\n');
    }

    // Paragraph
    return '<p>' + lines.join('<br>\n') + '</p>';
  };

  const htmlBlocks = blocks.map(renderBlock).filter(b => b);

  // Post-process: close any unclosed <strong> tags within the final HTML
  let html = htmlBlocks.join('\n\n');
  const openCount = (html.match(/<strong>/g) || []).length;
  const closeCount = (html.match(/<\/strong>/g) || []).length;
  if (openCount > closeCount) {
    for (let i = 0; i < openCount - closeCount; i++) {
      html += '</strong>';
    }
  }

  return html;
};

/**
 * Compile an array of section text outputs into a single HTML article.
 * @param {string[]} sectionOutputs - Raw text output from each section agent
 * @returns {string} Complete HTML article
 */
function compileArticle(sectionOutputs) {
  const htmlSections = sectionOutputs
    .map(content => convertToHTML(content))
    .join('\n\n');

  return '<article class="legal-content">\n' + htmlSections + '\n</article>';
}

module.exports = { compileArticle, convertToHTML };
