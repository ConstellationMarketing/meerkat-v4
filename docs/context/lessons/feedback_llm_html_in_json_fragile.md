---
name: don-t-make-an-llm-embed-html-large-content-as-a-json-escaped-string-use-sentinel-delimiters
description: "When an LLM must return a big HTML/markup blob alongside metadata, embedding it as a JSON-escaped string value is intermittently fragile — the model drops quote-escapes, worse on token-heavy output. Return metadata as small JSON + the raw blob between sentinels instead."
metadata: 
  node_type: memory
  type: feedback
---

**Rule:** When an LLM response must carry a large HTML (or other quote-heavy markup) payload plus a few metadata fields, do NOT ask it to return one JSON object with the markup as an escaped string value. Instead return a small JSON header for the short fields and the raw markup between unique sentinels (e.g. `<<<CONTENT>>> … <<<END_CONTENT>>>`). Parse the header as JSON; extract the body by sentinel match. Keep a legacy single-JSON fallback for safety.

**Why:** 2026-05-29 — Meerkat Vietnamese translations were silently failing (stuck at `status=pending`, no content) while Spanish was 60/60 fine. Root cause: `prompts/translator.md` asked Haiku to return the full translated HTML body as a JSON-escaped `content` string. Every `"` in an HTML attribute (`href`, `class`, `target`, `rel`) had to be escaped, and on longer output the model intermittently dropped an escape on the first link's `target="_blank"`, breaking JSON.parse at exactly that spot. `jsonrepair` couldn't reliably recover. The failure always landed on the content line, right at the first link. Spanish only survived because it's shorter; **Vietnamese tokenizes much heavier, so more output = more chances to drop an escape**. Fixed in PR #65 by switching to the sentinel contract — verified 5/5 clean on a previously-failing article.

**How to apply:**
- Applies to any LLM-output-parsing path in Meerkat / Enhancio content engine / SPR generation, anywhere a model returns markup + metadata.
- Heuristic for triage: if "language/locale X fails but Y works" on an LLM step, suspect output-length/token-weight fragility (escaping, truncation), not the locale itself. The token-heavy locale just surfaces a latent bug.
- Meerkat's article pipeline `parseJSON` had a sibling failure mode (trailing prose after valid JSON silently dropping every external link — see [[project_meerkat_batch_hardening_apr30]]). Same lesson: LLM JSON output is fragile; design the contract to minimize what can break.
- Related: [[feedback_check_prompt_and_validator_together]] — when an LLM pipeline silently fails, check the prompt's output contract and the parser together; they can disagree.
