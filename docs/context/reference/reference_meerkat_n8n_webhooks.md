---
name: Meerkat n8n webhooks
description: n8n webhook URLs used by the Meerkat frontend and which flows depend on each — first thing to check when articles hang on "Generating Article"
type: reference
---
**Host:** `https://n8n-14lp.onrender.com` (Render-hosted n8n instance)

**Webhook URLs and what uses them:**
- `/webhook/94a33159-2ed6-412b-83ea-fac644344216` — primary article generation for all clients except Carver. Called by `sendOutlineToWebhook` → `sendWebhookPayload` in `client/lib/webhook.ts`. **If this 404s, all article generation breaks with the toast: "Article outline created but failed to send to webhook" (ArticleForm.tsx:320).**
- `/webhook/constellation` — article generation for Carver & Associates. Called by `sendConstellationWebhook` in `client/lib/webhook.ts:351`.
- `/webhook/7efaa419-4106-4ef4-91a1-cab3b70b1f3b` — local dev only (Express `/api/webhook/send-outline`, `server/index.ts:310`). Safe to ignore in prod.
- `/webhook/decb968b-7b9c-4046-a18e-933c6879fb8c` — daily 9am unedited-articles email report (`server/index.ts:122`). Silently fails if deactivated.

**Diagnosing "Generating Article" hangs:**
1. Check the toast text — "failed to send to webhook" = n8n issue, not pipeline.
2. `curl -X POST <url> -d '{"ping":"healthcheck"}'` — 404 means the n8n workflow toggle is off. Response body tells you directly: *"The workflow must be active for a production URL to run successfully."*
3. Fix: log into n8n and re-enable the workflow toggle. No code change needed.

**Note:** The meerkat VPS backend (`pm2 list` → meerkat) is a separate concern — it generates the actual article content. n8n is the orchestrator that receives the outline from the frontend and calls the backend. A healthy meerkat process in PM2 does not mean the end-to-end flow works.
