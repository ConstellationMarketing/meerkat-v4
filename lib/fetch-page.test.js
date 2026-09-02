// Run with: node --test lib/fetch-page.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPage } = require('./optimize');

const CAPTCHA = '<html><head><link rel="icon" href="data:;"><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fchapter-7-attorney-dubuque%2F&y=ipr:45.55.248.2:1788121809.461"></meta></head></html>';
const REAL = '<html><head><title>Dubuque Chapter 7 Bankruptcy Attorney</title></head><body><h1>Chapter 7</h1>' + '<h2>Section</h2><p>real content</p>'.repeat(60) + '</body></html>';

function firecrawlBody(rawHtml, statusCode = 200) {
  return JSON.stringify({ success: true, data: { rawHtml, metadata: { statusCode } } });
}

function mockFetch(t, responses) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url: String(url), opts });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    return new Response(next.body, { status: next.status || 200 });
  });
  return calls;
}

test('a SiteGround captcha on the direct fetch is retried through Firecrawl', async (t) => {
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const calls = mockFetch(t, [{ body: CAPTCHA }, { body: firecrawlBody(REAL) }]);
  const html = await fetchPage('https://www.henkelsbaker.com/chapter-7-attorney-dubuque/');
  assert.equal(html, REAL);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /api\.firecrawl\.dev\/v1\/scrape/);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer fc-test');
  assert.equal(JSON.parse(calls[1].opts.body).url, 'https://www.henkelsbaker.com/chapter-7-attorney-dubuque/');
});

test('a 403 from the site is treated as a block and retried too', async (t) => {
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const calls = mockFetch(t, [{ body: 'denied', status: 403 }, { body: firecrawlBody(REAL) }]);
  assert.equal(await fetchPage('https://example.com/p'), REAL);
  assert.equal(calls.length, 2);
});

test('without a Firecrawl key the block fails the fetch as before', async (t) => {
  delete process.env.FIRECRAWL_API_KEY;
  const calls = mockFetch(t, [{ body: CAPTCHA }]);
  await assert.rejects(fetchPage('https://example.com/p'), /firewall answered with a challenge page/);
  assert.equal(calls.length, 1);
});

test('when Firecrawl is blocked as well the fetch fails and says so', async (t) => {
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  mockFetch(t, [{ body: CAPTCHA }, { body: firecrawlBody(CAPTCHA) }]);
  await assert.rejects(fetchPage('https://example.com/p'), /challenge page.*Firecrawl/s);
});

test('a real HTTP 500 from the site is not retried: that is their page, not a block', async (t) => {
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const calls = mockFetch(t, [{ body: 'boom', status: 500 }]);
  await assert.rejects(fetchPage('https://example.com/p'), /HTTP 500/);
  assert.equal(calls.length, 1);
});

test('a clean direct fetch never touches Firecrawl', async (t) => {
  process.env.FIRECRAWL_API_KEY = 'fc-test';
  const calls = mockFetch(t, [{ body: REAL }]);
  assert.equal(await fetchPage('https://example.com/p'), REAL);
  assert.equal(calls.length, 1);
});
