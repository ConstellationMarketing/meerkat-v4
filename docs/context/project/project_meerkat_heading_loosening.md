---
name: Meerkat heading enforcement loosened (V4.0.4 regression fix)
description: Fixed the V4.0.4 heading regressions where the section-writer prompt forced verbatim template headings and skipped the intro H2
type: project
---
**Fixed 2026-04-22 via meerkatv4 PRs #38 and #39.**

**The regression:** V4.0.4 added two changes to `prompts/section-writer.md` that editors had to undo on almost every article:
1. `sectionName` was required to be used verbatim as the H2. Editors saw literal headings like `CTA / Conclusion` and `Key Information` in generated output.
2. An exception skipped the H2 entirely for any section named "Introduction", so practice and supporting articles shipped with no intro heading between the H1+Tagline and the first body section.

**Data that confirmed the regression (60 most recent edited articles, pre-fix):**
- Editor changed the first H2 text: 60%
- Editor changed any H2 text: 67%
- Editor added a new H2 near the top (the missing intro): 55%
- Literal "CTA / Conclusion" rewritten by editor: 85% (11/13 articles that had it)

**The fix (PR #38):**
- Prompt now treats `sectionName` as a **topic brief**, not a literal heading. AI writes a contextual, reader-facing H2 tied to the keyword + jurisdiction, under 14 words, no slash headings.
- The only section that skips its H2 is `sectionNumber 1` (H1 + Tagline). The "Introduction" exception is gone — section 2 now emits a contextual intro H2.
- Supabase migration (`scripts/update-template-section-briefs.js`): renamed `CTA / Conclusion` → `CTA` on practice-page, added H2 guidance to Introduction and the supporting-page body sections.

**The follow-up (PR #39):**
- Supporting-template briefs tightened so Key Information / Additional Context / Get Legal Guidance produce distinct contextual H2s (smoke test showed they were drifting together).
- Removed `format-checker.js` regex warnings for "Missing How We Can Help" and "Missing Why Choose Us" — they false-positived on contextual H2s like "How a Dog Bite Attorney in Atlanta Can Help You" or "Why Bardol Law Firm Stands Behind Atlanta Dog Bite Victims". Replaced with a structural H2-count check on practice pages.

**Team decision:** not running a post-fix data audit. Editor feedback will surface any remaining issues.

**How to apply:**
- If editor feedback starts flagging heading issues again, check whether a prompt change re-tightened the H2 enforcement before looking elsewhere.
- The required-section list in the prompt still exists as guidance (what topics must be covered) — just not as literal heading text.
- New templates added to Supabase: section names are briefs, not literal headings. Name them accordingly (avoid slashes, meta-labels).
