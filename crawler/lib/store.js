'use strict'
function chunks(items, size = 100)  {
  const out = [];
  for (let i = 0;
  i < items.length;
  i += size) out.push(items.slice(i, i + size));
  return out
}
function splitPageChanges(crawled, existingUrls)  {
  const existing = new Set(existingUrls || []), crawledSet = new Set((crawled || []).map(x => x.url))
  // Separate inserts, refreshes, and pages no longer present in the crawl.
  return {
    newPages: (crawled || []).filter(page => !existing.has(page.url)),
    existingPages: (crawled || []).filter(page => existing.has(page.url)),
    goneUrls: [...existing].filter(url => !crawledSet.has(url))
  }
}
async function getStoredPages(supabase, clientId,  {
  activeOnly = false
}
=  {
})  {
  const rows = []
  for (let from = 0;
  ;
  from += 1000)  {
    let query = supabase.from('meerkat_site_pages').select('url,path,is_active').eq('client_id', clientId).range(from, from + 999)
    if (activeOnly) query = query.eq('is_active', true)
    const  {
      data, error
    }
    = await query
    if (error) throw new Error(`site pages select: ${error.message}`)
    rows.push(...(data || []));
    if (!data || data.length < 1000) break
  }
  return rows
}
async function saveCrawl(supabase, clientId, pages, pageType, now = new Date().toISOString())  {
  const stored = await getStoredPages(supabase, clientId), changes = splitPageChanges(pages, stored.map(x => x.url))
  for (const batch of chunks(changes.newPages.map(p => ( {
    client_id: clientId,
    url: p.url,
    path: p.path,
    page_type: pageType(p.url),
    sitemap_lastmod: p.lastmod,
    first_seen_at: now,
    last_seen_at: now,
    is_active: true,
    source: p.source || 'sitemap'
  })), 100))  {
    const  {
      error
    }
    = await supabase.from('meerkat_site_pages').insert(batch);
    if (error) throw new Error(`site pages insert: ${error.message}`)
  }
  for (const batch of chunks(changes.existingPages, 100)) await Promise.all(batch.map(async p =>  {
    const  {
      error
    }
    = await supabase.from('meerkat_site_pages').update( {
      last_seen_at: now, sitemap_lastmod: p.lastmod, is_active: true
    }).eq('client_id', clientId).eq('url', p.url)
    if (error) throw new Error(`site pages update: ${error.message}`)
  }))
  for (const batch of chunks(changes.goneUrls, 100))  {
    const  {
      error
    }
    = await supabase.from('meerkat_site_pages').update( {
      is_active: false
    }).eq('client_id', clientId).in('url', batch);
    if (error) throw new Error(`site pages deactivate: ${error.message}`)
  }
  return changes
}
async function hasRecentSnapshot(supabase, clientId, source, days)  {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
  const  {
    data, error
  }
  = await supabase.from('meerkat_page_metrics').select('metric_date').eq('client_id', clientId).eq('source', source).gte('metric_date', since).limit(1)
  if (error) throw new Error(`metrics guard: ${error.message}`);
  return Boolean(data?.length)
}
async function insertMetrics(supabase, rows)  {
  for (const batch of chunks(rows, 500))  {
    const  {
      error
    }
    // merge-duplicates, not ignore: a same-day re-run (e.g. the top_keywords
    // backfill) must refresh the row, and dated snapshots stay append-only
    // across dates either way.
    = await supabase.from('meerkat_page_metrics').upsert(batch,  {
      onConflict: 'client_id,url,metric_date,source', ignoreDuplicates: false
    });
    if (error) throw new Error(`metrics insert: ${error.message}`)
  }
}
module.exports =  {
  chunks, splitPageChanges, getStoredPages, saveCrawl, hasRecentSnapshot, insertMetrics
}
