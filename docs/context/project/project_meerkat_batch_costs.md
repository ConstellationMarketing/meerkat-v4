---
name: Meerkat April Batch Cost Context
description: April 2026 batch cost ~$200 for 211 articles (~$1/article), inflated ~2.5x by retries (550 attempts). Patrick tracking unit economics.
type: project
---

April 2026 batch: 211 articles, ~550 total generation attempts, ~$200 API cost. Effective cost ~$1/article but inflated by retries.

**Why:** Patrick Carver is tracking raw cost per article for Constellation. His initial estimate was $2/article assuming 100 articles — actual is under $1/article for 211, but retry waste made effective spend ~2.5x higher than necessary.

**How to apply:** Future batch runs should be much more efficient (quality gate + API retry already shipped in PRs #19/#20). When discussing costs with Patrick, frame around the post-fix unit economics, not the messy first run.
