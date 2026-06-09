---
name: Never delete auth.users from app-level UIs in a shared master DB
description: After Constellation OS centralized auth in master, individual apps (Meerkat, AnswerBot, etc.) must NOT hard-delete auth.users. Per-app removal = remove from app's permission/membership table only. Hard delete only via Supabase dashboard with full awareness.
type: feedback
---
**Rule:** In a multi-app architecture sharing a master DB (Constellation OS), no app-level admin UI may call `auth.admin.deleteUser()` or directly delete from `auth.users`. The user record is shared infrastructure.

**Why:** Discovered 2026-05-06 that 5 active team members silently disappeared from master.auth.users between yesterday and today. Most likely path: someone clicked "Delete user" on the Meerkat admin dashboard post-cutover. The endpoint (`/api/delete-user-cascade`) hard-deleted from auth.users — which removed those users from EVERY OS tool (AnswerBot, ticket-bot, content-engine, content-engine), not just Meerkat. Cascading also destroyed their article history.

**How to apply:**
- Per-app "remove user" = delete that app's membership row only (e.g., `meerkat.team_members`, future `spr.permissions`). Leave auth.users intact.
- True cross-app user purge → done in Supabase dashboard with explicit "I understand the blast radius" awareness.
- Never reuse a Meerkat-style cascade-delete pattern for any app that touches the master DB. Cascading destruction in a shared DB has no safe semantics.
- Pattern hardened in meerkatv4 PR #56 + meerkatv3 PR #40 (2026-05-06): `/api/delete-user` removes from team_members only; `/api/delete-user-cascade` returns 410.

**Companion patterns for future apps:**
- Add a per-app `is_active` flag in the membership table for soft deactivation (no row deletion needed).
- If you find yourself writing a "cascade delete user" endpoint touching master, stop and reach for soft-delete or app-membership-removal instead.
- **App-level defangs aren't enough.** A second incident on 2026-05-07 surfaced: another methodical SQL session (May 5 22:09 UTC) had silently deleted 5 active users + orphaned 200 articles via raw SQL — bypassing the meerkatv4 PR #56 + meerkatv3 PR #40 defangs entirely. UI-button defangs only block app paths; SQL editor sessions, MCP tools, and direct `postgres`-role clients sail right through. Always install a **database-level BEFORE-DELETE trigger** on `auth.users` blocking everything except `supabase_auth_admin`. SQL lives at `~/meerkatv4/scripts/migration/auth-users-delete-guard.sql`. Idempotent; safe to re-apply on every fresh migration.
