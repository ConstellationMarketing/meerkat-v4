'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { decodeXml, parseSitemap, filterUrls, crawlSitemap, parseWebsiteField, normalizeWebsite } = require('../lib/sitemap')
function response(status, text, url, type = 'application/xml') { return { status, url, headers: { get: () => type }, text: async () => text } }
test('decodes XML entities and parses urlset lastmod', () => {
  assert.equal(decodeXml('&amp;&lt;&gt;&quot;&#039;'), String.fromCharCode(38, 60, 62, 34, 39))
  assert.deepEqual(parseSitemap('<urlset><url><loc>https://x.com/a?x=1&amp;y=2</loc><lastmod>2026-08-01T12:00:00Z</lastmod></url></urlset>').urls, [{ loc: 'https://x.com/a?x=1&y=2', lastmod: '2026-08-01T12:00:00Z' }])
})
test('website-field parsing handles domains, prose, joined URLs, punctuation, and prefixing', () => {
  assert.equal(normalizeWebsite(' example.com '), 'https://example.com')
  assert.deepEqual(parseWebsiteField('example.com'), ['https://example.com'])
  assert.deepEqual(parseWebsiteField('Visit https://one.com/a, or https://two.com/b.'), ['https://one.com/a', 'https://two.com/b'])
  assert.deepEqual(parseWebsiteField('https://one.com/ and https://two.com/'), ['https://one.com', 'https://two.com'])
  assert.deepEqual(parseWebsiteField('(https://one.com/x).'), ['https://one.com/x'])
})
test('recurses sitemap index with mocked fetch and skips gzip', async () => {
  const calls = [], docs = new Map([['https://example.com/sitemap.xml', '<sitemapindex><sitemap><loc>https://example.com/a.xml</loc></sitemap><sitemap><loc>https://example.com/b.xml.gz</loc></sitemap></sitemapindex>'], ['https://example.com/a.xml', '<urlset><url><loc>https://example.com/one</loc></url></urlset>']])
  const rows = await crawlSitemap('https://example.com/', { fetchImpl: async url => { calls.push(url); return response(docs.has(url) ? 200 : 404, docs.get(url) || '', url) }, userAgent: 'test' })
  assert.equal(rows.length, 1); assert.equal(rows[0].path, '/one'); assert.equal(calls.includes('https://example.com/b.xml.gz'), false)
})
test('filters foreign hosts and assets, accepts www, and applies cap', () => {
  const entries = [{ loc: 'https://www.example.com/a' }, { loc: 'https://cdn.other.com/b' }, { loc: 'https://example.com/x.pdf' }, { loc: 'https://example.com/c' }]
  assert.deepEqual(filterUrls(entries, 'https://example.com', 1).map(x => x.path), ['/a'])
})
test('adopts final sitemap host but drops a third host', async () => {
  const xml = '<urlset><url><loc>https://b.com/kept</loc></url><url><loc>https://c.com/dropped</loc></url></urlset>'
  const rows = await crawlSitemap('https://a.com', { fetchImpl: async url => response(200, xml, 'https://b.com/sitemap.xml') })
  assert.deepEqual(rows.map(x => x.url), ['https://b.com/kept'])
})
test('resolves relative Sitemap directives from robots', async () => {
  const calls=[]; const fetchImpl=async url=>{calls.push(url);if(url.endsWith('/robots.txt'))return response(200,'Sitemap: /custom.xml',url,'text/plain');if(url.endsWith('/custom.xml'))return response(200,'<urlset><url><loc>https://a.com/ok</loc></url></urlset>',url);return response(404,'',url)}
  const rows=await crawlSitemap('a.com',{fetchImpl}); assert.equal(rows[0].path,'/ok'); assert.ok(calls.includes('https://a.com/custom.xml'))
})
test('homepage fallback dedupes, skips assets, caps, and marks source', async () => {
  let links='<a href="/same?q=1#x">one</a><a href="/same?q=2">two</a><a href="https://foreign.com/no">no</a><a href="/pic.jpg">asset</a>'
  for(let i=0;i<205;i++)links+=`<a href="/p${i}">p</a>`
  const fetchImpl=async url=>url==='https://a.com/'?response(200,links,url,'text/html'):response(200,'<html>home</html>',url,'text/html')
  const logs=[],rows=await crawlSitemap('a.com',{fetchImpl,log:x=>logs.push(x)})
  assert.equal(rows.length,200); assert.equal(rows.filter(x=>x.path==='/same').length,1); assert.ok(rows.every(x=>x.source==='homepage')); assert.ok(!rows.some(x=>x.path==='/pic.jpg')); assert.ok(logs.some(x=>x.includes('fallback: homepage crawl (200 links)')))
})
