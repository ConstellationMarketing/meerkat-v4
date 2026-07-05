---
name: Meerkat GitHub publish token (VPS GITHUB_TOKEN)
description: Reference for the classic PAT the Meerkat VPS uses to push translated article HTML to ConstellationMarketing/os. Current holder, scope, expiration, rotation history, rotation procedure, and open question about whether this publish path should exist at all.
type: reference
---
## Purpose

Every time a Meerkat translation is generated (`lib/translate.js` → `lib/github-publish.js`), the VPS pushes the translated HTML to a subpath of a GitHub repo, which is then served as a static page at `internal.goconstellation.com/meerkat/*`. The token authorizes those push operations.

## Where it lives

- **File on VPS:** `/root/meerkat-service/.env`
- **Env var name:** `GITHUB_TOKEN`
- **Read by:** `lib/github-publish.js` (and `lib/translate.js` gates on its presence before invoking publish)

## Publish target

- **Repo:** `ConstellationMarketing/os` (formerly `ConstellationMarketing/internal` before that repo was renamed / consolidated into the OS monorepo)
- **Branch:** `main`
- **Path pattern:** `meerkat/<slug>/index.html` per translated article, plus a rolled-up `meerkat/index.json` catalog
- **Public URL:** `https://internal.goconstellation.com/meerkat/<slug>/`

## Current token

- **Type:** classic PAT (`ghp_...`)
- **Scope:** `repo` only (full control of private repositories — over-provisioned but standard for machine tokens; the only alternative is a fine-grained token with `Contents: Read/Write` scoped to `ConstellationMarketing/os`, which is stricter but more setup)
- **Holder:** Eli Curtin (`elicurtin` on GitHub)
- **Issued:** 2026-07-05
- **Expires:** 2027-07-02

## Rotation history

- **2026-03-09:** Original token issued by Patrick Carver when he built the publish pipeline
- **2026-04 (approx):** Original token expired; publish path was briefly considered deprecated (see `project_meerkat_github_pat.md` in personal-memory archive)
- **2026-05-26:** Someone reactivated the publish path — a new classic PAT was written to the VPS `.env`. Exact author not confirmed but likely Eli during active Meerkat maintenance.
- **2026-07-03:** GitHub org migration (ConstellationMarketing user account → organization) invalidated the token. Publishes broken silently — no publishes had fired in the ~30 hours between the last successful one (Jul 3 14:12 UTC) and detection.
- **2026-07-05:** Reissued under Eli's account. This is the current active token.

## Rotation procedure (when the current token expires or needs rotation)

1. **New holder decides who owns going forward.** Long-term, this should probably be whoever holds the Meerkat technical-owner role — the token doesn't need to stay with Eli. Rotate at handoff.
2. **Issue new classic PAT** at https://github.com/settings/tokens under the chosen account. Scope: `repo` only. Note: `Meerkat publish (VPS) — issued YYYY-MM-DD`. Expiration: 1 year forward.
3. **Confirm the token has read+write on `ConstellationMarketing/os`** via a quick API test:
   ```
   curl -sI -H "Authorization: Bearer <token>" https://api.github.com/repos/ConstellationMarketing/os
   # expect: HTTP/2 200
   ```
4. **Update VPS `.env`:**
   ```
   ssh root@45.55.248.2
   cp /root/meerkat-service/.env /root/meerkat-service/.env.bak.$(date +%s)
   sed -i 's|^GITHUB_TOKEN=.*|GITHUB_TOKEN=<new token>|' /root/meerkat-service/.env
   pm2 restart meerkat --update-env
   ```
5. **Update this file's "Current token" section** with the new holder and expiration.

## Open question worth surfacing

An old memory (`project_meerkat_github_pat.md`, dated 2026-04-07) recorded that this publish path was **deprecated and not needed** — the theory being that the meerkatv3 frontend (now `meerkat-v4/web/`) reads directly from Supabase, so the GitHub-Pages-style static publish is redundant. Yet the publish path came back into active use ~7 weeks later and has been running since.

Whoever owns Meerkat should decide whether to:
- **Keep** the publish path (there may be a downstream consumer we haven't mapped — Divi? external readers of `internal.goconstellation.com/meerkat/*`?)
- **Remove** it entirely (delete `lib/github-publish.js`, drop the `GITHUB_TOKEN` env var, remove the fire-and-forget call from `lib/translate.js`)

Making a decision here would eliminate the ongoing token-rotation obligation. Related: `feedback_llm_html_in_json_fragile.md` (translator contract) and the broader translation-workflow decisions we're currently thinking through with per-client opt-in.
