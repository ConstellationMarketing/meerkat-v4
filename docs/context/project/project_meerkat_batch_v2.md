---
name: Meerkat batch generation v2 — shipped 2026-04-17
description: Admin CSV upload UI + sequential backend processing, shipped via meerkatv4 PR #32 and meerkatv3 PR #18
type: project
---
**Shipped 2026-04-17.** Replaces the ad-hoc April batch scripts.

**Backend (meerkatv4 PR #32):**
- `lib/batch.js` — orchestration module: `startBatch()`, `cancelBatch()`, `retryFailed()`, `getBatchStatus()`
- Sequential `runPipeline()` calls, 5s delay between articles, cancellation checks between each
- `server.js` — 4 new endpoints: POST /batch/start, GET /batch/status, POST /batch/cancel, POST /batch/retry
- /batch/start resolves clientInfo/website from `client_folders`, sections from `templates` table
- New `batch_jobs` Supabase table tracks progress, errors, CSV data for retry

**Frontend (meerkatv3 PR #18):**
- `client/lib/batch.ts` — API helpers + CSV parser with validation
- `client/components/BatchGenerateTab.tsx` — three-phase UI (upload+validate, progress, results)
- New "Batch Generate" tab in admin dashboard (4th tab)

**CSV format:** `keyword`, `clientName` required; `template` optional (defaults to practice-page)

**Key decisions:**
- Same pipeline as single articles — no quality difference
- No separate server — Node async means batch doesn't block single-article UI generation
- Progress via Supabase polling every 5s
- ~3 min per article = ~10 hours for 200 articles, acceptable

**How to apply:** Existing `batch-generate.js` and `batch-local.js` are deprecated. All batch generation goes through the admin dashboard UI.
