'use strict'

const ASSET_RE = /\.(?:jpe?g|png|gif|webp|svg|pdf|css|js|ico|mp4|xml)\/?$/i
const COMMON_SLD = new Set(['co.uk', 'org.uk', 'com.au', 'net.au', 'co.nz', 'com.br', 'com.mx'])

function decodeXml(value) {
  return String(value || '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
}

function extractTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))
  return match ? decodeXml(match[1].trim()) : null
}

function parseSitemap(xml) {
  const text = String(xml || '')
  if (/<sitemapindex\b/i.test(text)) {
    return { type: 'index', sitemaps: [...text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)].map(m => extractTag(m[1], 'loc')).filter(Boolean) }
  }
  if (/<urlset\b/i.test(text)) {
    return { type: 'urlset', urls: [...text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(m => ({ loc: extractTag(m[1], 'loc'), lastmod: extractTag(m[1], 'lastmod') })).filter(x => x.loc) }
  }
  return { type: 'unknown', urls: [] }
}

function normalizeWebsite(website) {
  const url = new URL(String(website || '').trim())
  if (!/^https?:$/.test(url.protocol)) throw new Error('website must use http(s)')
  return url.origin + url.pathname.replace(/\/+$/, '')
}

function registrableHost(hostname) {
  const host = hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const tail2 = parts.slice(-2).join('.')
  return COMMON_SLD.has(tail2) ? parts.slice(-3).join('.') : tail2
}

function normalizePath(pathname) {
  const path = pathname || '/'
  return path !== '/' ? path.replace(/\/+$/, '') || '/' : '/'
}

function filterUrls(entries, website, cap = 2000) {
  const base = new URL(normalizeWebsite(website))
  const host = registrableHost(base.hostname)
  const seen = new Set()
  const result = []
  for (const entry of entries || []) {
    if (result.length >= cap) break
    try {
      const url = new URL(entry.loc)
      if (!/^https?:$/.test(url.protocol) || registrableHost(url.hostname) !== host || ASSET_RE.test(url.pathname)) continue
      url.hash = ''
      const href = url.href
      if (seen.has(href)) continue
      seen.add(href)
      result.push({ url: href, path: normalizePath(url.pathname), lastmod: entry.lastmod ? String(entry.lastmod).slice(0, 10) : null })
    } catch {}
  }
  return result
}

async function fetchText(url, { fetchImpl = global.fetch, userAgent, timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: controller.signal })
    const text = await response.text()
    return { ok: response.status === 200, status: response.status, text, contentType: response.headers?.get?.('content-type') || '' }
  } finally { clearTimeout(timer) }
}

function looksXml(text) { return /<(?:\?xml|urlset|sitemapindex)\b/i.test(String(text || '')) }

async function crawlSitemap(website, options = {}) {
  const base = normalizeWebsite(website)
  const candidates = [`${base}/sitemap.xml`, `${base}/sitemap_index.xml`, `${base}/wp-sitemap.xml`]
  let root
  for (const url of candidates) {
    try {
      const result = await fetchText(url, options)
      if (result.ok && looksXml(result.text)) { root = { url, xml: result.text }; break }
    } catch (error) { options.log?.(`sitemap: ${url} failed (${error.message})`) }
  }
  if (!root) {
    try {
      const robots = await fetchText(`${base}/robots.txt`, options)
      if (robots.ok) {
        for (const match of robots.text.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)) {
          try {
            const result = await fetchText(match[1], options)
            if (result.ok && looksXml(result.text)) { root = { url: match[1], xml: result.text }; break }
          } catch (error) { options.log?.(`sitemap: ${match[1]} failed (${error.message})`) }
        }
      }
    } catch (error) { options.log?.(`sitemap: robots.txt failed (${error.message})`) }
  }
  if (!root) throw new Error('no sitemap discovered')

  const all = []
  async function visit(url, xml, depth) {
    const parsed = parseSitemap(xml)
    if (parsed.type === 'urlset') { all.push(...parsed.urls); return }
    if (parsed.type !== 'index' || depth >= 2) return
    for (const child of parsed.sitemaps.slice(0, 50)) {
      if (/\.xml\.gz(?:\?|$)/i.test(child)) { options.log?.(`sitemap: skipped gzip child ${child}`); continue }
      try {
        const result = await fetchText(child, options)
        if (result.ok && looksXml(result.text)) await visit(child, result.text, depth + 1)
      } catch (error) { options.log?.(`sitemap: child failed ${child} (${error.message})`) }
    }
  }
  await visit(root.url, root.xml, 0)
  return filterUrls(all, base, options.cap || 2000)
}

module.exports = { ASSET_RE, decodeXml, parseSitemap, normalizeWebsite, registrableHost, normalizePath, filterUrls, fetchText, crawlSitemap }
