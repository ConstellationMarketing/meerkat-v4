-- Batch queue: /batch/start and /os/optimize/start enqueue instead of
-- refusing when the engine is busy. Additive only; apply to the master
-- project (cwligyakhxevopxiksdm) before deploying lib/queue.js.
--
-- queue_kind:    'generate' | 'optimize' — which runner starts the batch.
-- queue_payload: the enriched articles/items array a queued batch runs with;
--                nulled when the batch is claimed so rows stay light.
alter table meerkat.batch_jobs add column if not exists queue_kind text;
alter table meerkat.batch_jobs add column if not exists queue_payload jsonb;
