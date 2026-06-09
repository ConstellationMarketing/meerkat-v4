---
name: meerkat-may-2026-editor-feedback-fix-arc-prs
description: "2026-05-26 — Jacqueline raised editor concerns about incomplete taglines + repeated fragments across same-client articles. Audited 154 May editing_feedback rows, shipped 4 PRs (tagline fix + H2 warning + cross-article detection + prevention). Both detection and prevention live on VPS."
metadata: 
  node_type: memory
  type: project
---

**Trigger (2026-05-26):** Jacqueline flagged two editor concerns about May 2026 batch output:
- "Some taglines are incomplete"
- "Broken or repeated fragments of content appearing across multiple articles for the same client"
- Her hypothesis: 25-per-batch May runs may be contributing

No generation-pipeline PRs had shipped since 2026-04-30 batch hardening — recent work was repo consolidation, not pipeline. So this was either a regression triggered by batch-scale exposure or a long-tail bug that volume surfaced.

## Audit (154 editing_feedback rows since 2026-05-01)
- All V4.0.4 (no version churn)
- Tagline issues: 80/154 (52%)
- Repetition / duplicate: 55/154 (36%)
- Broken / fragment: 27/154 (18%)
- Editors: bonniey (55), molya (48), hilda (32), jose (19)

## Smoking guns

**Tagline truncation root cause:** `pipeline.js:enforceTaglineLength` was slicing at word 7 and appending a period regardless of grammar. Four real-world May failures, each exactly 7 words because that's the slice index:
- *"Your business built your life. Make a."*
- *"Your time with your child matters. Protect."*
- *"When a truck fails, lives are at."*
- *"The stakes are higher. The rules are."*

**Cross-article boilerplate root cause:** Client-level facts/phrases (e.g. Dostart Law's "$34.9 million jury award" in 3 separate Folsom articles; Sabbeth Law truck batch sharing intro framing across 6 articles) landing verbatim across multiple articles in a batch. The April PR #41 fixed *within-article* cross-section repetition; it never addressed *across-article* repetition within a batch.

## What shipped

| PR | Scope | State |
|---|---|---|
| #61 | `enforceTaglineLength` is now sentence-aware — keeps longest complete-sentence prefix in 7 words, drops tagline entirely if nothing fits. Test: `test-tagline-trim.js` (7 cases). | Live, no env config |
| #62 | New format-checker rule §16 — warns "STRUCTURE: No <h2> follows the tagline" when section 1 emits H1+tagline+body without the section 2 H2. Test: `test-tagline-h2-structure.js` (4 cases). | Live, no env config |
| #63 | `lib/cross-article-dupe-check.js` — Jaccard token-overlap detector ≥0.80 on 8+ content-word sentences vs 5 most-recent same-client priors. Warnings flow through existing `format_warnings` path. Test: `test-cross-article-dupe.js` (8 cases). Live canary against May data found a real 86% match in the Sabbeth Law batch. | Live, `CROSS_ARTICLE_DUPE_CHECK=1` set on VPS .env (line 19), pm2 restarted with `--update-env` |
| #64 | **Prevention companion to #63.** `getPriorClientPhrases` pulls 30 sentences from last 3 same-client articles; `runPipeline` fetches once at start; `generateSection` injects them into every section-writer USER message under a `## RECENTLY USED PHRASES FOR THIS CLIENT — DO NOT REUSE VERBATIM` block. Smoke verified on Sabbeth Law generation: 0 dupe warnings against priors at threshold 0.80. ~4.8k extra input tokens/article. | Live, `CROSS_ARTICLE_DEDUP_PREVENT=1` set on VPS .env (line 22), pm2 restarted with `--update-env` |

## Operational state of the dupe-check (PR #63)

- **Off by default** in code; turned **on** via `CROSS_ARTICLE_DUPE_CHECK=1` in `/root/meerkat-service/.env`
- Threshold tunable via `CROSS_ARTICLE_DUPE_THRESHOLD` env var; currently unset → defaults to **0.80** (verbatim-leaning)
- Warning-only — no rewriting, no blocking
- `client_name` column in `meerkat.article_outlines` is the key (snake_case, not "Client Name")
- Prior-article content read from `received_article.content` first, falls back to `cleaned content` if editor hasn't saved yet
- DB query failures swallowed with warn-log — never breaks the pipeline

## Tuning hooks for future sessions

- If warning rate is too low, drop threshold to 0.75 (catches more rephrases at cost of some false positives)
- If too noisy, raise to 0.85 (verbatim-only)
- Thematic repetition (~60–70% similarity, the "double intro" Sabbeth pattern) is out of scope for the current detector — would need embeddings, not Jaccard

## Detection + prevention now stacked

PR #63 surfaces dupes post-generation; PR #64 prevents them at generation time. Both live in tandem on VPS — prevention stops most boilerplate at the source, detection catches anything that slips past prevention (or that drifts from threshold tuning). Watching the next batch's `format_warnings` column will tell us if prevention rate is high enough that detection can be turned off, or if we should keep both layers.

Jacqueline acknowledgement sent 2026-05-26 with honest framing: "the article generator now pulls the recent batch's content for that client before writing a new one and treats those phrases as off-limits."

## Non-pipeline observations worth carrying

- `article_outlines.client_name` is lowercase snake_case; legacy fields like "word count", "Page URL", "Schema" use mixed case (Airtable-era). When querying, always confirm column shape.
- `received_article` is the editor's saved version; `cleaned content` is the immutable original generation output. For "what shipped" analysis use `received_article.content`; for "what the pipeline produced" use `cleaned content`.
- meerkat-service runs in pm2 cluster mode — `pm2 restart meerkat --update-env` picks up `.env` changes cleanly because `server.js` calls `dotenv.config()` at startup.
