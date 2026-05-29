'use strict';

// Unit tests for parseTranslationResponse — the sentinel-delimited contract
// that fixed Vietnamese translations (May 2026). The old contract embedded
// HTML in a JSON string, and Haiku intermittently dropped quote-escapes on
// longer (Vietnamese) output, breaking JSON.parse at the first link attribute.

const assert = require('assert');

// Re-require the module and reach the (non-exported) parser via a tiny shim:
// parseTranslationResponse isn't exported, so exercise it through a copy that
// mirrors lib/translate.js. Keep this in sync with that file.
const { jsonrepair } = require('jsonrepair');

function parseLegacyJsonResponse(stripped) {
  let parsed;
  try { parsed = JSON.parse(stripped); }
  catch (e) { parsed = JSON.parse(jsonrepair(stripped)); }
  const { title, meta, slug, content } = parsed;
  if ([title, meta, slug, content].some(x => typeof x !== 'string')) throw new Error('legacy missing field');
  return { title, meta, slug, content };
}
function parseTranslationResponse(raw) {
  const stripped = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  const m = stripped.match(/<<<CONTENT>>>\s*([\s\S]*?)\s*<<<END_CONTENT>>>/);
  if (!m) return parseLegacyJsonResponse(stripped);
  const content = m[1].trim();
  const headerRaw = stripped.slice(0, stripped.indexOf('<<<CONTENT>>>')).trim();
  let header;
  try { header = JSON.parse(headerRaw); }
  catch (e) { header = JSON.parse(jsonrepair(headerRaw)); }
  const { title, meta, slug } = header;
  if ([title, meta, slug].some(x => typeof x !== 'string')) throw new Error('header missing field');
  if (typeof content !== 'string' || !content) throw new Error('empty content');
  return { title, meta, slug, content };
}

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS: ${name}`); }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); failed++; }
}

// 1. Sentinel format with UNESCAPED quotes in HTML attributes — the whole point.
//    This input would be invalid JSON in the old contract; here it parses fine.
check('Sentinel content with raw unescaped HTML attribute quotes', () => {
  const raw = `{"title": "Luật sư Tai nạn", "meta": "Mô tả", "slug": "luat-su-tai-nan"}
<<<CONTENT>>>
<h1>Tiêu đề</h1><p><a target="_blank" rel="noopener noreferrer nofollow" href="https://example.com/">Liên kết</a></p>
<<<END_CONTENT>>>`;
  const r = parseTranslationResponse(raw);
  assert.strictEqual(r.title, 'Luật sư Tai nạn');
  assert.strictEqual(r.slug, 'luat-su-tai-nan');
  assert.ok(r.content.includes('target="_blank"'), 'preserves raw attribute quotes');
  assert.ok(r.content.includes('href="https://example.com/"'), 'preserves href');
});

// 2. Sentinel format with code fences wrapped around it.
check('Sentinel format wrapped in code fences', () => {
  const raw = '```json\n{"title": "T", "meta": "M", "slug": "s"}\n<<<CONTENT>>>\n<h1>Body</h1>\n<<<END_CONTENT>>>\n```';
  const r = parseTranslationResponse(raw);
  assert.strictEqual(r.title, 'T');
  assert.strictEqual(r.content, '<h1>Body</h1>');
});

// 3. Legacy single-JSON fallback still parses (model ignored new format).
check('Legacy single-JSON object falls back correctly', () => {
  const raw = '{"title": "T", "meta": "M", "slug": "s", "content": "<h1>Hi</h1>"}';
  const r = parseTranslationResponse(raw);
  assert.strictEqual(r.title, 'T');
  assert.strictEqual(r.content, '<h1>Hi</h1>');
});

// 4. Header with a translated quote inside meta still parses (header is short
//    plain text; normal JSON escaping applies and works).
check('Header with escaped quote in meta', () => {
  const raw = `{"title": "T", "meta": "Anh ấy nói \\"xin chào\\"", "slug": "s"}
<<<CONTENT>>>
<p>Nội dung</p>
<<<END_CONTENT>>>`;
  const r = parseTranslationResponse(raw);
  assert.ok(r.meta.includes('xin chào'));
  assert.strictEqual(r.content, '<p>Nội dung</p>');
});

// 5. Missing END sentinel → no match → legacy fallback throws clearly (not silent).
check('Truncated output (no END sentinel) raises a clear error', () => {
  const raw = `{"title": "T", "meta": "M", "slug": "s"}
<<<CONTENT>>>
<h1>Body that never closes`;
  assert.throws(() => parseTranslationResponse(raw));
});

if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
console.log(`\nAll tests passed`);
