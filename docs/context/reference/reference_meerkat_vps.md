---
name: Meerkat VPS reference
description: VPS access, deployment, and infrastructure details for the Meerkat pipeline server at 45.55.248.2
type: reference
---
**VPS:** `45.55.248.2` (DigitalOcean), SSH as `root`
**Meerkat service:** `/root/meerkat-service/`
**Process manager:** PM2 (`pm2 list` to check, `pm2 restart meerkat` to restart)
**Node version:** v22.22.0
**Timezone:** UTC
**Port:** 3000

**Env vars:** `/root/meerkat-service/.env` — contains ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_KEY, SUPABASE_TABLE=article_outlines, GITHUB_TOKEN (for publishing to ConstellationMarketing/internal), GMAIL_USER, GMAIL_APP_PASSWORD, REPORT_RECIPIENTS

**Other services on VPS:** claude-web, spr0, super-audit

**Deployment:** Automated via "Deploy to VPS" GitHub Action — merging to main triggers auto-deployment. No manual sync needed.

The action runs (post PR #52, 2026-05-01): `set -euo pipefail` → `git fetch origin main` → `git reset --hard origin/main` → `npm install --omit=dev` → `pm2 restart meerkat --update-env`. Any command failure now surfaces as a failed action run. Local drift on the VPS is discarded automatically each deploy — don't rely on the VPS filesystem to preserve local edits.

**Historical note:** Between roughly 2026-04-22 and 2026-05-01, the action silently swallowed `git pull` failures (no `set -e`) and reported success while restarting against old code. PRs #46–#50 were affected. Fixed in PR #52. See `project_meerkat_deploy_silent_failure_may1.md` for the full incident.
