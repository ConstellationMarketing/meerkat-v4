---
name: netlify.toml [build.environment] overrides Netlify UI env vars
description: When migrating Supabase URLs (or any VITE_* config), ALWAYS audit netlify.toml — values in the [build.environment] block override anything set via the Netlify dashboard
type: feedback
---
**Rule:** When migrating a Supabase project (or changing any `VITE_*` env var), always check `netlify.toml` for a `[build.environment]` block FIRST. Values there override whatever is set in the Netlify UI.

**Why:** During the master DB cutover (2026-05-02), `netlify.toml:8` had `VITE_SUPABASE_URL = "https://fcdotdpzmjbmsxuncfdg.supabase.co"` (old Meerkat) hardcoded. We updated the Netlify UI env var to point at master, triggered a redeploy, and login still failed with "Invalid API key" — because the deployed bundle used the toml value, not the UI value. The new master legacy anon key was being sent against the OLD Meerkat URL. Cost ~30 min to diagnose mid-cutover with users blocked.

**How to apply:**
- Before changing Netlify dashboard env vars for a deploy, `grep -n "VITE_\|SUPABASE_\|<your var>" netlify.toml` in the repo.
- If it's there, update the toml value (in code, via PR) — the UI value alone won't take effect.
- This applies to any build-time env var. Runtime function env vars (read inside Netlify functions at request time) ARE picked up from the UI without rebuild.
