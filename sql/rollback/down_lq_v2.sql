-- Rollback for Lead Qualification Pipeline v2. Removes ONLY lq_v2 objects:
-- the lq_v2 schema (all v2 data) and the public.lq_v2_* RPC functions.
-- It never touches v1 tables. Take a backup first if v2 data matters:
--   pg_dump "$LQ_V2_DATABASE_URL" --schema=lq_v2 > lq_v2_backup.sql
-- To keep data and only stop processing, deactivate the n8n workflows instead.

begin;

drop function if exists public.lq_v2_accept_batch(jsonb);
drop function if exists public.lq_v2_claim_notifications(integer, integer);
drop function if exists public.lq_v2_record_send_result(uuid, integer, jsonb);
drop function if exists public.lq_v2_record_reconcile_result(uuid, integer, jsonb);
drop function if exists public.lq_v2_operator_requeue(uuid, text, text);
drop function if exists public.lq_v2_operator_mark_sent(uuid, text, text, text);
drop function if exists public.lq_v2_log_workflow_error(jsonb);
drop function if exists public.lq_v2_purge_synthetic_run(text);
drop schema if exists lq_v2 cascade;

commit;
