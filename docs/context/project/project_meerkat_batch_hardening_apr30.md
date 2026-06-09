---
name: Meerkat batch generation hardening for May 1 production run
description: 2026-04-30 push to make batch v2 actually work + add retry/UX/visibility before Jacqueline's full May 1 batch — 5 PRs across both repos
type: project
---
**Trigger (2026-04-30):** Jacqueline planned a hundreds-of-articles batch run for 2026-05-01 (the team's first real use of batch v2). Investigation revealed batch v2 had **never run successfully end-to-end since shipping 2026-04-17** — the `batch_jobs` table was empty.

**Why:** First-of-its-kind production run with real cost and visibility. Failures Friday would've been catastrophic for trust + economics.

**How to apply:** When suggesting batch-related changes, the batch flow is now: list view (canonical home) → "+ New Batch" (creation flow) → upload + validation → start → progress phase → results. Persistent banner across all admin tabs. Retry is per-article via checkboxes or batch-level via row button.

---

## What got shipped 2026-04-30

| PR | Repo | Closes |
|---|---|---|
| #45 | meerkatv4 | ReferenceError fix in lib/batch.js (7 occurrences); fail-loud template validation in /batch/start; active-batch lock; orphan-detection on VPS startup |
| #46 | meerkatv4 | parseJSON trailing-prose bug (was silently dropping every external link); capH3Density 2→5 (was demoting Why Choose Us H3s); H2 threshold off-by-one; H3 cap conflict in section-writer.md; broader SCAFFOLD detection; statute-repair logging |
| #34 | meerkatv3 | Batch UI inversion: list view as canonical home, "+ New Batch" as flow, expand row to see articles with View links |
| #35 | meerkatv3 | Retry mechanics: per-failure checkboxes, Select All, "Retry Selected", "Retry All Failed" quick button on row, persistent BatchActivityBanner across admin tabs |
| #47 | meerkatv4 | /batch/retry accepts optional articleKeywords filter; preserves total_articles + completed_count across retries (was destroying historic metrics) |
| #48 | meerkatv4 | Template name fuzzy-match: "Practice Page" / "Supporting Page" / "practice-page" all resolve via alias map of id + name + normalized variants |
| #36 | meerkatv3 | Validation table shows "Resolves to" column; Start gated with "Waiting for current batch" message but upload+validation allowed concurrently; "Submitted by" column + banner attribution via team_members lookup |

All 7 PRs merged same day.

## Key non-obvious findings

1. **Batch v2 had been broken since 2026-04-17.** The `batch_jobs` table was empty when investigation started — nobody had used it. The 7 ReferenceErrors in lib/batch.js (bare `supabase` should have been `getSupabase()`) would have crashed every run at the first DB read inside the loop. Caught only because Jacqueline planned a real batch.
2. **`parseJSON` trailing-prose bug was silently dropping every external link** the model generated. The chronic "No external links — editor must add manually" warning across V4.0.4 was ALL caused by Claude returning valid JSON with trailing prose like "I hope this helps!", failing JSON.parse. Fix is a bracket-balance walker.
3. **`capH3Density()` ran 5 times in the pipeline and silently demoted Why Choose Us H3s** from 3–5 (per the rich brief) down to 2 by converting H3s beyond the 2nd into `<p><strong>`. Was masking the depth improvements from PR #31's frontend templates.
4. **`callClaude` doesn't log token usage.** Repeating from prior memory: per-article cost is not measurable from logs without adding `msg.usage` capture.
5. **One naturally failed article in the smoke test (DWI Lawyer Springfield)** failed because the SCAFFOLD quality gate from PR #40 caught a scaffold leak — gate working as designed.

## Current architecture

- **Single source of truth for templates:** Supabase `templates` table. Frontend's `client/lib/templates.ts` is fallback only (used by ArticleForm; not by the batch path).
- **Batch path: frontend → /batch/start → server.js validates clients + templates (with fuzzy match) → enriches articles → inserts batch_jobs row → fires startBatch() in background → returns 202 immediately.**
- **`startBatch()` (lib/batch.js):** sequential loop with 5s delay, per-article cancellation check, per-article success/failure recording.
- **Active-batch lock:** /batch/start refuses (409) if another batch is `processing`. Lock released when status transitions to completed/failed/cancelled/orphaned.
- **Orphan sweep:** server.js calls `markOrphanedBatches()` on app.listen(). Marks any `processing` rows from a prior process as `orphaned` so the active-batch lock doesn't permanently block new batches after a VPS restart.
  - **Gotcha (discovered 2026-05-02):** orphan-detection sets `status='orphaned'` but does NOT populate `errors[]` for the unfinished articles. The retry mechanism only sees `errors[]`, so "Retry All Failed" only retries actual quality-gate failures, not orphaned batch contents. To enable retry of orphaned articles, manually augment `errors[]` for everything in `csv_data` minus successfully-completed `article_outlines` rows. Also delete partial `article_outlines` rows where `received_article->>'content'` is null. See `batch-2026-05-02-e29676ff` cleanup as the canonical pattern. Future: bake this into orphan-detection itself.
- **Retry semantics:** `/batch/retry` accepts optional `articleKeywords[]`. Removes those keywords from `errors[]` and decrements `failed_count`. Preserves `total_articles` and `completed_count` so historic metrics survive.

## Reference PRs
- meerkatv4 PRs: https://github.com/ConstellationMarketing/meerkatv4/pull/45 #46 #47 #48
- meerkatv3 PRs: https://github.com/ConstellationMarketing/meerkatv3/pull/34 #35 #36

## What's still deferred / not done

- **Token usage logging in `callClaude`** for per-article cost visibility — not done; ~10-line addition.
- **True batch queueing** (multiple batches lined up) — explicitly deferred. Block-and-prep-while-waiting was preferred over queue-management complexity.
- **Frontend Friday monitoring cheat-sheet** drafted inline 2026-04-30 conversation; format (markdown vs Word doc vs both) not finalized — Eli moved on without committing.
