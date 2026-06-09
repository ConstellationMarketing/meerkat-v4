---
name: Meerkat Supabase Disk IO budget incident + remediation
description: 2026-04-23 Supabase "unhealthy" outage caused by Disk IO budget exhaustion; PR #30 ships #1 + #3 fixes; #2 + #4 scoped but deferred
type: project
---
**Incident (2026-04-23):** Meerkat Supabase project (`fcdotdpzmjbmsxuncfdg`) went "unhealthy"; all table queries hung at the API layer while Supabase gateways (auth, storage, REST root) stayed responsive. Symptoms: app stuck on Loading spinner, all admin users lost admin access (because `getUserRole` → `getTeamMembers` hung). Patrick rebooted the project and it returned to healthy. Supabase email later confirmed root cause: **Disk IO budget exhaustion**, not disk space. The reboot only cleared the queue — the underlying IO burn rate was unaddressed and would recur.

**Why:** Without remediation, the next sustained-load cycle exhausts IO budget again and the database goes unhealthy. Patrick is tracking unit economics on Meerkat (per `project_meerkat_batch_costs.md`); a paid compute upgrade is a real lever but worth doing IO reductions first.

**How to apply:** When suggesting Meerkat changes that hit Supabase (new queries, polling, batch jobs), default to "is this IO-cheap?" — prefer narrow `.select()` projections, push filters to SQL, avoid sub-60s polling.

---

## Shipped in PR #30 (perf/reduce-supabase-io-burn, opened 2026-04-26)

**#1 — Cron N+1 fix** (`server/index.ts`, daily 9 AM unedited-articles webhook)
- The per-team-member loop was refetching the entire `article_outlines` table on every iteration (`.select("*")` with no filter, identical result each time).
- Hoisted the fetch out of the loop; trimmed projection to `article_id, keyword` (the only columns downstream filter/map uses).
- Behaviorally identical — verified by reading the loop body.

**#3 — Translation poll interval** (`client/components/TranslationControls.tsx`)
- Bumped polling interval from 3s → 10s.
- Polling only runs while a translation is in-flight (post user click); translations take minutes, so ~7s tail latency on completion is acceptable. ~3x IO reduction during in-flight polling.

---

## Deferred — needs more thought before changing

**#2 — ArticleEditor 3s polling** (`client/components/ArticleEditor.tsx:696`)
- **What it does:** Polls Supabase every 3s while the editor is mounted to detect when the article generation pipeline finishes and writes back the generated content.
- **Why we didn't bump it:** A blunt bump to 10s+ degrades the most user-facing flow — users would wait 7+ extra seconds to see a generated article appear in the editor. Existing code comment notes that polling faster than 3s caused "Failed to fetch" errors, suggesting 3s was already a tuned floor.
- **Right fix (when revisited):** Smarter polling — fast cadence (3s) for the first ~60s after a known generation kick-off, back off to 15–30s when idle. Or replace with realtime subscription / webhook push from the VPS backend. Either is a real change, not a one-liner.
- **Why this matters for IO:** Multiple concurrent editors compound the burn. Likely the second-largest steady-state IO source after the cron.

**#4 — Public share lookup full-table scan** (`netlify/functions/get-article.ts:136`)
- **What it does:** When a public share URL uses `clientName + keyword` (instead of `articleId`), the function does `.select("*")` with no WHERE clause, then filters in-memory.
- **Why we didn't simplify it:** The current code has a fallback path — exact match first, then partial substring match (with comment "in case of encoding issues"). A naive `.eq()` replacement loses the partial-match fallback and could break shared links that depend on it.
- **Right fix (when revisited):** Use `.ilike("%${value}%")` with the same OR fallback logic, or move the entire match-with-fallback to a single SQL expression. Need to preserve the partial-match semantics.
- **Why this matters for IO:** Per-click cost on a high-traffic endpoint (public shares). Compounds during traffic spikes.

---

## Lower priority (also deferred, agent-flagged as low impact)

- **#5 batch-generate.js:208** — re-scans `article_outlines` per batch run. Lower frequency; defer.
- **#6 server/index.ts:398-401 webhook handler** — over-fetches on per-article callback. ~16 bytes per row savings, cosmetic.

---

**Where to verify impact:** Supabase dashboard → Reports → Database → Disk IO. The cron change shows up after the 9 AM run; translation change shows up only when translations are running.

**Reference:** PR #30 — https://github.com/ConstellationMarketing/meerkatv3/pull/30
