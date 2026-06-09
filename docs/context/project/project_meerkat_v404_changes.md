---
name: Meerkat V4.0.4 — full release notes
description: Quality enforcement, batch generation, before/after comparison, activity tracking, Jacqueline feedback fixes — shipped Apr 16-21
type: project
---
**V4.0.4 shipped across Apr 16-21.** Major quality and tooling release.

**Quality enforcement (PRs #23-29):**
- Hardened regex for tagline, FAQ, paragraph splitting, H2→H3 bridging
- New: deduplicatePhrases, stripPhoneNumbers, fixCTALinks, capH3Density
- External links retry with Sonnet, statute citation repair
- Supporting page: skip firm name insertion, required section validation
- Format checker: bold paragraph auto-fix, redundant warnings removed

**Prompt improvements (PRs #28-29, #33, #37):**
- Section names enforced as exact H2 headings
- Required sections list: "How We Can Help" replaces "Legal Overview"
- H3 limit reduced to 2 per section
- CTA must link to contact page
- Intro section no longer generates H2 heading
- Absolute language rules: "ensures", "guarantees" → qualified alternatives
- Statute verification: Sonnet checks citations post-generation, strips suspicious ones
- Supporting Page template fully rewritten in Supabase (sections, word counts, tone)

**Supabase template updates:**
- Practice Page: all 7 sections rewritten with word counts and clearer instructions
- Supporting Page: 6 sections rebuilt (was broken — "Soft CTA" as heading, duplicate sections, no word counts)

**Batch generation (PR #32 backend, PR #18 frontend):**
- Admin dashboard "Batch Generate" tab with CSV upload, validation, progress tracking
- Sequential backend processing using same runPipeline()
- batch_jobs table for tracking

**Before/after article comparison (PRs #35-36 backend, #19-21 frontend):**
- "Original" and "Final" columns in Edited Articles admin tab
- Original loads from "cleaned content" (immutable pipeline output)
- Final loads current received_article.content (editor's version)
- Works retroactively for all existing articles

**Activity-based time tracking (PR #22 frontend):**
- useActivityTimer hook: passive tracking of keystrokes, clicks, scrolling
- 2-minute idle timeout pauses timer
- "Reported" vs "Tracked" columns in admin dashboard
- tracked_time_seconds column added to editing_feedback table

**UI polish (PR #23):**
- Feedback text truncated with expand/collapse in admin table

**Migration progress:**
- app_access table created and seeded in master Supabase
- Netlify functions ported to Express (PR #34)
- Static file serving + SPA fallback added to VPS server
- CORS updated to os.goconstellation.com
- Remaining: build frontend on VPS, Nginx config, repoint auth, DNS flip

**Smoke test results:** 16/16 checks passing, Flesch 70, 1,550 words.
