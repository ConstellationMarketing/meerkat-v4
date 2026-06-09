-- Autosave telemetry table.
-- Created 2026-06-09 as part of PR #71 — preempt against future
-- silent-autosave-loss failure modes (June 2026 phantom-write incident).
--
-- The editor posts to /.netlify/functions/autosave-telemetry which writes
-- here. Event types:
--   save_error           — performAutoSave's catch block fired
--   edits_without_saves  — canary: ≥3 edits with 0 successful saves in 60s+
--   save_success         — reserved (not currently emitted)
--
-- Already applied to master Supabase (cwligyakhxevopxiksdm) at create time;
-- this file is kept for documentation / replay against fresh environments.
create table if not exists meerkat.autosave_telemetry (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  article_id text,
  user_email text,
  event_type text not null check (event_type in (
    'save_error',
    'edits_without_saves',
    'save_success'
  )),
  error_message text,
  details jsonb,
  user_agent text
);

create index if not exists autosave_telemetry_created_at_idx
  on meerkat.autosave_telemetry (created_at desc);
create index if not exists autosave_telemetry_article_id_idx
  on meerkat.autosave_telemetry (article_id);
create index if not exists autosave_telemetry_event_type_idx
  on meerkat.autosave_telemetry (event_type);

grant insert on meerkat.autosave_telemetry to authenticated, anon, service_role;
grant select on meerkat.autosave_telemetry to authenticated, service_role;
