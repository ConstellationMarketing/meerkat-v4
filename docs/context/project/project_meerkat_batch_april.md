---
name: Meerkat April 2026 Batch Generation
description: Batch generation of 211 articles from assigned keywords spreadsheet — process, tooling, and lessons learned
type: project
---

Completed 2026-03-31/04-01. Generated 211 articles programmatically from Jacqueline's "April Assigned Keywords" spreadsheet (55 clients, 97 Practice Pages, 114 Supporting Pages).

**Batch ID:** `april-2026-assigned-keywords-run-2026.03.31` (stored in `batch_id` column on `article_outlines`).

**Tooling built:**
- `batch-generate.js` — seeds outlines to Supabase, triggers VPS pipeline, monitors status, supports rollback via `--rollback`
- `batch-local.js` — runs pipeline locally with per-article validation and retry (up to 3 attempts), only upserts verified articles. This was the reliable approach after VPS rate limiting caused mass failures.
- Both scripts live in `/Users/elicurtin/meerkatv4/`

**Key lessons:**
- VPS pipeline is fire-and-forget — no queue, no concurrency control. 211 concurrent articles = ~4000+ Claude API calls = massive rate limiting.
- Pipeline upserts garbage (failed sections) to Supabase with no quality gate — fixed in PR #19.
- Local generation (one at a time, ~8 min/article) was the reliable path. Took ~5.5 hours for 41 retries.
- localStorage caching in the frontend can serve stale data, overriding good Supabase data.

**Output:** `/Users/elicurtin/Downloads/April Assigned Keywords - Complete with Editor URLs.xlsx` — same format as input with Editor URL column added.

**Why:** Jacqueline sourced all April article inputs from editors. Batch process saves manual creation time and enables programmatic QA.

**How to apply:** For future batches, use `batch-local.js` (not VPS). The `batch_id` column enables filtering and rollback. Template names in spreadsheet may differ slightly from Supabase names (e.g., "Supporting Page" → "Supporting/Resource Page").
