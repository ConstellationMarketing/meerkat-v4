'use strict'
const  {
  normalizePath
}
= require('./sitemap')
function domainFromWebsite(website)  {
  return new URL(website).hostname.replace(/^www\./i, '')
}
function itemPath(item)  {
  const serp = item?.ranked_serp_element?.serp_item ||  {
  }
  if (serp.relative_url)  {
    try  {
      return normalizePath(new URL(serp.relative_url, 'https://example.invalid').pathname)
    }
    catch  {
    }
  }
  try  {
    return normalizePath(new URL(serp.url).pathname)
  }
  catch  {
    return null
  }
}
function mapDataForSeoResponse(payload, sitePages)  {
  const groups = new Map(), items = payload?.tasks?.[0]?.result?.[0]?.items || []
  for (const item of items)  {
    const path = itemPath(item);
    if (!path) continue
    const current = groups.get(path) ||  {
      keywords_count: 0, top10_count: 0, etv: 0
    }, serp = item.ranked_serp_element?.serp_item ||  {
    }
    current.keywords_count++;
    if (Number(serp.rank_absolute) <= 10) current.top10_count++;
    current.etv += Number(serp.etv) || 0;
    groups.set(path, current)
  }
  const pagesByPath = new Map((sitePages || []).map(p => [normalizePath(p.path), p]))
  return [...groups].flatMap(([path, value]) =>  {
    const page = pagesByPath.get(path);
    return page ? [ {
      url: page.url, ...value, etv: Math.round(value.etv * 100) / 100
    }
    ] : []
  })
}
async function fetchDataForSeo(client, sitePages, credentials, fetchImpl = global.fetch)  {
  const response = await fetchImpl('https://api.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live',  {
    method: 'POST', headers:  {
      Authorization: `Basic ${Buffer.from(`$ {
        credentials.login
      }
      :$ {
        credentials.password
      }
      `).toString('base64')}`, 'Content-Type': 'application/json'
    }, body: JSON.stringify([ {
      target: domainFromWebsite(client.website), location_code: 2840, language_code: 'en', limit: 1000
    }
    ])
  })
  if (!response.ok) throw new Error(`dataforseo HTTP ${response.status}`)
  const payload = await response.json(), taskStatus = payload?.tasks?.[0]?.status_code
  if (taskStatus && taskStatus >= 40000) throw new Error(`dataforseo: ${payload.tasks[0].status_message || taskStatus}`)
  return  {
    rows: mapDataForSeoResponse(payload, sitePages), cost: Number(payload?.tasks?.[0]?.cost ?? payload?.cost ?? 0) || 0
  }
}
module.exports =  {
  domainFromWebsite, itemPath, mapDataForSeoResponse, fetchDataForSeo
}
