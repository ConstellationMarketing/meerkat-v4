---
name: Post-cutover login failure heuristic — check encrypted_password drift first, admin-API reset as fallback
description: After the master DB cutover (2026-05), the dominant cause of "user can't log in" reports is encrypted_password drift between old and master auth.users. Telling the user to use "forgot password" is the wrong first move because Supabase's reset flow on master appears flaky.
type: feedback
---
**Rule:** When a Constellation OS user reports they can't log in after the master DB cutover, the diagnostic order is:

1. **Compare `encrypted_password` between old.auth.users and master.auth.users** for that email. If different, sync from old (`UPDATE master.auth.users SET encrypted_password = <old_value> WHERE email = ...`). Lets them keep using the password they've been using all along.
2. **If that doesn't work** (or the user already tried "forgot password" and partially completed it, leaving the hash in an unusable state), use `supabase.auth.admin.updateUserById(id, { password })` via the service role to set a known temporary password. Communicate it to them via Slack and ask them to change after login.
3. **Don't tell them to use "forgot password" as the first move.** Recovery_sent_at gets cleared even on failed flows, but the hash gets modified mid-flow — leaving the user worse off than before.

**Why:** Discovered 2026-05-07 with Lindsay. Her hash had been re-synced earlier that day (matched old Meerkat). She tried "forgot password" between my sync and her login, which changed her hash to something unusable. Recovery_sent_at was null (cleared) but updated_at confirmed the row had been touched. Re-syncing from old didn't help (she'd already forgotten that password). admin.updateUserById with a temp password resolved it.

**How to apply:**
- For diagnostic queries you already have postgres access via `MEERKAT_PG_URL` + `MASTER_PG_URL` (session pooler) in `~/meerkatv4/.env`.
- The 4 users whose UUIDs differ between old and master (Patrick, Lindsay, Omar, omaralcos2001) are the most likely to hit this — they have fresh master accounts created independent of their old Meerkat passwords. Their hashes were synced 2026-05-02 but any subsequent reset-flow attempt invalidates that sync.
- Long-term fix: investigate why Supabase's password-reset email flow on master is flaky. Until then, telegraph "use the admin reset path" rather than the broken email reset.
