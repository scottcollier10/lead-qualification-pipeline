-- Rollback for migration 003: restores the exact 002 function bodies.
-- Data is untouched. Run, then roll back the n8n workflows (docs/v2/deployment.md).

begin;

-- Accepts one normalized, scored event (shape: docs/v2/event-contract.md).
-- Contact upsert, event record, score, work item and notification intent are
-- written together or not at all. A repeat of the same source event returns
-- the original outcome and writes nothing.
create or replace function lq_v2.accept_event(p jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_source text := p->>'source';
  v_sid text := p->>'source_event_id';
  v_hash text := encode(sha256(convert_to(coalesce(p->'raw', 'null'::jsonb)::text, 'UTF8')), 'hex');
  v_event_at timestamptz := coalesce((p->>'occurred_at')::timestamptz, now());
  v_route text := p#>>'{score,route}';
  c jsonb := p->'contact';
  v_existing record;
  v_contact_id uuid;
  v_is_new boolean;
  v_event_id uuid := gen_random_uuid();
  v_score_id uuid;
  v_work_item_id uuid;
begin
  if v_source is null or v_sid is null or c is null or p->'score' is null then
    raise exception using errcode = '22023', message = 'source, source_event_id, contact and score are required';
  end if;

  -- Serialize concurrent deliveries of the same source event. The second
  -- caller waits, then sees the committed row and returns it as a duplicate.
  perform pg_advisory_xact_lock(hashtextextended(v_source || ':' || v_sid, 0));

  select id, payload_hash into v_existing
  from lq_v2.source_events where source = v_source and source_event_id = v_sid;
  if found then
    if v_existing.payload_hash = v_hash then
      return lq_v2.event_outcome(v_existing.id, 'duplicate');
    end if;
    return jsonb_build_object(
      'outcome', 'conflict', 'source', v_source, 'source_event_id', v_sid, 'original_event_id', v_existing.id,
      'errors', jsonb_build_array(jsonb_build_object('field', 'source_event_id', 'problem', 'already used for a different payload')));
  end if;

  -- Atomic upsert: no read-then-write race, no lost touch_count updates.
  -- Field policy: a newer event overwrites with its non-null values; an older
  -- (out-of-order) event only fills blanks.
  insert into lq_v2.contacts as t (
    email_normalized, crm_object_id, name, phone, company, website, industry, job_title,
    employee_count, deal_size, touch_count, last_event_at, is_synthetic)
  values (
    c->>'email', c->>'crm_object_id', c->>'name', c->>'phone', c->>'company', c->>'website', c->>'industry', c->>'job_title',
    (c->>'employee_count')::integer, (c->>'deal_size')::numeric, 1, v_event_at, v_source = 'synthetic')
  on conflict (email_normalized) do update set
    touch_count    = t.touch_count + 1,
    crm_object_id  = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.crm_object_id, t.crm_object_id) else coalesce(t.crm_object_id, excluded.crm_object_id) end,
    name           = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.name, t.name) else coalesce(t.name, excluded.name) end,
    phone          = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.phone, t.phone) else coalesce(t.phone, excluded.phone) end,
    company        = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.company, t.company) else coalesce(t.company, excluded.company) end,
    website        = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.website, t.website) else coalesce(t.website, excluded.website) end,
    industry       = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.industry, t.industry) else coalesce(t.industry, excluded.industry) end,
    job_title      = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.job_title, t.job_title) else coalesce(t.job_title, excluded.job_title) end,
    employee_count = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.employee_count, t.employee_count) else coalesce(t.employee_count, excluded.employee_count) end,
    deal_size      = case when excluded.last_event_at >= t.last_event_at then coalesce(excluded.deal_size, t.deal_size) else coalesce(t.deal_size, excluded.deal_size) end,
    last_event_at  = greatest(t.last_event_at, excluded.last_event_at),
    is_synthetic   = t.is_synthetic and excluded.is_synthetic,
    updated_at     = now()
  returning id, (xmax = 0) into v_contact_id, v_is_new;

  insert into lq_v2.source_events (
    id, source, source_event_id, payload_hash, contact_id, is_new_contact, occurred_at,
    raw_payload, normalized, processing_outcome)
  values (
    v_event_id, v_source, v_sid, v_hash, v_contact_id, v_is_new, (p->>'occurred_at')::timestamptz,
    coalesce(p->'raw', 'null'::jsonb), p - 'raw' - 'notification',
    case when v_is_new then 'work_item_created' else 'returning_contact_no_new_action' end);

  insert into lq_v2.scores (event_id, contact_id, fit, urgency, route, reason, breakdown, scoring_input, score_version)
  values (
    v_event_id, v_contact_id, (p#>>'{score,fit}')::integer, (p#>>'{score,urgency}')::integer, v_route,
    p#>>'{score,reason}', p#>'{score,breakdown}', p->'scoring_input', p#>>'{score,score_version}')
  returning id into v_score_id;

  -- v1 policy: only the first event for a contact creates outreach/queue work.
  if v_is_new then
    insert into lq_v2.work_items (event_id, contact_id, score_id, kind, next_action_at)
    values (v_event_id, v_contact_id, v_score_id, v_route,
            case when v_route = 'nurture' then now() + interval '3 days' end)
    returning id into v_work_item_id;

    if v_route = 'call_now' then
      -- Missing target is a deployment error, not bad lead data: abort the whole
      -- request (sender gets 503 and retries) rather than lose the notification.
      if coalesce(p#>>'{notification,target}', '') = '' or coalesce(p#>>'{notification,text}', '') = '' then
        raise exception using errcode = 'P0001', message = 'notification target/text missing: check LQ_V2_SLACK_CHANNEL_ID build setting';
      end if;
      insert into lq_v2.notifications (work_item_id, event_id, contact_id, correlation_id, target, message_text)
      values (v_work_item_id, v_event_id, v_contact_id, 'lqv2:' || v_source || ':' || v_sid,
              p#>>'{notification,target}', p#>>'{notification,text}');
    end if;
  end if;

  return lq_v2.event_outcome(v_event_id, 'accepted');
end $$;

-- RPC: dispatcher claim. In one transaction:
--   1. expired 'sending' leases become 'uncertain' (crash or lost receipt)
--   2. stuck reconciliations past their budget get operator_required
--   3. due 'pending' rows are leased for sending (SKIP LOCKED: safe to overlap)
--   4. due 'uncertain' rows are claimed for reconciliation
create or replace function public.lq_v2_claim_notifications(p_limit integer default 10, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_lease interval := make_interval(secs => greatest(30, least(p_lease_seconds, 900)));
  v_limit integer := greatest(1, least(p_limit, 50));
  v_sends jsonb;
  v_reconciles jsonb;
begin
  with expired as (
    update lq_v2.notifications
       set status = 'uncertain', lease_expires_at = null, next_reconcile_at = now(), updated_at = now(),
           last_error = 'lease expired before a result was recorded; delivery outcome unknown'
     where status = 'sending' and lease_expires_at < now()
    returning id, attempt_count)
  update lq_v2.delivery_attempts a
     set finished_at = now(), outcome = 'lease_expired'
    from expired x
   where a.notification_id = x.id and a.kind = 'send' and a.attempt_no = x.attempt_count and a.finished_at is null;

  update lq_v2.notifications
     set operator_required = true, updated_at = now(), last_error = 'reconciliation attempts exhausted; operator decision required'
   where status = 'uncertain' and not operator_required
     and reconcile_count >= max_reconciles and next_reconcile_at <= now();

  with picked as (
    select id from lq_v2.notifications
     where status = 'pending' and next_attempt_at <= now()
     order by next_attempt_at, created_at
     limit v_limit
     for update skip locked),
  claimed as (
    update lq_v2.notifications n
       set status = 'sending', attempt_count = n.attempt_count + 1, lease_expires_at = now() + v_lease, updated_at = now()
      from picked where n.id = picked.id
    returning n.*),
  attempts as (
    insert into lq_v2.delivery_attempts (notification_id, kind, attempt_no)
    select id, 'send', attempt_count from claimed)
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', 'send', 'notification_id', id, 'attempt_no', attempt_count,
           'channel', target, 'text', message_text, 'correlation_id', correlation_id)), '[]'::jsonb)
    into v_sends from claimed;

  with picked as (
    select id from lq_v2.notifications
     where status = 'uncertain' and not operator_required
       and reconcile_count < max_reconciles and next_reconcile_at <= now()
     order by next_reconcile_at
     limit v_limit
     for update skip locked),
  claimed as (
    update lq_v2.notifications n
       set reconcile_count = n.reconcile_count + 1, next_reconcile_at = now() + v_lease, updated_at = now()
      from picked where n.id = picked.id
    returning n.*),
  attempts as (
    insert into lq_v2.delivery_attempts (notification_id, kind, attempt_no)
    select id, 'reconcile', reconcile_count from claimed)
  select coalesce(jsonb_agg(jsonb_build_object(
           'mode', 'reconcile', 'notification_id', c.id, 'attempt_no', c.reconcile_count,
           'channel', c.target, 'correlation_id', c.correlation_id,
           'oldest', (select (floor(extract(epoch from min(a.started_at))) - 60)::bigint::text
                        from lq_v2.delivery_attempts a where a.notification_id = c.id and a.kind = 'send'))), '[]'::jsonb)
    into v_reconciles from claimed c;

  return jsonb_build_object('claims', v_sends || v_reconciles, 'claimed_at', now());
end $$;

-- RPC: record the classified result of one send attempt.
-- p_result: {outcome, message_ts?, provider_channel?, http_status?, provider_error?, provider_response?}
-- A provider receipt ("sent") is always recorded, even if it arrives late.
-- Any other result counts only for the attempt that still holds the lease.
create or replace function public.lq_v2_record_send_result(p_notification_id uuid, p_attempt_no integer, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  n lq_v2.notifications;
  v_outcome text := p_result->>'outcome';
  v_ts text := nullif(p_result->>'message_ts', '');
  v_applied boolean := false;
begin
  if v_outcome is null or v_outcome not in ('sent', 'retryable_failure', 'permanent_failure', 'uncertain') then
    raise exception using errcode = '22023', message = 'invalid outcome: ' || coalesce(v_outcome, 'null');
  end if;
  if v_outcome = 'sent' and v_ts is null then
    raise exception using errcode = '22023', message = 'outcome sent requires message_ts';
  end if;

  select * into n from lq_v2.notifications where id = p_notification_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'notification not found';
  end if;

  update lq_v2.delivery_attempts
     set finished_at = now(), outcome = v_outcome, http_status = (p_result->>'http_status')::integer,
         provider_error = p_result->>'provider_error', message_ts = v_ts, provider_response = p_result->'provider_response'
   where notification_id = n.id and kind = 'send' and attempt_no = p_attempt_no;

  if v_outcome = 'sent' then
    if n.status = 'sent' then
      if n.provider_message_ts is distinct from v_ts then
        update lq_v2.notifications
           set operator_required = true, updated_at = now(),
               last_error = 'duplicate delivery detected: extra Slack message ts ' || v_ts
         where id = n.id;
      end if;
    else
      update lq_v2.notifications
         set status = 'sent', provider_message_ts = v_ts, provider_channel = p_result->>'provider_channel',
             sent_at = now(), resolution = 'provider_ack', lease_expires_at = null,
             operator_required = false, last_error = null, updated_at = now()
       where id = n.id;
      v_applied := true;
    end if;
  elsif n.status = 'sending' and n.attempt_count = p_attempt_no then
    v_applied := true;
    if v_outcome = 'retryable_failure' and n.attempt_count < n.max_attempts then
      update lq_v2.notifications
         set status = 'pending', lease_expires_at = null, updated_at = now(),
             next_attempt_at = now() + least(interval '15 minutes', interval '30 seconds' * power(2, n.attempt_count - 1)),
             last_error = p_result->>'provider_error'
       where id = n.id;
    elsif v_outcome = 'uncertain' then
      update lq_v2.notifications
         set status = 'uncertain', lease_expires_at = null, updated_at = now(),
             next_reconcile_at = now() + interval '60 seconds',
             last_error = 'outcome unknown: ' || coalesce(p_result->>'provider_error', '')
       where id = n.id;
    else
      update lq_v2.notifications
         set status = 'failed', lease_expires_at = null, operator_required = true, updated_at = now(),
             last_error = case when v_outcome = 'retryable_failure' then 'retries exhausted: ' else 'permanent: ' end
                          || coalesce(p_result->>'provider_error', '')
       where id = n.id;
    end if;
  end if;

  return jsonb_build_object('applied', v_applied, 'notification', (
    select jsonb_build_object('id', id, 'status', status, 'attempt_count', attempt_count, 'operator_required', operator_required)
      from lq_v2.notifications where id = n.id));
end $$;

-- RPC: record a reconciliation lookup (Slack conversations.history search by
-- message metadata). found -> sent. not_found (conclusive) -> requeue within the
-- attempt budget. reconcile_error -> retry later, then operator.
create or replace function public.lq_v2_record_reconcile_result(p_notification_id uuid, p_attempt_no integer, p_result jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  n lq_v2.notifications;
  v_outcome text := p_result->>'outcome';
  v_ts text := nullif(p_result->>'message_ts', '');
  v_applied boolean := false;
begin
  if v_outcome is null or v_outcome not in ('found', 'not_found', 'reconcile_error') then
    raise exception using errcode = '22023', message = 'invalid outcome: ' || coalesce(v_outcome, 'null');
  end if;
  if v_outcome = 'found' and v_ts is null then
    raise exception using errcode = '22023', message = 'outcome found requires message_ts';
  end if;

  select * into n from lq_v2.notifications where id = p_notification_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'notification not found';
  end if;

  update lq_v2.delivery_attempts
     set finished_at = now(), outcome = v_outcome, http_status = (p_result->>'http_status')::integer,
         provider_error = p_result->>'provider_error', message_ts = v_ts, provider_response = p_result->'provider_response'
   where notification_id = n.id and kind = 'reconcile' and attempt_no = p_attempt_no;

  if v_outcome = 'found' and n.status <> 'sent' then
    update lq_v2.notifications
       set status = 'sent', provider_message_ts = v_ts, provider_channel = n.target, sent_at = now(),
           resolution = 'reconciled', lease_expires_at = null, operator_required = false, last_error = null, updated_at = now()
     where id = n.id;
    v_applied := true;
  elsif v_outcome = 'found' and n.provider_message_ts is not null and n.provider_message_ts is distinct from v_ts then
    -- Already sent with a different message: two real Slack messages exist.
    update lq_v2.notifications
       set operator_required = true, updated_at = now(),
           last_error = 'duplicate delivery detected: reconcile found extra Slack message ts ' || v_ts
     where id = n.id;
  elsif n.status = 'uncertain' and n.reconcile_count = p_attempt_no then
    v_applied := true;
    if v_outcome = 'not_found' then
      if n.attempt_count < n.max_attempts then
        update lq_v2.notifications
           set status = 'pending', next_attempt_at = now(), updated_at = now(),
               last_error = 'reconciled: not in Slack history; requeued'
         where id = n.id;
      else
        update lq_v2.notifications
           set status = 'failed', operator_required = true, updated_at = now(),
               last_error = 'reconciled: not in Slack history; retries exhausted'
         where id = n.id;
      end if;
    elsif n.reconcile_count >= n.max_reconciles then
      update lq_v2.notifications
         set operator_required = true, updated_at = now(),
             last_error = 'reconciliation inconclusive: ' || coalesce(p_result->>'provider_error', '')
       where id = n.id;
    else
      update lq_v2.notifications
         set next_reconcile_at = now() + interval '60 seconds' * n.reconcile_count, updated_at = now(),
             last_error = 'reconciliation inconclusive: ' || coalesce(p_result->>'provider_error', '')
       where id = n.id;
    end if;
  end if;

  return jsonb_build_object('applied', v_applied, 'notification', (
    select jsonb_build_object('id', id, 'status', status, 'attempt_count', attempt_count, 'operator_required', operator_required)
      from lq_v2.notifications where id = n.id));
end $$;

delete from lq_v2.schema_migrations where version = '003_review_fixes';

commit;
