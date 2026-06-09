---
name: Meerkat templates table incident + remediation (Apr 29 2026)
description: Templates table silently wiped Apr 27/28; recovered Apr 29; root cause was a saveTemplates footgun + cascade-delete; fixed across 3 PRs + a Postgres trigger-based history table
type: project
---
**What happened:** On 2026-04-29 the team reported batch generation failing with "no template for supporting pages." Investigation found the Supabase `templates` table had been silently reduced to a single row (`practice-page`). Multiple custom templates including `template-1767975904572` (the supporting page template) were gone. Destruction window was Apr 27 16:49 UTC → Apr 28 13:00 UTC (about 20 hours), narrowed by querying `article_outlines` for the last successful supporting-page article generation. API gateway logs were already out of retention (~30 min) so we couldn't pin the exact mutation, but the architecture has multiple destructive paths that fit.

**Why:** The team uses supporting-page templates regularly. A wiped table is silent until someone tries the affected path — could happen any time someone generates supporting articles via batch.

**How to apply:** When troubleshooting Meerkat issues that surface as "no template" / "missing data" / "empty section" errors, check the Supabase `templates` table state first; if rows are missing, use the recovery path below before reconstructing manually. Restoring from history is faster and higher-fidelity than reconstructing from git or memory.

---

## Root cause (most likely)

`storage.ts:saveTemplates` had a destructive "delete IDs not in incoming list" pattern that fired before its upsert. Three callers existed (storage's own auto-seed, Settings.tsx bootstrap, Settings.tsx add/edit/delete) — easy to trigger with stale UI state. Plus `delete-user-cascade` included `templates` in its tablesToDelete array, so admin-deleting a user nuked their authored templates. Either path could have caused the wipe; the saveTemplates one is more likely given it can fire automatically without admin action.

## What got shipped (all merged)

1. **meerkatv3 PR #32** — `storage.ts:saveTemplates` is now upsert-only. New `deleteTemplate(id)` for explicit single-row deletes. Settings.tsx no longer auto-seeds Supabase from OUTLINE_TEMPLATES on empty response. Delete-user-cascade.ts (Netlify) removes `templates` from cascade.
2. **meerkatv4 PR #43** — mirror change in `routes/frontend-api.js`: `templates` removed from the VPS backend's user-deletion cascade tables array.
3. **meerkatv4 PR #44** — adds Postgres-level safety net: `templates_history` table + `templates_audit` trigger that captures the OLD row on every UPDATE/DELETE on `templates`. RLS enabled, no policies (frontend keys can't see it; service-role and the SECURITY DEFINER trigger function bypass). Includes `scripts/restore-template.js` recovery helper.
4. **Manual SQL** applied via Supabase Dashboard SQL Editor: trigger setup + RLS enable.

## Recovery procedure (if templates ever go missing again)

```bash
node scripts/restore-template.js --list                          # what's in history
node scripts/restore-template.js --template-id <id>              # dry-run, see snapshot
node scripts/restore-template.js --template-id <id> --commit     # actually upsert it back
node scripts/restore-template.js --template-id <id> --at "<ISO>" --commit  # point-in-time
```

The history table captures the row's state immediately before any UPDATE or DELETE. INSERTs are NOT logged (no prior state worth saving for new rows).

## Reconstructed `supporting-page` row

After the incident, `supporting-page` was re-INSERTed (manually approved by Eli). Has 6 sections matching `meerkatv3-repo/client/lib/templates.ts`: Introduction, Core Answer, Additional Considerations, What to Expect, Soft CTA, FAQ. Note the name has spaces ("Supporting / Resource Page") whereas the original lost row used no spaces ("Supporting/Resource Page") — old article_outlines entries with the no-space label were generated against the destroyed row.

## Architectural note worth preserving

The frontend `client/lib/templates.ts` (hardcoded `OUTLINE_TEMPLATES`) and the Supabase `templates` table are TWO sources of truth:
- Single article generation: frontend calls `getTemplates()` which reads Supabase first, falls back to localStorage, falls back to OUTLINE_TEMPLATES. Sections are sent in the webhook payload directly.
- Batch generation: `meerkatv4/server.js:164` resolves template IDs from CSV against the Supabase `templates` table. Falls back to empty sections (silent failure) if missing.
- This means single article generation can mask a missing Supabase row (uses cached/fallback data); batch generation cannot. Discovery of templates damage typically happens via batch, not single.
