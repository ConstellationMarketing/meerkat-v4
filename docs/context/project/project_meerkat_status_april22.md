---
name: Meerkat status 2026-04-22
description: Current state of Meerkat after a heavy day of work — time tracking trusted and live, heading regressions fixed, admin feedback table redesigned, migration to OS still in progress
type: project
---
**Supersedes project_meerkat_status_april21.md.**

**Shipped today (2026-04-22):**

**Time tracking (meerkatv3 PRs #24-29):**
- Full hardening of `useActivityTimer`: isTrusted filter, visibility/blur pausing, capture-phase listeners, expanded event set, 60s idle, localStorage persistence, article-switch bleed fix, pause when feedback modal opens.
- Vitest + jsdom test harness added (35 tests passing). Event helpers at `client/test/events.ts`.
- Admin dashboard: Tracked Time column in HH:MM matching Reported Time, anomaly flags, feedback table redesigned (column renames, widths, Issues moved to far right with stateful expand/collapse).
- Historical `tracked_time_seconds` values zeroed out — fresh baseline from today.
- Team aligned: internal barometer, don't flag to editors (see `project_meerkat_time_tracking.md`).

**Heading enforcement (meerkatv4 PRs #38-39):**
- V4.0.4 heading regressions fixed. See `project_meerkat_heading_loosening.md`.

**Still open / next priorities:**
1. **Migration to Constellation OS** — unchanged from 2026-04-21: build frontend for VPS, Nginx config for meerkat subdomain, repoint auth to master, Patrick flips DNS. All Netlify function ports done; app_access table seeded.
2. **Watch time-tracking patterns** over the next few weeks for editor-specific divergence.
3. **SPR dashboard** — on back burner; Google Ads forward-looking data integration is the remaining unblock.

**Repos:** `~/meerkatv3-repo` (frontend, Netlify auto-deploys on merge), `~/meerkatv4` (backend, VPS auto-deploys via GitHub Action on merge).

**Team:** Patrick (CEO), Jacqueline, Lindsay — group chat is the primary channel for Meerkat updates.
