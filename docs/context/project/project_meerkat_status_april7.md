---
name: Meerkat pipeline status 2026-04-14
description: Pipeline fully SOP-aligned, PRs #19-22 deployed, 20-point checklist, functional spec delivered to Lindsay
type: project
---
**Confirmed 2026-04-14:** Pipeline is SOP-aligned and deployed via "Deploy to VPS" GitHub Action on merge. PRs #19-22 all shipped.

**Current state of the pipeline:**
- 20-point structural review checklist (up from original 15)
- 8 deterministic post-processing functions (H1 lock, tagline cap, forbidden words, link dedup, FAQ truncation, paragraph splitting, directory link stripping, anchor text enforcement)
- Targeted structural repair pass (H2→H3 bridging, CTA expansion, intro expansion, firm name insertion)
- Legal ethics compliance scan
- Format checker with auto-fixes
- Quality gate blocks broken articles from reaching editors

**SOP alignment (8 dimensions):**
- Readability: Flesch 60-80, max 3 sentences per paragraph
- Structure: required sections enforced, page-type rules
- Local Signals: prompted in generation + review check #17
- Brand Signals: firm name repair in first 100 words + review check #18
- Accuracy: jurisdiction-specific prompts (editor verification still needed)
- Legal Ethics: ABA compliance scan, prohibited terms
- Answer Surfacing: 6-element intro, section mini-answers + review check #19
- Linking: 2-3 external, 2 internal, 3-7 word anchors, direction rules, directory blocking

**Pending work items:**
- Batch generation v2 (future — admin CSV upload, quality-first orchestration)
- Editor meeting to discuss feedback/bandwidth disconnect
- Lindsay reviewing the functional spec doc

**How to apply:** Future pipeline changes merge to main → auto-deploy via GitHub Action. No manual VPS sync needed.
