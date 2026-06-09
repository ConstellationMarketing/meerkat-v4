---
name: Meerkat time tracking — policy and behavior
description: How activity-based time tracking works in Meerkat, the team rule that it's an internal barometer (not editor-facing), and the anomaly thresholds baked into the admin UI
type: project
---
**Status as of 2026-04-22:** Live across the Meerkat admin dashboard ("Edited Articles Feedback" tab). Historical `tracked_time_seconds` values were zeroed out on 2026-04-22 to start from a clean, trustworthy baseline.

**Team policy (decided with Patrick, Jacqueline, Lindsay in the Meerkat group chat on 2026-04-22):**
- Tracked time is an **internal barometer only**, not something we flag to editors or use to confront them on single rows.
- Use it to watch patterns over weeks. Consistent large divergence from a specific editor is actionable; single anomalies are not.
- Do not tip our hand about exactly what is/isn't tracked — editors should continue behaving as they do.

**How it works (functional summary):**
- Passive hook (`useActivityTimer` in meerkatv3) watches trusted DOM events: `keydown`, `mousedown`, `pointerdown`, `click`, `input`, `paste`, `cut`, `scroll`, `wheel`.
- Does NOT listen to `mousemove` — that's the single most important choice. Mouse jigglers / stay-awake utilities mostly move the cursor, and counting them would defeat the purpose.
- Idle timeout: 60 seconds without any of the above = timer pauses. Resumes on next trusted event.
- Pauses immediately on `visibilitychange` (hidden tab), window `blur` (alt-tab), or when the feedback modal opens.
- Counter persists per-article in localStorage so reloads don't zero the session.
- `event.isTrusted === false` events are ignored (blocks Grammarly, password managers, scripted input).

**Anomaly flags in admin UI** (live; visible as an amber warning triangle on the Tracked cell with a hover tooltip):
- Tracked > 4 hours → "exceeds 4 hours — likely tracking anomaly"
- Tracked > 3× reported → "much higher than reported"
- Tracked > 60s AND Tracked < 0.3× reported → "much lower than reported"

**Why it works this way:**
- 1-min idle is intentionally short. Shorter = lean toward under-counting; over-counting is the bigger trust problem for Jacqueline/Lindsay.
- Clicking and scrolling count as activity (editors reviewing via scroll are legitimately working).
- The modal-open pause is the implicit "done editing" signal since there's no separate "submit for review" button in the editor.

**How to apply:**
- When someone raises a specific tracked-time row that looks off, remember: it's a heuristic, not ground truth. Check visibility/blur/extensions before assuming bug.
- Don't propose surfacing tracked time to editors directly without revisiting this policy with Patrick.
- If the 60-second idle threshold ever feels wrong (e.g. editors consistently tracking lower than plausible), revisit upward — was deliberately set low.
