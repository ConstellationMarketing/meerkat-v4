---
name: when-user-data-may-be-lost-exhaust-recovery-before-declaring-it-gone
description: "When a user reports lost work, default to recovery + root-cause diligence, not casual triage. Never normalize manual workarounds as a substitute for a platform fix."
metadata: 
  node_type: memory
  type: feedback
---

**Rule:** When a user's work may have been lost, exhaust every place it could plausibly exist (server DB row state, server logs, browser React/sessionStorage/localStorage, audit or WAL logs) before telling the user it's gone. Then explain *why* the loss happened mechanically — not just *that* it happened. And pair every loss communication with a concrete platform-side commitment to prevent recurrence; do not recommend manual workarounds (copy-paste to Word, etc.) as ongoing practice.

**Why:** 2026-06-07 — an editor lost ~40 min of edits on one Meerkat article. My first response was casual: confirmed the work wasn't on the server, told Eli the editor would have to redo it, even suggested editors should copy-paste to a side doc going forward as a safeguard. Eli pushed back hard. Re-investigating, the work was likely still recoverable from browser sessionStorage / React state if his tab was still open — a path I hadn't checked. Recommending the side-doc workaround would also have tacitly admitted the platform is unreliable, when the right move was to commit to and ship platform fixes (which became [[project_meerkat_silent_save_loss_jun7]] / PR #68).

**How to apply:**
- Pause on "is this really gone?" before responding. Browser-side state, server logs, and audit trails are all distinct places to check.
- When the failure is on the user's machine, time is finite — the gating question to the user is "do you still have this open?" Send that *before* a multi-step extraction walkthrough so you don't burn the recovery window on the wrong path.
- When messaging, explain the mechanical failure (what triggered, what didn't, where the data should have been) — not just the outcome.
- Pair every loss communication with concrete, named platform-side changes that will land. Specific changes, not vague "we'll investigate."
