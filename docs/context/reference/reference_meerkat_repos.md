---
name: Meerkat repo paths on Eli's machine
description: Which local checkouts are the active working copies vs outdated snapshots — save time on the wrong directory
type: reference
---
Local Meerkat checkouts:

- **`~/meerkatv4`** — backend (Node API server, VPS-deployed). This is the active copy. Remote: `ConstellationMarketing/meerkatv4`.
- **`~/meerkatv3-repo`** — frontend (React/Vite, Netlify-deployed). This is the active copy. Remote: `ConstellationMarketing/meerkatv3`.
- **`~/meerkatv3/meerkatv3-main`** — outdated snapshot. Missing recent features (e.g., `TranslationControls` component). Do NOT use for edits; grep/glob will find real files but they'll be stale.

When searching for frontend code, prefer `~/meerkatv3-repo` directly rather than globbing `~/meerkat*` (both directories match and the stale one can mislead).

Untracked files sometimes present in `~/meerkatv4` root (`batch-generate.js`, `batch-local.js`, `weekly-report.*`) are from a parallel session's work on batch generation — don't stage or commit them inadvertently.
