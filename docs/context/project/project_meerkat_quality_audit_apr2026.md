---
name: Meerkat editor-feedback quality audit (April 2026)
description: 9 failure modes editors flagged, mapped to 4 PRs across meerkatv4 + meerkatv3 — what shipped, key non-obvious findings, what's deferred
type: project
---
**Trigger (2026-04-27):** Editor feedback over April showed pipeline shipping articles with visible quality regressions — placeholder scaffolding leaking through, vague template H2s, off-topic external links, missing statute citations, sparse Why Choose Us, promotional intro language, shallow structure, reviewer notes in body, cross-section repetition. An Explore-agent audit identified 9 failure modes; spot-checking corrected several of the agent's claims before scoping fixes.

**Why:** Patrick is tracking unit economics on Meerkat, and editors are spending hours on structural rewrites the pipeline should produce on first draft. Raising the floor on first-draft quality is leverage on both editor time and end-quality. The remediation was scoped as 3 phases of meerkatv4 PRs plus 1 frontend PR.

**How to apply:** When suggesting Meerkat changes, default to the Phase model — defensive guardrails first (format-checker, qualityGate), prompt clarification second, architectural changes last. Validation must back up prompts, not replace them.

---

## Failure modes → where each shipped

| # | Failure mode | PR(s) |
|---|---|---|
| 1 | Scaffold/brief text leaking ("CTA/Conclusion" as H2, "Soft CTA" body) | meerkatv4 #40 |
| 2 | Generic template H2s ("Key Information", "Additional Context") | meerkatv4 #40 |
| 3 | Off-topic external links (FMCSR→osha.gov, ACV→uscourts.gov) | meerkatv4 #42 |
| 4 | Statute fallback prompt-vs-validator contradiction | meerkatv4 #40 |
| 5 | Sparse Why Choose Us (practice pages only) | meerkatv4 #41 |
| 6 | Promotional language in intro | meerkatv4 #40 |
| 7 | Shallow structure (8–11 H2s vs final 15–22) | meerkatv4 #42 (validation) + meerkatv3 #31 (templates) |
| 8 | Reviewer notes leaking into body | meerkatv4 #40 |
| 9 | Cross-section repetition | meerkatv4 #41 |

All 4 PRs merged on 2026-04-27 / 2026-04-28.

---

## Key non-obvious findings (worth preserving — these are NOT in code/git)

1. **Only ONE template exists in Supabase** (`templates` table): `practice-page` with thin one-line briefs. The supporting-page template referenced by `meerkatv4/scripts/tighten-supporting-briefs.js` (template-1767975904572) does NOT exist in the production Supabase. That migration script targets nothing.

2. **Section briefs come from the frontend, not Supabase.** `client/lib/templates.ts` in meerkatv3-repo is the actual source of section descriptions submitted to the pipeline. The Supabase templates table appears unused in the article-creation path. This is why #7 needed a frontend PR — backend prompt work alone can't fix shallow structure if the frontend submits one-line briefs.

3. **The statute repair "Claude can't write good citations" failure was actually a prompt-vs-validator contradiction.** `structural-repair.js:244` explicitly told Claude to fall back to "Under [State] [area] law" when uncertain. Line 252 then validated with regex that ONLY accepted hard citations (§, Section, U.S.C.) — silently rejecting the prompt's own invited fallback. Fix was to extend the validator to accept the qualified-jurisdiction-reference patterns the prompt invites. Lesson: when a pipeline silently fails, check the prompt and validator separately — they can disagree.

4. **`callClaude` does NOT log token usage.** Anthropic SDK returns `msg.usage.input_tokens`/`output_tokens` on every response; `pipeline.js:41` throws it away. Per-article cost is not measurable from VPS logs. The "~$1/article" figure in `project_meerkat_batch_costs.md` is from Anthropic console aggregation, not pipeline logging. Adding `msg.usage` logging is a 10-line follow-up — not done yet.

5. **FMCSA URLs are Cloudflare bot-blocked from CLI.** Could not verify `fmcsa.dot.gov` URLs via curl during the URL-pool expansion in #42, so omitted from the pool. Editors will add manually for trucking-specific articles. The URL works in real browsers; just couldn't verify automatically.

6. **Test-batch.js had `name: 'CTA / Conclusion'` as a section title** — exactly the SCAFFOLD-detected pattern Phase 1 added. The smoke test on Phase 1 directly exercised the new gate; the section-writer paraphrased correctly into "Talk to a St. Louis Divorce Lawyer Today" so the gate didn't trip.

7. **Pipeline cost breakdown** (call counts, not measured tokens): per article, ~13–18 Sonnet calls (sections + retries + 3 Sonnet validation passes — article-review, legal-compliance, statute-verification) and ~7 Haiku calls (links/title-meta/schema/slug/structural-repair). Section retries and the 3 Sonnet validation stack are roughly half the per-article spend. Consolidating those validation passes is a Phase 4 cost lever (not started).

---

## What's deferred / not done

- **Token usage logging in `callClaude`** (~10 lines). Would give per-article cost visibility.
- **Statute repair timing investigation:** Phase 1 smoke test logged "no statute citation after repair attempt" but final article had "Missouri family law" 19 times — stage-ordering oddity. Article shipped correctly; only the log was misleading.
- **Soft promotional tone leak in intros** (e.g., "team of dedicated divorce lawyers", "tailored strategies"). Phase 1 banned-phrase list caught the egregious phrases but boilerplate adjectives still slip through. Worth a follow-up sweep.
- **Phase 4 cost optimization:** consolidating the 3 Sonnet validation passes (article-review, legal-compliance, statute-verification) into one merged pass.

---

**Reference PRs:**
- meerkatv4 #40: https://github.com/ConstellationMarketing/meerkatv4/pull/40
- meerkatv4 #41: https://github.com/ConstellationMarketing/meerkatv4/pull/41
- meerkatv4 #42: https://github.com/ConstellationMarketing/meerkatv4/pull/42
- meerkatv3 #31: https://github.com/ConstellationMarketing/meerkatv3/pull/31
