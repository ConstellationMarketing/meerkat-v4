# Meerkat — repo orientation for Claude Code

This is **meerkatv4**, the consolidated Meerkat repo. It holds both the backend (Express service running on the DigitalOcean VPS) and the frontend (React/Vite SPA served by Netlify) in one place after the May 2026 consolidation that merged the old meerkatv3 frontend into `web/`.

## Repo layout

- `/` (root) — backend: `server.js`, `lib/`, `routes/`, `pipeline.js`, `prompts/`, `scripts/`
- `/web` — frontend: `client/`, `server/`, `netlify/functions/`, `vite.config.ts`, `netlify.toml`
- `/docs` — operational docs, including the Technical Ownership SOP
- `/docs/context` — institutional knowledge for technical ownership (read this folder for project history, infrastructure reference, and cross-cutting lessons). Start with `docs/context/README.md`.
- `/scripts/migration` — one-off migration + recovery scripts, preserved as historical artifacts

## Deploys

Both halves auto-deploy on merge to `main`. No manual step required:

- **Backend** — GitHub Action SSHs into the VPS (45.55.248.2), pulls `main`, npm-installs, and restarts pm2 (process `meerkat`). ~30 seconds.
- **Frontend** — Netlify watches this repo with base directory `web/`, runs `pnpm run build:client` on each commit to main, swaps the deployed bundle. ~2 minutes.

## When starting a new task

1. Open `docs/context/README.md` and skim the section relevant to what you're working on — there's often a project memory that explains why the current shape is the way it is.
2. The deeper "how to operate" guide is `docs/Meerkat - Technical Ownership SOP.pdf` (or the `.docx` source in the docs folder).
3. When editing code, follow the standard PR workflow (small PRs, branch protection requires review before merge).

## When in doubt

- VPS access details: `docs/context/reference/reference_meerkat_vps.md`
- The article-generation pipeline lives in `pipeline.js` at the repo root and the prompts in `prompts/`. The frontend editor that consumes its output lives in `web/client/components/ArticleEditor.tsx`.
- The Master Supabase project (`cwligyakhxevopxiksdm`) holds every Meerkat-specific table under the `meerkat` schema. See `docs/context/project/project_meerkat_repo_consolidation_may16.md` for the broader architecture.
