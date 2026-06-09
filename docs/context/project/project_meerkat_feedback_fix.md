---
name: Meerkat feedback Unknown Article fix
description: Fixed "Unknown Article" bug in editing_feedback — race condition, enrichment, backfill done 2026-04-02
type: project
---

**PRs merged 2026-04-02:**
- **meerkatv3 #13** — Disable feedback clock button until article data loaded (race condition fix), store `article_id` in feedback, display-time enrichment of missing titles/versions from `article_outlines`
- **meerkatv3 #14** — Fix enrichment query to use `article_id` column, not `id` (article_outlines PK is a short string, UUID is in `article_id`)

**Backfill completed:** 95 rows in `editing_feedback` updated with correct `article_id`, `article_title`, and `version`.

**Key schema detail:** `article_outlines.id` is a short string PK (e.g. `3ftk92ja0w`), while `article_outlines.article_id` is the UUID used in editor URLs. Always query by `article_id` when matching from frontend URLs.

**DB change:** Added `article_id TEXT` column to `editing_feedback` table in Supabase (done manually by Eli).

**Why:** Feedback was being submitted before async article fetch completed, writing "Unknown Article" permanently. The enrichment fallback also queried the wrong column.

**How to apply:** Future feedback queries should always join on `article_outlines.article_id`, never `article_outlines.id`.
