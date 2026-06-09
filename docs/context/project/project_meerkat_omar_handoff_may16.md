---
name: Meerkat ownership handoff doc for Omar — drafted, surfaced to Patrick for wiki placement
description: 2026-05-16 — built 4 iterations of a ~12-page Meerkat ownership/operations guide for Omar (~/Downloads/meerkat-handoff-v4.docx is final). Surfaced to Patrick to decide how/where it lands in the OS wiki.
type: project
---
**Status (2026-05-16):** drafted through v4, surfaced to Patrick for placement decision. No PR opened.

## What got built
- `~/Downloads/meerkat-handoff-v4.docx` — final version Eli edited (after v1→v3 iterations driven by his inline comments)
- 8 sections, ~12 pages: mental model · system at a glance (with meerkat schema table) · setup · standard change workflow · versioning · troubleshooting matrix · adjudicating user requests (4 questions + 3 worked examples) · reference appendix
- Build script: `/tmp/build_meerkat_handoff_v3.py` (python-docx, last revision used as v4 base)

**Why:** Omar is taking over Meerkat ownership. Doc is prescriptive about Claude Code as the primary interaction model, biased toward "ship small PRs, ask before bulk-anything" — calibrated for "not the strongest stakeholder, needs proactive help."

## Key edits Eli pushed in
- **Versioning model corrected**: 4.x.y is a flat running counter, not semver. After 4.0.9 comes 4.1.0. Bumping touches three surfaces that must stay in sync: bottom-left UI version, `article_outlines` version column, `editing_feedback` version column.
- Branch protection auto-routes PRs for review — no manual reviewer-add.
- VPS .env is the canonical source (scp down from `/root/meerkat-service/.env`), not "Eli has a copy."
- SSH key flow: Omar generates keypair, sends pubkey, Eli appends to authorized_keys.
- Section 2.1 carries a full **meerkat schema table** listing every table (article_outlines, team_members, batch_jobs, editing_feedback, etc.) + purpose.

## Open / pending
- **Patrick decides wiki placement.** Eli surfaced the doc to him 2026-05-16 to figure out how/whether to publish into the OS wiki. Two options were on the table:
  - **Single SOP** `wiki/sops/sop-meerkat-ownership.md` following the `sop-os-dev-onboarding.md` precedent (stretches the strict SOP rule but matches what exists)
  - **Split into 3** — sop-meerkat-change-workflow + playbook-meerkat-adjudication + ref-meerkat-system (cleaner schema fit, more files to maintain)
- **Memory-file references in appendix.** v3/v4 appendix referenced 4 files at `~/.claude/projects/-Users-elicurtin/memory/` — useless to Omar since he can't access Eli's machine. Future fix: copy these into `meerkatv4/docs/context/`:
  - feedback_post_cutover_login_failure_heuristic.md
  - feedback_never_delete_shared_auth_users.md
  - project_master_db_migration_complete_may2.md
  - project_meerkat_repo_consolidation_may16.md
  Then update the doc's appendix to point at the repo paths. Not done yet — pending Patrick's wiki decision so we know which doc(s) end up needing the update.

## How to apply
- If Patrick comes back wanting it in the wiki, follow `reference_constellation_os_wiki.md` for schema + process. Use v4 as the source, convert to markdown + add proper frontmatter.
- If he punts on the wiki and wants it elsewhere (shared Drive, etc.), the .docx is ready as-is.
- Either way, the meerkatv4/docs/context/ copy-in is a separate cleanup item — do it once the destination is settled so the appendix references point at the right place.
