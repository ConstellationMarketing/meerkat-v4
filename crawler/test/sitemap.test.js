'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { decodeXml, parseSitemap, filterUrls, crawlSitemap } = require('../lib/sitemap')
function response(status, text) { return { status, ok: status >= 200 && status < 300, headers: { get: () => 'application/xml' }, text: async () => text } }
test('decodes XML entities and parses urlset lastmod', () => {
  assert.equal(decodeXml('&amp;&lt;&gt;&quot;&#039;'), String.fromCharCode(38, 60, 62, 34, 39))
  const parsed = parseSitemap('<urlset><url><loc>https://x.com/a?x=1&amp;y=2</loc><lastmod>2026-08-01T12:00:00Z</lastmod></url></urlset>')
  assert.deepEqual(parsed.urls, [{ loc: 'https://x.com/a?x=1&y=2', lastmod: '2026-08-01T12:00:00Z' }])
})
test('recurses sitemap index with mocked fetch and skips gzip', async () => {
  const calls = [], docs = new Map([['https://example.com/sitemap.xml', '<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap><sitemap><loc>https://example.com/b.xml.gz</loc></sitemap></sitemapindex>'], ['https://example.com/a.xml', '<urlset><url><loc>https://example.com/one</loc></url></urlset>']])
  const rows = await crawlSitemap('https://example.com/', { fetchImpl: async url => { calls.push(url); return docs.has(url) ? response(200, docs.get(url)) : response(404, '') }, userAgent: 'test' })
  assert.equal(rows.length, 1); assert.equal(rows[0].path, '/one'); assert.equal(calls.includes('https://example.com/b.xml.gz'), false)
})
test('filters foreign hosts and assets, accepts www, and applies cap', () => {
  const entries = [{ loc: 'https://www.example.com/a' }, { loc: 'https://cdn.other.com/b' }, { loc: 'https://example.com/x.pdf' }, { loc: 'https://example.com/c' }]
  assert.deepEqual(filterUrls(entries, 'https://example.com', 1).map(x => x.path), ['/a'])
})
