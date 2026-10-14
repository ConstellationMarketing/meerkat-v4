---
name: Meerkat GitHub publish is retired
description: github-publish.js removed 2026-10-14 after it flooded OS deploys; GITHUB_TOKEN disabled on the VPS and the PAT revoked
type: project
---

`lib/github-publish.js` pushed HTML copies of every article and translation into `ConstellationMarketing/internal`, served at `internal.goconstellation.com/meerkat/`.

**What actually happened.** The April 2026 note here said the PAT had expired and the repo no longer existed. Both were wrong. `ConstellationMarketing/internal` had been **renamed to `ConstellationMarketing/os`** (GitHub redirects the old name), and the token was re-issued during the 2026-10-01 key rotation. So the module kept committing into the OS monorepo under Eli's account, ~50 commits/day.

**The incident (Oct 11-14).** PR #135 let the translation reconciler see every article instead of only the first 1,000 rows. It started draining a large backlog at ~1,000 commits/day (3 commits per translation: page, articles.json, index.html). OS `deploy.yml` runs on every push to main with `cancel-in-progress: true`, so OS deploys stopped finishing for everyone.

**Why it was removed rather than patched.** Nothing consumed the output: the returned URL was never stored or read, no OS page or other repo linked to `/meerkat/`, and the pages were `noindex`. The real article flow is pipeline → Supabase (`article_outlines`) → the Meerkat frontend / WordPress publishing, which is unaffected. Translations still save to Supabase.

**Done 2026-10-14:** `GITHUB_TOKEN` commented out in `/root/meerkat-service/.env` (backup `.env.pre-disable-ghpublish-20261014`); module and call sites removed; the classic `repo`-scope PAT on Eli's account revoked. The orphaned `meerkat/` folder in the OS repo is removed separately.

**How to apply:** Do not reintroduce a publish into the OS repo. Anything that commits to OS main triggers a full deploy and cancels the one in flight.
