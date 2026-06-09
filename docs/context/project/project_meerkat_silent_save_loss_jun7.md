---
name: meerkat-silent-save-loss-incident-jun-2026-phase-1-editor-guardrails
description: 2026-06-07 — editor lost ~40 min of edits on one article (1d2b2a3e) because his save never persisted; root cause not definitively known. Phase 1 fix shipped via PR
metadata: 
  node_type: memory
  type: project
---

**The incident.** Jose reported the public-share-link for one of four articles in his task showed the original AI-generated content instead of his edited version. The other three displayed correctly.

**Server-side findings (article `1d2b2a3e-f8a3-453f-95bb-8a6571e892eb`, "Chapter 7 Bankruptcy Attorney Davenport", client Henkels & Baker):**
- `article_outlines.updated_at` still set to the original generation timestamp (5/31). No write ever landed on this row since generation.
- `received_article.content` byte-identical to `cleaned content`.
- Zero rows in `article_revisions`.
- His other 3 articles in the same editing session: `updated_at` shifted to a few seconds before each feedback submission; `received_article.content != cleaned content`. So this was anomalous, not a global outage.

**Save path facts confirmed during diagnosis (durable):**
- Autosave lives in `web/client/components/ArticleEditor.tsx` (`triggerAutoSave` → `performAutoSave`). Debounced 1 second.
- Writes go **direct to Supabase via the JS client** (`saveArticleOutline` in `web/client/lib/storage.ts`). Not routed through any Netlify function or the VPS backend.
- Therefore: `article_outlines.updated_at` frozen at `created_at` is a reliable signal that no save ever landed for that row.
- The editor also has a `sessionStorage` cache keyed `article_cache_<articleId>` with a 5-min TTL — important for *recovery* (an editor's unsaved work may still be there if the tab is open).

**Root cause: not definitively known.** Three plausible mechanisms (ranked by fit):
1. Autosave never triggered — change handlers errored or never fired (best fit given zero writes since generation).
2. Autosave fired but Supabase rejected — would normally toast a "Save Failed" notice; user could miss it.
3. Edits applied to an outline whose `id` had been wiped client-side, so saves no-op'd or wrote to the wrong row.

**Phase 1 shipped (PR #68, merged 2026-06-07):**
- Explicit amber "Unsaved changes" state set in `triggerAutoSave` **before** the debounce delay — so the indicator reflects pending work the moment a change handler fires. Previously the indicator stayed green during the 1-second debounce window.
- `beforeunload` warning when `autoSaveStatus` is `unsaved`/`saving`/`error` (reactive add/remove based on state).
- "Saved at H:MM" timestamp on successful saves so editors can verify a save actually landed.

**Phase 2 (pending, gated on data).** Autosave-failure telemetry: log to a backend endpoint when autosave throws OR when the user appears to be editing but no autosave has fired in N seconds. Held until either Jose's browser yields clues during recovery, or a second incident hits with telemetry on. Premature reliability fixes risk breaking the path that works for 99% of saves.

**Recovery state at memory write:** pending Jose's response on whether his browser tab on the article is still open. Recovery message went out 2026-06-07.

## Diagnostic sequence for any similar future report

1. `select updated_at, created_at from meerkat.article_outlines where article_id = ?` — frozen at `created_at` = no save ever landed.
2. Compare `received_article->>'content'` vs `"cleaned content"` — byte-identical = no edits persisted.
3. Count rows in `meerkat.article_revisions` for that article_id — zero = no revision snapshots either.
4. If the user might still have the editor tab open: walk them through DevTools → Application → Session Storage → key `article_cache_<articleId>`. Value is JSON; their unsaved content lives inside.
5. Don't declare loss until 1–4 are exhausted. See [[feedback_data_loss_diligence]].
