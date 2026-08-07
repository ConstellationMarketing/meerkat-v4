'use strict'
const ASSET_RE = /\.(?:jpe?g|png|gif|webp|svg|pdf|css|js|ico|mp4|xml|zip|woff2?|ttf|eot)\/?$/i
const BARE_DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i
function decodeXml(v)  {
  return String(v || '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
}
function extractTag(b, t)  {
  const m = b.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${t}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : null
}
function parseSitemap(xml)  {
  const t=String(xml||'');
  if (/<sitemapindex\b/i.test(t)) return  {
    type:'index',sitemaps:[...t.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)].map(m=>extractTag(m[1],'loc')).filter(Boolean)
  };
  if (/<urlset\b/i.test(t)) return  {
    type:'urlset',urls:[...t.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(m=>( {
      loc:extractTag(m[1],'loc'),lastmod:extractTag(m[1],'lastmod')
    })).filter(x=>x.loc)
  };
  return  {
    type:'unknown',urls:[]
  }
}
function normalizeWebsite(website)  {
  let v=String(website||'').trim();
  if(BARE_DOMAIN_RE.test(v))v=`https://${v}`;
  const u=new URL(v);
  if(!/^https?:$/.test(u.protocol))throw new Error('website must use http(s)');
  return u.origin+u.pathname.replace(/\/+$/,'')
}
function parseWebsiteField(field, cap=3)  {
  const text=String(field||'').trim(), out=[];
  for(const m of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    let v=m[0].replace(/[),.;:!?\]}]+$/g,'');
    try {
      v=normalizeWebsite(v);
      if(!out.includes(v))out.push(v)
    }
    catch {
    }
    if(out.length>=cap)break
  }
  if(!out.length&&BARE_DOMAIN_RE.test(text))out.push(normalizeWebsite(text));
  if(!out.length)throw new Error('no valid website URL found');
  return out
}
function registrableHost(h) {
  return String(h||'').toLowerCase().replace(/^www\./,'').replace(/\.$/,'')
}
function normalizePath(p) {
  p=p||'/';
  return p!=='/'?p.replace(/\/+$/,'')||'/':'/'
}
function filterUrls(entries,website,cap=2000,acceptedWebsites=[website]) {
  const hosts=new Set(acceptedWebsites.map(v=>registrableHost(new URL(normalizeWebsite(v)).hostname))),seen=new Set(),out=[];
  for(const e of entries||[]) {
    if(out.length>=cap)break;
    try {
      const u=new URL(e.loc);
      if(!/^https?:$/.test(u.protocol)||!hosts.has(registrableHost(u.hostname))||ASSET_RE.test(u.pathname))continue;
      u.hash='';
      const href=u.href;
      if(seen.has(href))continue;
      seen.add(href);
      out.push( {
        url:href,path:normalizePath(u.pathname),lastmod:e.lastmod?String(e.lastmod).slice(0,10):null,source:e.source||'sitemap'
      })
    }
    catch {
    }
  }
  return out
}
async function fetchText(url, {
  fetchImpl=global.fetch,userAgent,timeoutMs=20000
}
= {
}) {
  const c=new AbortController(),timer=setTimeout(()=>c.abort(),timeoutMs);
  try {
    const r=await fetchImpl(url, {
      headers: {
        'User-Agent':userAgent
      },signal:c.signal
    }),text=await r.text();
    return {
      ok:r.status===200,status:r.status,text,url:r.url||url,contentType:r.headers?.get?.('content-type')||''
    }
  }
  finally {
    clearTimeout(timer)
  }
}
function looksXml(text) {
  return /<(?:urlset|sitemapindex)\b/i.test(String(text||''))
}
function attemptDescription(label,r,requested) {
  const redirected=r.url&&r.url!==requested,outcome=r.ok?(looksXml(r.text)?'xml':'html'):String(r.status);
  return `${label} (${redirected ? `${r.status}→` : ''}${outcome})`
}
async function crawlSite(website,options) {
  const base=normalizeWebsite(website),origin=new URL(base).origin,attempts=[];
  let root
  async function tryCandidate(url,label) {
    try {
      const r=await fetchText(url,options);
      attempts.push(attemptDescription(label,r,url));
      if(r.ok&&looksXml(r.text))return {
        url:r.url,xml:r.text
      }
    }
    catch(e) {
      attempts.push(`${label} (${e.name==='AbortError'?'timeout':e.message})`)
    }
    return null
  }
  for(const label of ['sitemap.xml','sitemap_index.xml','wp-sitemap.xml']) {
    root=await tryCandidate(new URL(label,`${origin}/`).href,label);
    if(root)break
  }
  if(!root) {
    try {
      const robots=await fetchText(new URL('robots.txt',`${origin}/`).href,options);
      if(robots.ok) {
        for(const m of robots.text.matchAll(/^\s*Sitemap:\s*(\S+)\s*$/gim)) {
          const resolved=new URL(m[1],origin).href;
          root=await tryCandidate(resolved,`robots:${m[1]}`);
          if(root)break
        }
      }
      else attempts.push(`robots.txt (${robots.status})`)
    }
    catch(e) {
      attempts.push(`robots.txt (${e.message})`)
    }
  }
  const accepted=[origin]
  if(root) {
    // Accept the final host when a sitemap redirects to a canonical domain.
    accepted.push(new URL(root.url).origin);
    const all=[];
    async function visit(url,xml,depth) {
      const parsed=parseSitemap(xml);
      if(parsed.type==='urlset') {
        all.push(...parsed.urls);
        return
      }
      if(parsed.type!=='index'||depth>=2)return;
      for(const child of parsed.sitemaps.slice(0,50)) {
        if(/\.xml\.gz(?:\?|$)/i.test(child)) {
          options.log?.(`sitemap: skipped gzip child ${child}`);
          continue
        }
        try {
          const r=await fetchText(child,options);
          if(r.ok&&looksXml(r.text))await visit(r.url,r.text,depth+1)
        }
        catch(e) {
          options.log?.(`sitemap: child failed ${child} (${e.message})`)
        }
      }
    }
    await visit(root.url,root.xml,0);
    return filterUrls(all,base,options.cap||2000,accepted)
  }
  // Crawl homepage links only after all sitemap discovery candidates fail.
  try {
    const home=await fetchText(`${origin}/`,options);
    accepted.push(new URL(home.url).origin);
    if(home.ok) {
      const entries=[ {
        loc:home.url,source:'homepage'
      }
      ];
      for(const m of home.text.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
        try {
          const u=new URL(decodeXml(m[1]||m[2]||m[3]),home.url);
          u.hash='';
          u.search='';
          entries.push( {
            loc:u.href,source:'homepage'
          })
        }
        catch {
        }
      }
      const rows=filterUrls(entries,base,Math.min(options.cap||2000,200),accepted);
      options.log?.(`↳ fallback: homepage crawl (${rows.length} links)`);
      if(rows.length)return rows
    }
  }
  catch(e) {
    attempts.push(`homepage (${e.message})`)
  }
  throw new Error(`no sitemap discovered; tried: ${attempts.join(', ')}`)
}
async function crawlSitemap(field,options= {
}) {
  const sites=parseWebsiteField(field),merged=new Map(),failures=[];
  for(const site of sites) {
    try {
      for(const p of await crawlSite(site,options))if(!merged.has(p.url))merged.set(p.url,p)
    }
    catch(e) {
      failures.push(`${site}: ${e.message}`)
    }
  }
  if(!merged.size)throw new Error(failures.join('; '));
  return [...merged.values()]
}
module.exports= {
  ASSET_RE,decodeXml,parseSitemap,normalizeWebsite,parseWebsiteField,registrableHost,normalizePath,filterUrls,fetchText,crawlSitemap
}
