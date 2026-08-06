'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { mapDataForSeoResponse, fetchDataForSeo } = require('../lib/metrics-dataforseo')
const payload = { tasks: [{ cost: 0.11, result: [{ items: [{ ranked_serp_element: { serp_item: { relative_url: '/a/', rank_absolute: 3, etv: 1.234 } } }, { ranked_serp_element: { serp_item: { url: 'https://example.com/a', rank_absolute: 12, etv: 2 } } }, { ranked_serp_element: { serp_item: { relative_url: '/missing', rank_absolute: 1, etv: 9 } } }] }] }] }
test('groups rankings and matches exact normalized site paths', () => assert.deepEqual(mapDataForSeoResponse(payload, [{ url: 'https://example.com/a', path: '/a' }]), [{ url: 'https://example.com/a', keywords_count: 2, top10_count: 1, etv: 3.23 }]))
test('adapter posts one domain request with mocked fetch', async () => {
  let request
  const result = await fetchDataForSeo({ website: 'https://www.example.com' }, [{ url: 'https://example.com/a', path: '/a' }], { login: 'u', password: 'p' }, async (url, options) => { request = { url, options }; return { ok: true, json: async () => payload } })
  assert.equal(result.cost, 0.11); assert.equal(JSON.parse(request.options.body)[0].target, 'example.com'); assert.match(request.options.headers.Authorization, /^Basic /)
})
