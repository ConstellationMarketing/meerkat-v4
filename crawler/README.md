# Meerkat client sitemap crawler

A one-pass crawler and search-metrics bot. PM2 schedules a fresh process nightly; the process exits after completing the roster.

## Environment

Loaded from the repository-root `.env` through `dotenv`.

- `SUPABASE_URL`, `SUPABASE_KEY` (required; service-role access)
- `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` (optional)
- `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET`, `GSC_REFRESH_TOKEN` (optional)
- `CRAWLER_METRICS_INTERVAL_DAYS` (optional, default `7` for DataForSEO)
- `CRAWLER_UA` (optional, default `MeerkatCrawler/1.0 (+https://goconstellation.com)`)

Missing optional credentials skip that provider without stopping the crawl. GSC also requires each client to have a `gsc_property_url` that the OAuth identity can access.

## CLI

```sh
node crawler/index.js
node crawler/index.js --client "Bardazzi"
node crawler/index.js --no-metrics
node crawler/index.js --metrics-only
```

`--client` performs a case-insensitive substring match against roster names. `--no-metrics` crawls only; `--metrics-only` reads active stored pages and skips sitemap crawling.

## PM2

The `meerkat-crawler` ecosystem entry uses `cron_restart: '10 6 * * *'` (06:10 UTC), one fork, and no autorestart. Start or refresh it with:

```sh
pm2 startOrRestart ecosystem.config.js --only meerkat-crawler --update-env
```

## DataForSEO cost

DataForSEO uses one domain-level ranked-keywords request per eligible client, not one request per URL. The interval guard defaults to seven days. API-reported per-call cost and run total are logged; review DataForSEO pricing and account limits before enabling credentials.

## Tests

```sh
node --test crawler/test/
```

Tests inject mocked fetch implementations and make no network calls.
