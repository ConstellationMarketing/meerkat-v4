---
name: When an LLM pipeline silently fails, check the prompt AND the validator
description: Pipelines that combine a Claude prompt with regex/code validation can silently reject the prompt's own invited fallback. Always check both layers.
type: feedback
---
When an LLM pipeline produces a "model didn't comply" failure, do not assume the model is at fault. The prompt and the downstream validator can disagree, and the validator silently rejects valid prompted output.

**Why:** On 2026-04-27, the meerkat statute-repair pipeline had been logging "Claude response did not contain a valid statute citation — skipping" on a meaningful share of runs. Initial framing (and the audit agent's framing) was "Claude needs better examples in the prompt." Reading both files revealed the actual bug: `prompts/section-writer.md:148–149` AND `lib/structural-repair.js:244` both explicitly invited a fallback ("If you are not confident a statute number is correct, reference the legal concept generally — e.g., 'Under Michigan employment law'"). Then `lib/structural-repair.js:252` validated with regex that required `§`, `Section`, `U.S.C.` etc. — silently rejecting the prompt's own invited fallback. Articles shipped without any reference. The fix was a one-line addition to the validator, not a prompt change.

**How to apply:**
- When investigating a "model didn't comply" failure: first check the prompt is actually asking for what you think, then check the validator is actually accepting what the prompt invites.
- The two layers can drift apart over time as prompts get tightened independently of validation regexes.
- "Silently rejecting valid output" is a specific failure shape — the model returned the right thing, the validator said no, no error surfaced. Look for `console.warn(...skipping)` patterns in code that's supposed to repair / fix — they're the smoking gun.
- When tightening a prompt to invite a new fallback shape, immediately scan downstream validators that consume the model's response.
