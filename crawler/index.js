'use strict'
const path = require('node:path')
require('dotenv').config( {
  path: path.join(__dirname, '..', '.env')
})
const  {
  createClient
}
= require('@supabase/supabase-js')
const  {
  loadRoster
}
= require('./lib/roster')
const  {
  crawlSitemap
}
= require('./lib/sitemap')
const  {
  getPageType
}
= require('./lib/pagetype')
const  {
  saveCrawl, getStoredPages, hasRecentSnapshot, insertMetrics
}
= require('./lib/store')
const  {
  fetchDataForSeo
}
= require('./lib/metrics-dataforseo')
const  {
  getAccessToken, fetchGsc
}
= require('./lib/metrics-gsc')
function parseArgs(argv)  {
  const out =  {
    client: null, noMetrics: false, metricsOnly: false
  }
  for (let i = 0;
  i < argv.length;
  i++)  {
    if (argv[i] === '--client')  {
      if (!argv[i + 1]) throw new Error('--client requires a substring');
      out.client = argv[++i]
    }
    else if (argv[i] === '--no-metrics') out.noMetrics = true
    else if (argv[i] === '--metrics-only') out.metricsOnly = true
    else throw new Error(`unknown flag: ${argv[i]}`)
  }
  if (out.noMetrics && out.metricsOnly) throw new Error('--no-metrics and --metrics-only cannot be combined')
  return out
}
function metricRows(clientId, source, rows)  {
  const date = new Date().toISOString().slice(0, 10);
  return rows.map(row => ( {
    client_id: clientId, metric_date: date, source, ...row
  }))
}
async function main()  {
  const flags = parseArgs(process.argv.slice(2))
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) throw new Error('SUPABASE_URL and SUPABASE_KEY are required')
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY,  {
    auth:  {
      persistSession: false
    }
  })
  let clients = await loadRoster(supabase)
  if (flags.client) clients = clients.filter(c => (c.name || '').toLowerCase().includes(flags.client.toLowerCase()))
  const dfsCredentials = process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD ?  {
    login: process.env.DATAFORSEO_LOGIN, password: process.env.DATAFORSEO_PASSWORD
  }
  : null
  const gscCredentials = process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET && process.env.GSC_REFRESH_TOKEN ?  {
    clientId: process.env.GSC_CLIENT_ID, clientSecret: process.env.GSC_CLIENT_SECRET, refreshToken: process.env.GSC_REFRESH_TOKEN
  }
  : null
  if (!flags.noMetrics && !dfsCredentials) console.log('metrics: dataforseo skipped (no credential)')
  if (!flags.noMetrics && !gscCredentials) console.log('metrics: gsc skipped (no credential)')
  const interval = Number(process.env.CRAWLER_METRICS_INTERVAL_DAYS) || 7, userAgent = process.env.CRAWLER_UA || 'MeerkatCrawler/1.0 (+https://goconstellation.com)'
  let gscTokenPromise = null, totalUrls = 0, totalNew = 0, totalGone = 0, totalDfsPages = 0, totalGscPages = 0, totalCost = 0
  const failed = [];
  let attempted = 0
  for (const client of clients)  {
    if (!String(client.website || '').trim())  {
      console.log(`- ${client.name} — skipped (no website)`);
      continue
    }
    attempted++
    try  {
      let changes =  {
        newPages: [], goneUrls: []
      }, pages
      if (!flags.metricsOnly)  {
        const crawled = await crawlSitemap(client.website,  {
          userAgent, log: console.log
        })
        if (!crawled.length) throw new Error('sitemap returned zero usable URLs')
        changes = await saveCrawl(supabase, client.id, crawled, getPageType)
        pages = crawled.map(p => ( {
          url: p.url, path: p.path
        }))
      }
      else pages = await getStoredPages(supabase, client.id,  {
        activeOnly: true
      })
      totalUrls += pages.length;
      totalNew += changes.newPages.length;
      totalGone += changes.goneUrls.length
      let dfsText = flags.noMetrics ? 'skipped (--no-metrics)' : 'skipped (no credential)'
      let gscText = flags.noMetrics ? 'skipped (--no-metrics)' : 'skipped (no credential)'
      if (!flags.noMetrics && dfsCredentials)  {
        if (await hasRecentSnapshot(supabase, client.id, 'dataforseo', interval)) dfsText = 'skipped (recent snapshot)'
        else  {
          try  {
            const result = await fetchDataForSeo(client, pages, dfsCredentials);
            await insertMetrics(supabase, metricRows(client.id, 'dataforseo', result.rows));
            totalDfsPages += result.rows.length;
            totalCost += result.cost;
            dfsText = `${result.rows.length} pages, $${result.cost.toFixed(2)}`
          }
          catch (error)  {
            dfsText = `error (${error.message})`
          }
        }
      }
      if (!flags.noMetrics && gscCredentials)  {
        if (!String(client.gsc_property_url || '').trim()) gscText = 'skipped (no property)'
        else if (await hasRecentSnapshot(supabase, client.id, 'gsc', 1)) gscText = 'skipped (recent snapshot)'
        else  {
          try  {
            gscTokenPromise ||= getAccessToken(gscCredentials);
            const result = await fetchGsc(client.gsc_property_url, pages, await gscTokenPromise);
            if (result.noAccess) gscText = 'skipped (403 no access)';
            else  {
              await insertMetrics(supabase, metricRows(client.id, 'gsc', result.rows));
              totalGscPages += result.rows.length;
              gscText = `${result.rows.length} pages`
            }
          }
          catch (error)  {
            gscText = `error (${error.message})`
          }
        }
      }
      console.log(`✔ ${client.name} — ${pages.length} urls (${changes.newPages.length} new, ${changes.goneUrls.length} gone) | dfs: ${dfsText} | gsc: ${gscText}`)
    }
    catch (error)  {
      failed.push(`${client.name}: ${error.message}`);
      console.log(`✖ ${client.name} — ${error.message}`)
    }
  }
  console.log('\nTotals')
  console.log(`clients: ${attempted - failed.length}/${attempted} succeeded | urls: ${totalUrls} | new: ${totalNew} | gone: ${totalGone}`)
  console.log(`metrics: dfs ${totalDfsPages} pages, $${totalCost.toFixed(2)} | gsc ${totalGscPages} pages`)
  console.log(`failed clients: ${failed.length ? failed.join('; ') : 'none'}`)
  if (attempted > 0 && failed.length === attempted) process.exitCode = 1
}
main().catch(error =>  {
  console.error(error.message);
  process.exitCode = 1
})
