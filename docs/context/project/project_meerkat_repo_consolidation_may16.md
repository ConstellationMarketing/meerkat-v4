---
name: Meerkat repo consolidation — half-done, blocked on Patrick
description: COMPLETE 2026-05-31 — meerkatv3 merged into meerkatv4/web/ (PR #60, 5/16) + Netlify relinked to v4 (5/31). Production frontend now serving from meerkatv4. meerkatv3 repo frozen, scheduled for archive after ~1 week soak (~2026-06-07). Old Meerkat Supabase decommission still pending separately.
type: project
---
**Status (2026-05-31):** ✅ **COMPLETE.** Netlify is serving production frontend from meerkatv4/web/. URL stayed `meerkatv3.netlify.app` (relinked existing site, not a new site, so env vars + custom domain bindings inherited). Smoke test passed 6/7 (login, articles list, article edit save, batch start, CSV export render — and the curl checks confirmed function endpoints + SPA bundle). Vietnamese translation smoke deferred because PR #65 was already independently verified post-merge via the stuck-Lilburn re-run.

**Original status (2026-05-16):** repo merge done on the git side, blocked on Netlify reconfiguration.

## What got done
- **Pre-cleanup**: deleted ~19 merged branches on meerkatv4 + ~20 on meerkatv3. Both repos now only have `main`.
- **One orphaned commit recovered**: `scripts/retranslate-existing.js` from the never-fully-merged `fix/translate-edited-version` branch got cherry-picked to main via PR #59 (preserved as a recovery artifact, mirroring `scripts/migration/restore-missing-articles.js`).
- **Playbook landed**: `docs/merge-meerkatv3-playbook.md` merged to main via PR #58.
- **Subtree merge done** (PR #60, merged): `git read-tree --prefix=web/ -u v3/main` imported 193 files from meerkatv3 into `meerkatv4/web/` with full history preserved. Accessible via `git log -- web/<file>` and `git blame web/<file>`. Stripped `web/.env` (only had a public Builder.io key but bad hygiene).

## Current state
- meerkatv4 main has the merge: backend at root (`server.js`, `lib/`, `routes/`, etc.), frontend under `web/`.
- meerkatv3 repo: untouched, still wired to Netlify, still serving production.
- **Production is normal** — Netlify builds from meerkatv3 repo (which hasn't changed). No user-visible impact.

## Blocker
Netlify needs to be re-linked from `ConstellationMarketing/meerkatv3` → `ConstellationMarketing/meerkatv4` (with **Base directory = web**). Eli hit a permissions wall:
- Netlify's GitHub App is installed on his personal account, not on the ConstellationMarketing org.
- "Link to a different repository" in Netlify only shows personal repos.
- Eli doesn't have org-admin rights to install/configure GitHub Apps on `ConstellationMarketing`.

**Patrick's been asked** (2026-05-16 morning) to either:
1. Configure the Netlify GitHub App on the org directly (ConstellationMarketing → Settings → GitHub Apps → Netlify → add meerkatv4 to repository access), OR
2. Grant Eli permission to install GitHub Apps on the org so Eli can handle.

No urgency communicated. Can wait until Monday.

## Resume sequence (when unblocked)

1. **Netlify dashboard** → meerkatv3 site → Project configuration → Build & deploy → Continuous deployment → **Manage repository → Link to a different repository** → select `ConstellationMarketing/meerkatv4`.
2. **Base directory**: `web`. Build command + Publish directory auto-pick from `web/netlify.toml`.
3. Save → Netlify auto-deploys from meerkatv4/web → wait ~2 min.
4. Verify live: login works, articles list, save an edit, batch flow works.
5. If broken: revert Netlify's Repository setting back to `meerkatv3` (the old repo is intact and will resume normal builds).

## After verification holds for ≥1 week
- Archive meerkatv3 (GitHub Settings → Archive). Don't delete; keep as historical artifact.
- Old Meerkat Supabase project (`fcdotdpzmjbmsxuncfdg`) also still pending decommission (~2026-05-17 onwards).

## 2026-05-31 cutover — how it happened

Eli's GitHub permissions on `ConstellationMarketing` couldn't be elevated to org-admin, so Patrick (org admin) drove the Netlify UI work himself. His first config attempt had **base directory blank**, which would have failed the build (the meerkatv4 repo has backend at root, frontend under `web/` — base must be `web` so Netlify picks up `web/netlify.toml`). Eli also flagged the ambiguity between "new Netlify site" and "relink existing site." Patrick confirmed he relinked the existing meerkatv3 site to v4 (the right call — inherits env vars, custom domain bindings, keeps the URL).

After base=web was set, the manual triggered deploy went green:
- `pnpm install` clean in `web/`
- `pnpm run build:client` succeeded
- Functions (15 .ts files) bundled via esbuild
- Site went live at 3:49 PM ET

Confirmed serving from v4 via three signals: SPA bundle hash changed, `/team-members` function endpoint returned 200, and the "Export CSV" button (shipped in v4 PR #66 only) rendered on the admin dashboard. That last signal is the cleanest "is Netlify on v4?" tell.

## Operational changes effective immediately

- **meerkatv3 repo is FROZEN.** Netlify no longer watches it. All future frontend PRs go to `meerkatv4/web/` only. Don't merge to v3 main — it'll be a no-op for production and accumulate drift.
- **The dual-shipping pattern** (PR #45 to v3 + PR #66 to v4 for the same CSV export change) was a one-time bridge while the cutover was in flight. It does not continue.
- **Backend deployment is unchanged** — still GH Action on meerkatv4 → SSH into VPS → pull main → npm install → pm2 restart.
- **Custom domain** `meerkat.goconstellation.com` was discussed with Patrick (CNAME → `meerkatv3.netlify.app` or A → `75.2.60.5`) but not committed yet. Patrick may set it up; if so, add as a custom domain in the Netlify site config so the cert provisions automatically.

## Note on the unmerged-from-Netlify state
PR #60 merged to meerkatv4 main BEFORE Netlify was reconfigured. That's fine — Netlify still points at meerkatv3 (untouched), so prod is unaffected until the source is flipped. Order doesn't matter because:
- Backend (meerkat-service VPS) deploys from meerkatv4 root regardless of where frontend lives — unchanged.
- Frontend Netlify build is keyed off whichever repo Netlify is linked to. The meerkatv3 repo is still building the live site.
