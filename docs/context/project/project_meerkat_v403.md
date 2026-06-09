---
name: Meerkat V4.0.3 Release
description: V4.0.3 released 2026-03-30 — feedback-driven quality improvements, data fixes, version bump
type: project
---

V4.0.3 released 2026-03-30. Based on analysis of 10 V4 editor feedback submissions (avg 68 min edit time vs 60 min target).

**Key changes:** word count enforcement in section retry loop, intro filler ban, lead-with-the-point rule, Why Choose Us/What to Expect personalization requirements, supporting page section gating, feedback data fixes (Unknown Article bug, section overwrite bug, auto-increment removed).

**Why:** Structural V3 issues are resolved. Remaining editor time is spent on content quality — generic sections, thin word count, filler language. These prompt/pipeline changes target the top 5 patterns from feedback.

**How to apply:** Next session on Meerkat should focus on monitoring V4.0.3 articles for improvement. Need 20-25+ feedback entries for meaningful validation. Geo-variant duplication identified but not yet addressed — scope for future release. Jacqueline batching next month's article inputs (~10) for a more consistent measurement sample.

**Repos:** V4 pipeline at /Users/elicurtin/meerkatv4, V3 frontend at /Users/elicurtin/meerkatv3-repo (this is the git repo, NOT /Users/elicurtin/meerkatv3/meerkatv3-main which is a stale non-git copy).

**Data:** Supabase project fcdotdpzmjbmsxuncfdg. editing_feedback table has version column now populated correctly for V4 articles. n8n workflow JSON exported at /Users/elicurtin/Downloads/Meerkatv3.3 - LATEST VERSION.json.
