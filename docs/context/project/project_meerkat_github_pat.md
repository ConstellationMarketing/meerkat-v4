---
name: Meerkat GitHub publish is deprecated
description: github-publish.js to ConstellationMarketing/internal is redundant — PAT expired, repo gone, no action needed
type: project
---

The `github-publish.js` module pushed styled HTML previews to `ConstellationMarketing/internal` (served at `internal.goconstellation.com/meerkat/`). This was a duplicate of what the meerkatv3 frontend already shows from Supabase.

As of 2026-04-07: the PAT expired, the repo no longer exists, and Eli confirmed this is not needed. The pipeline gracefully skips publishing when `GITHUB_TOKEN` is missing.

**The real data flow:** pipeline → Supabase (`article_outlines`) → meerkatv3 frontend. This is unaffected.

**How to apply:** Don't regenerate the PAT or recreate the repo. If we want to clean up, we could remove `github-publish.js` and the `GITHUB_TOKEN` env var from VPS entirely, but it's low priority since it no-ops safely.
