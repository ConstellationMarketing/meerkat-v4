'use strict'
const { normalizePath } = require('./sitemap')
function mapGscResponse(payload, sitePages) {
  const pagesByPath = new Map((sitePages || []).map(p => [normalizePath(p.path), p])), result = []
  for (const row of payload?.rows || []) { let path; try { path = normalizePath(new URL(row.keys?.[0]).pathname) } catch { continue }; const page = pagesByPath.get(path); if (page) result.push({ url: page.url, clicks_30d: Math.round(Number(row.clicks) || 0), impressions_30d: Math.round(Number(row.impressions) || 0) }) }
  return result
}
async function getAccessToken(credentials, fetchImpl = global.fetch) {
  const body = new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: 'refresh_token' })
  const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body })
  if (!response.ok) throw new Error(`gsc token HTTP ${response.status}`); const payload = await response.json(); if (!payload.access_token) throw new Error('gsc token missing access_token'); return payload.access_token
}
function queryDates(now = new Date()) { const end = new Date(now), start = new Date(now); end.setUTCDate(end.getUTCDate() - 1); start.setUTCDate(start.getUTCDate() - 30); return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) } }
async function fetchGsc(propertyUrl, sitePages, accessToken, fetchImpl = global.fetch, now = new Date()) {
  const response = await fetchImpl(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(propertyUrl)}/searchAnalytics/query`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...queryDates(now), dimensions: ['page'], rowLimit: 5000 }) })
  if (response.status === 403) return { rows: [], noAccess: true }; if (!response.ok) throw new Error(`gsc HTTP ${response.status}`); return { rows: mapGscResponse(await response.json(), sitePages), noAccess: false }
}
module.exports = { mapGscResponse, getAccessToken, queryDates, fetchGsc }
