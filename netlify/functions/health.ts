// Netlify Function — exposes /health for the OS Health Check Bot Worker.
//
// Why this exists as a Netlify Function instead of the Express route in
// ../server.js:
//   Netlify doesn't run the Node Express server — only static files +
//   Netlify Functions. So `app.get('/health', ...)` in server.js is dead
//   code from the Netlify deploy's perspective. Hitting meerkatv3.netlify.app/health
//   was being caught by the SPA fallback and returning the React app HTML
//   instead of JSON, which the OS Worker couldn't parse.
//
// netlify.toml's redirect routes /health → this function, so it serves the
// canonical JSON contract from the OS repo's wiki/infra-health-protocol.md:
//   { ok: true, ts: <epoch ms>, build: <tag>, env: { KEY: bool, ... } }
// Boolean env-var presence only — never the values.

import type { Handler } from "@netlify/functions";

const BUILD_TAG = "meerkatv4-2026-06-04";

export const handler: Handler = async () => ({
  statusCode: 200,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    ok:    true,
    ts:    Date.now(),
    build: BUILD_TAG,
    env: {
      SUPABASE_URL:         !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
      SUPABASE_TABLE:       !!process.env.SUPABASE_TABLE,
      OPENROUTER_API_KEY:   !!process.env.OPENROUTER_API_KEY,
      ANTHROPIC_API_KEY:    !!process.env.ANTHROPIC_API_KEY,
    },
  }),
});
