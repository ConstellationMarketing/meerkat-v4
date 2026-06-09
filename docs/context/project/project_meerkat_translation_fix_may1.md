---
name: Meerkat translation source-field bug fix and bulk re-translation
description: 2026-04-30/05-01 — translator was reading pre-edit draft instead of editor's final; all 34 historical translations re-run; live published versions still need republish by web team
type: project
---
**Bug (caught 2026-04-30):** `lib/translate.js` was reading `article['cleaned content']` (immutable pre-edit pipeline draft) instead of `article.received_article?.content` (editor's final version). Every Spanish/Vietnamese translation ever shipped was a faithful translation of the wrong source — incomplete sections relative to what readers actually see in English.

**Caught when:** Jacqueline flagged article `e3aa3ff0` (Dressie Law). English `received_article.content` had 6 H2s + 18 H3s; Spanish translation had 4 H2s + 3 H3s. Comparison confirmed `cleaned content` matched the Spanish version exactly — translator was doing 1:1 of wrong source.

**Why this happened:** When the translation feature shipped 2026-04-16, the editor flow that populates `received_article` wasn't yet the dominant write path. Translator authors picked `cleaned content` as the input. Editor restructuring became routine after that, but the translator field selection was never revisited.

**How to apply:** When suggesting changes to translation logic, source content always prefers `article.received_article?.content || article['cleaned content']`. Same fallback for title (`received_article.title || title_tag`) and meta (`received_article.meta || meta_description`). See `lib/translate.js:80-87`.

---

## What got shipped 2026-04-30/05-01

| PR | Repo | Change |
|---|---|---|
| #49 | meerkatv4 | Translator reads editor's final version (received_article) with cleaned content fallback |
| #50 | meerkatv4 | Add jsonrepair fallback to parseTranslationResponse — Haiku occasionally emits unescaped quotes inside HTML content string, breaking JSON.parse |
| (script) | meerkatv4 | `scripts/retranslate-existing.js` — bulk re-trigger every existing translation, sequential with 5s delay |

**Bulk run:** 34 articles re-translated (32 ES + 2 VI). 5 initially failed with the JSON-parse bug (same root cause); 4 cleared on retry; 1 (Cherney "Dallas GA Bankruptcy Attorney" 032ce845) reliably failed at char ~8800 of response — fixed by jsonrepair on subsequent retry.

## Open: client-facing republish still needed

**Critical:** The system now has correct translations in Supabase + the internal staging repo. **The live published versions on client websites are still the OLD (wrong) translations.** Every Spanish/Vietnamese article that's been published needs a re-publish by Lindsay's web team.

CSV at `~/Downloads/translations-to-republish.csv` (34 rows, all `status=complete`) lists client / language / english_url / translated_slug for the web team. Generated 2026-05-01 with proper CSV escaping.

**How to apply:** If Jacqueline or Lindsay's team asks about translation status, the translations themselves are fixed; the live publish is the open follow-up. Don't tell them "translations are fixed" without flagging that republish is required.

## Non-obvious findings

1. **`jsonrepair` (npm) cleanly handles Haiku's unescaped-quote failure mode.** Verified: `{"content":"the case "Smith v. Jones" said x"}` repairs faithfully. Currently used only in `parseTranslationResponse`; could be applied to other LLM JSON parsers if similar failures surface.
2. **Cherney 032ce845's content reliably triggered the bug** — failed JSON.parse at near-identical positions (8929/8857/8809/8874) across 4 attempts. Position differs slightly per call but the failure is content-driven, not transient. jsonrepair is the safety net; long-term a tool-use schema would be more durable (deferred).
3. **Translation calls return 202 immediately and run async on VPS.** Errors only surface in PM2 logs. `translations.{lang}.status` stays at `pending` indefinitely on failure — there's no auto-retry or status update. Worth knowing when triaging stuck translations.
