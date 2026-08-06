'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const { mapGscResponse, getAccessToken, fetchGsc, queryDates } = require('../lib/metrics-gsc')
test('maps GSC rows by normalized path and rounds values', () => {
  const rows = mapGscResponse({ rows: [{ keys: ['https://www.example.com/a/'], clicks: 1.6, impressions: 9.4 }, { keys: ['https://example.com/nope'], clicks: 3, impressions: 4 }] }, [{ url: 'https://example.com/a', path: '/a' }])
  assert.deepEqual(rows, [{ url: 'https://example.com/a', clicks_30d: 2, impressions_30d: 9 }])
})
test('token and query adapters use mocked fetch', async () => {
  const token = await getAccessToken({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }, async (_url, options) => { assert.match(String(options.body), /grant_type=refresh_token/); return { ok: true, json: async () => ({ access_token: 'token' }) } })
  const result = await fetchGsc('sc-domain:example.com', [{ url: 'https://example.com/a', path: '/a' }], token, async (url, options) => { assert.match(url, /sc-domain%3Aexample.com/); assert.equal(options.headers.Authorization, 'Bearer token'); return { ok: true, status: 200, json: async () => ({ rows: [{ keys: ['https://example.com/a'], clicks: 1, impressions: 2 }] }) } }, new Date('2026-08-06T00:00:00Z'))
  assert.equal(result.rows.length, 1); assert.deepEqual(queryDates(new Date('2026-08-06T00:00:00Z')), { startDate: '2026-07-07', endDate: '2026-08-05' })
})
test('403 property is an expected no-access result', async () => { const result = await fetchGsc('x', [], 't', async () => ({ ok: false, status: 403 })); assert.equal(result.noAccess, true) })
