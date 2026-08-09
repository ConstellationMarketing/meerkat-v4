'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { domainFromWebsite, mapDataForSeoResponse, fetchDataForSeo } = require('../lib/metrics-dataforseo')
const payload = { tasks: [{ cost: 0.11, result: [{ items: [{ keyword_data: { keyword: 'alpha', keyword_info: { search_volume: 100 } }, ranked_serp_element: { serp_item: { relative_url: '/a/', rank_absolute: 3, etv: 1.234 } } }, { keyword_data: { keyword: 'beta', keyword_info: { search_volume: 50 } }, ranked_serp_element: { serp_item: { url: 'https://example.com/a', rank_absolute: 12, etv: 2 } } }, { ranked_serp_element: { serp_item: { relative_url: '/missing', rank_absolute: 1, etv: 9 } } }] }] }] }
test('groups rankings and matches exact normalized site paths', () => assert.deepEqual(mapDataForSeoResponse(payload, [{ url: 'https://example.com/a', path: '/a' }]), [{ url: 'https://example.com/a', keywords_count: 2, top10_count: 1, etv: 3.23, top_keywords: [{ keyword: 'alpha', rank: 3, sv: 100 }, { keyword: 'beta', rank: 12, sv: 50 }] }]))
test('top_keywords keeps the best 5 ranks and skips items with no keyword text', () => {
  const items = [9, 2, 30, 4, 1, 15].map((rank) => ({ keyword_data: { keyword: `kw${rank}`, keyword_info: { search_volume: rank * 10 } }, ranked_serp_element: { serp_item: { relative_url: '/p/', rank_absolute: rank, etv: 0 } } }))
  items.push({ ranked_serp_element: { serp_item: { relative_url: '/p/', rank_absolute: 5, etv: 0 } } })
  const [row] = mapDataForSeoResponse({ tasks: [{ result: [{ items }] }] }, [{ url: 'https://example.com/p', path: '/p' }])
  assert.equal(row.keywords_count, 7)
  assert.deepEqual(row.top_keywords.map((k) => k.rank), [1, 2, 4, 9, 15])
  assert.deepEqual(row.top_keywords[0], { keyword: 'kw1', rank: 1, sv: 10 })
})
test('adapter posts one domain request with mocked fetch', async () => {
  let request
  const result = await fetchDataForSeo({ website: 'https://www.example.com' }, [{ url: 'https://example.com/a', path: '/a' }], { login: 'user', password: 'pass' }, async (url, options) => { request = { url, options }; return { ok: true, json: async () => payload } })
  assert.equal(result.cost, 0.11); assert.equal(JSON.parse(request.options.body)[0].target, 'example.com'); assert.equal(request.options.headers.Authorization, 'Basic ' + Buffer.from('user:pass').toString('base64'))
})
test('extracts a target from a bare domain', () => assert.equal(domainFromWebsite('upwardlawfirm.com'), 'upwardlawfirm.com'))
test('uses the first target in a multi-site website field', () => assert.equal(domainFromWebsite('https://e-2visaworld.com/ and https://bardazzilaw.com/'), 'e-2visaworld.com'))
