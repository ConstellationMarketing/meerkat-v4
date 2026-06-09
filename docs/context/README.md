# Meerkat — institutional context

This folder is the institutional knowledge for owning and operating Meerkat: how the system got to its current shape, what we tried that didn't work, why certain decisions were made, and the operational gotchas you'd otherwise have to re-learn the hard way.

It's intended for whoever is technically owning Meerkat at any given time. Treat it as **working notes**, not polished documentation — many of these files were written close to the events they describe, in the first person, and they often capture *why* a decision was made (which usually matters more than *what*).

If you're new to Meerkat ownership, the recommended entry point is **`docs/Meerkat - Technical Ownership SOP`** (the canonical operations guide). Use this folder as the deeper-context companion to it.

## Structure

```
docs/context/
├── README.md     ← you are here
├── project/      ← chronological institutional history (incidents, releases, decisions)
├── reference/    ← stable infrastructure facts (VPS, repos, webhooks)
└── lessons/      ← cross-cutting technical lessons learned the hard way
```

### `project/` — institutional history

23 files, each capturing a specific moment, incident, or initiative in Meerkat's history. Filenames are dated where possible. Most useful when you encounter something that surprises you in the codebase or DB — there's often a project memory explaining how it got that way. A few high-leverage starting points if you're orienting from scratch:

- **`project_meerkat_repo_consolidation_may16.md`** — how the meerkatv3 + meerkatv4 repos got merged into one (this repo) and the Netlify cutover that landed it
- **`project_meerkat_omar_handoff_may16.md`** — the handoff doc itself and surrounding context
- **`project_meerkat_quality_audit_apr2026.md`** — the 9 quality failure modes that shaped the current pipeline guardrails
- **`project_meerkat_silent_save_loss_jun7.md`** — the editor save-loss incident that motivated the current save-state indicators and `beforeunload` warning
- **`project_meerkat_templates_incident_apr29.md`** — the templates table wipe and the `templates_history` safety net that came out of it
- **`project_meerkat_translation_workflow.md`** + **`project_meerkat_translation_fix_may1.md`** — translation pipeline history (Lindsay's web-team workflow + the source-field bug fix)

### `reference/` — infrastructure facts

3 files. Stable infrastructure information you'll need on hand:

- **`reference_meerkat_vps.md`** — VPS access (45.55.248.2), PM2, env vars, deploy mechanics
- **`reference_meerkat_repos.md`** — local repo paths (current state: this repo only; the old meerkatv3 was archived)
- **`reference_meerkat_n8n_webhooks.md`** — n8n webhook URLs; first thing to check when "Generating Article" hangs

### `lessons/` — cross-cutting technical lessons

7 files. Durable lessons learned from real Meerkat incidents that generalize beyond the specific event. Read these once at handoff and you'll save days of re-learning later. Each one is structured as: the rule, why it exists (the incident that birthed it), and how to apply it.

- **`feedback_meerkat_article_fields_two_paths.md`** — new article fields must be wired through `storage.ts` + `get-article.ts` + `PublicOpenArticleView` mapping
- **`feedback_llm_html_in_json_fragile.md`** — never embed HTML as a JSON-escaped string in LLM output; use sentinel delimiters
- **`feedback_check_prompt_and_validator_together.md`** — when an LLM pipeline silently fails, check the prompt's output contract and the parser together; they can disagree
- **`feedback_post_cutover_login_failure_heuristic.md`** — diagnostic order when a user can't log in after a Supabase auth migration
- **`feedback_never_delete_shared_auth_users.md`** — apps sharing master DB must NEVER hard-delete `auth.users`; remove from app-level membership only
- **`feedback_netlify_toml_overrides_ui_env.md`** — `netlify.toml [build.environment]` overrides Netlify UI env vars; always check it when migrating
- **`feedback_data_loss_diligence.md`** — when user data may be lost, exhaust recovery before declaring it gone; never normalize manual workarounds

## How to use this folder with Claude Code

The `CLAUDE.md` at the repo root tells Claude Code sessions to read this folder as context when working on Meerkat. You don't have to do anything — just open Claude Code in the repo and the context loads.

If a file feels outdated, it probably is. Memory files are point-in-time observations. Always verify against the current code or DB before acting on a claim. When you discover something that contradicts what's written here, add a follow-up file — the working-notes pattern is intentionally additive, not destructive.
