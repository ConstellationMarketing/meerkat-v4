---
name: Autosave must stay wired to the editor change handlers
description: The editor's autosave infrastructure (triggerAutoSave → performAutoSave → saveArticleOutline → Supabase) only works if the content/title/meta change handlers actually call triggerAutoSave. Disconnecting it produces silent edit loss with no error signal. Defended by inline warnings + canary telemetry; verify both still alive on any future editor refactor.
type: feedback
---
**Rule:** In `web/client/components/ArticleEditor.tsx`, the autosave system is a chain: `handleArticle{Content,Title,Description}Change` → `triggerAutoSave(updated)` → debounced `performAutoSave` → `saveArticleOutline` → Supabase. **Every change handler must call `triggerAutoSave`.** Disconnecting any link silently destroys editor work — there's no error toast because there's no error.

**Why:** 2026-06-09 — discovered that for ~3 months (since a Builder.io commit on 2026-03-04 titled "Disable auto-save and require explicit save button click", no documented rationale), the three change handlers had a `// NO AUTO-SAVE: Just backup to localStorage, don't call Supabase until Save button is clicked` comment and just didn't call `triggerAutoSave`. Editors' work only persisted if they manually clicked Save. The green "✓ Saved" indicator was lying — nothing in the state machine ever moved off `idle`. PR #68 (June 7) added an "Unsaved changes" state and a `beforeunload` guard but both hung off the same dead `triggerAutoSave` and were also silently inactive. PR #70 (June 9) reconnected the chain. PR #71 added inline warnings, a `meerkat.autosave_telemetry` table, a Netlify function (`/.netlify/functions/autosave-telemetry`), and a periodic canary in the editor that posts `edits_without_saves` after ≥3 edits with zero successful saves in ≥60s — so the same failure mode surfaces fast next time.

**How to apply:**
- If you refactor the editor and find yourself moving change-handler logic, make sure the new path calls `triggerAutoSave(updated)`. Verify by typing in the editor and watching DevTools → Network for a request to `/rest/v1/article_outlines` within ~1 second.
- The inline warning block in `ArticleEditor.tsx` near `triggerAutoSave`'s definition documents this in-code; do not delete that block.
- The telemetry endpoint and table exist as the runtime safety net. Query `select * from meerkat.autosave_telemetry where event_type = 'edits_without_saves' order by created_at desc` if you suspect the chain is broken again.
- Related: [[feedback_data_loss_diligence]] — when editor work is reported lost, exhaust recovery and explain mechanically; never normalize "just save to a Word doc as backup" as ongoing practice.
