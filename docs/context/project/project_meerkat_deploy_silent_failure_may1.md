---
name: Meerkat deploy GitHub Action was silently swallowing failures
description: 2026-05-01 — appleboy/ssh-action ran without set -e; git pull failures cascaded into pm2 restart of OLD code; action exited 0; PRs #46-50 reported success but never deployed. Fixed in PR #52.
type: project
---
**Discovered (2026-05-01):** While debugging a translation that kept failing the same way after a "deployed" jsonrepair fix (PR #50), manual SSH inspection revealed the VPS was still on `bf819cc` (PR #49 merge) — meaning **PRs #46, #47, #48, #49, #50 had all reported successful deploys but none of their code reached the running process**.

**Root cause:** `.github/workflows/deploy.yml` ran a multi-line `script:` block via `appleboy/ssh-action` without `set -e`. When `git pull origin main` failed (in this case, because of uncommitted package-lock.json drift on the VPS blocking the merge), execution continued into `npm install` and `pm2 restart meerkat`. The restart succeeded against the OLD code; the action exited 0; GitHub reported success.

**Why undetected for so long:** The deploy "worked" in the sense that any single PR's behavior change would only be noticed if the user actively tested its specific functionality. Most PRs in this stretch were validation/UI/edge-case fixes whose absence wasn't immediately visible. Caught only because the translation retry kept hitting the exact same JSON-parse error after the jsonrepair fix should have suppressed it — that's the kind of mismatch that forces a manual dig.

**Fix (PR #52, deployed 2026-05-01):**
1. `set -euo pipefail` at top of script — any failure halts and surfaces as failed action run.
2. Replaced `git pull origin main` with `git fetch origin main` + `git reset --hard origin/main` — the VPS is a deploy target, not a working tree, so local drift gets discarded automatically rather than blocking the merge.

**How to apply:**
- When suggesting deploy/CI changes for similar setups, default to `set -euo pipefail` in any `script:` block; never trust a multi-line shell to fail the action implicitly.
- For deploy targets, `git reset --hard origin/main` is the right primitive over `git pull` — there's no legitimate reason to keep local changes on a deploy host between deploys.
- After this fix, deploy verification should be automatic; if a future deploy "succeeds" but behavior doesn't change, investigate the action logs (it should now actually fail loud).

## What's left over

- A `git stash` from the manual remediation on 2026-05-01 still exists on the VPS (`stash@{0}` with a package-lock.json modification). Benign and recoverable; no action needed unless someone wants to clean it up.
- The drift's *original* source — what process was modifying package-lock.json on the VPS — wasn't fully diagnosed. Most likely culprit: `npm install --omit=dev` updating the lockfile due to Node/npm version mismatch between dev and the VPS. Now moot because `git reset --hard` discards any drift each deploy.
