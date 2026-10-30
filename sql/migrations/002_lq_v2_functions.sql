-- Lead Qualification Pipeline v2: transactional functions.
-- The n8n workflows call only the public.lq_v2_* functions through Supabase
-- RPC (PostgREST), with the service_role key. Each RPC call runs in one
-- database transaction. Internal helpers live in lq_v2 and are not exposed.

begin;

-- Summary of one accepted event, used for both first acceptance and duplicates.
create function lq_v2.event_outcome(p_event_id uuid, p_outcome text)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'outcome', p_outcome,
    'event_id', e.id,
    'source', e.source,
    'source_event_id', e.source_event_id,
    'contact_id', e.contact_id,
    'is_new_contact', e.is_new_contact,
    'processing_outcome', e.processing_outcome,
    'accepted_at', e.received_at,
    'score', jsonb_build_object('id', s.id, 'fit', s.fit, 'urgency', s.urgency, 'route', s.route, 'score_version', s.score_version),
    'work_item', case when w.id is null then null else jsonb_build_object('id', w.id, 'kind', w.kind) end,
    'notification', case when n.id is null then null else jsonb_build_object('id', n.id, 'status', n.status, 'correlation_id', n.correlation_id) end
  )
  from lq_v2.source_events e
  join lq_v2.scores s on s.event_id = e.id
  left join lq_v2.work_items w on w.event_id = e.id
  left join lq_v2.notifications n on n.work_item_id = w.id
  where e.id = p_event_id
$$;

-- Accepts one normalized, scored event (shape: docs/v2/event-contract.md).
-- Contact upsert, event record, score, work item and notification intent are
-- written together or not at all. A repeat of the same source event returns
-- the original outcome and writes nothing.
create function lq_v2.accept_event(p jsonb)
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

-- RPC: accept a batch of 1-50 events in one transaction. Data errors on one
-- event are reported as "rejected" for that event only; any other error aborts
-- the whole call so the sender gets a non-2xx and retries (safe: idempotent).
create function public.lq_v2_accept_batch(p_events jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_results jsonb := '[]'::jsonb;
  v_ev jsonb;
  v_res jsonb;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) not between 1 and 50 then
    raise exception using errcode = '22023', message = 'p_events must be an array of 1-50 events';
  end if;
  for v_ev in select value from jsonb_array_elements(p_events) loop
    begin
      v_res := lq_v2.accept_event(v_ev);
    exception when data_exception or check_violation or not_null_violation then
      v_res := jsonb_build_object(
        'outcome', 'rejected', 'source_event_id', v_ev->>'source_event_id',
        'errors', jsonb_build_array(jsonb_build_object('field', '(database)', 'problem', sqlerrm)));
    end;
    v_results := v_results || jsonb_build_array(v_res || jsonb_build_object('index', v_ev->'index'));
  end loop;
  return jsonb_build_object('results', v_results);
end $$;

-- RPC: dispatcher claim. In one transaction:
--   1. expired 'sending' leases become 'uncertain' (crash or lost receipt)
--   2. stuck reconciliations past their budget get operator_required
--   3. due 'pending' rows are leased for sending (SKIP LOCKED: safe to overlap)
--   4. due 'uncertain' rows are claimed for reconciliation
create function public.lq_v2_claim_notifications(p_limit integer default 10, p_lease_seconds integer default 120)
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
create function public.lq_v2_record_send_result(p_notification_id uuid, p_attempt_no integer, p_result jsonb)
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
create function public.lq_v2_record_reconcile_result(p_notification_id uuid, p_attempt_no integer, p_result jsonb)
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

-- RPC: operator puts a failed/uncertain notification back in the send queue
-- with 3 more attempts. For 'uncertain', the operator accepts duplicate risk.
create function public.lq_v2_operator_requeue(p_notification_id uuid, p_actor text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n lq_v2.notifications;
begin
  select * into n from lq_v2.notifications where id = p_notification_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'notification not found'; end if;
  if n.status not in ('failed', 'uncertain') then
    raise exception using errcode = '22023', message = 'only failed or uncertain notifications can be requeued (status: ' || n.status || ')';
  end if;
  update lq_v2.notifications
     set status = 'pending', next_attempt_at = now(), operator_required = false,
         max_attempts = least(20, greatest(max_attempts, attempt_count + 3)),
         max_reconciles = reconcile_count + 6, last_error = 'requeued by operator', updated_at = now()
   where id = n.id;
  insert into lq_v2.operator_actions (notification_id, action, actor, note, previous_status)
  values (n.id, 'requeue', p_actor, p_note, n.status);
  return jsonb_build_object('id', n.id, 'previous_status', n.status, 'status', 'pending');
end $$;

-- RPC: operator confirms a message was delivered (e.g. seen in the channel).
create function public.lq_v2_operator_mark_sent(p_notification_id uuid, p_actor text, p_message_ts text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare n lq_v2.notifications;
begin
  select * into n from lq_v2.notifications where id = p_notification_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'notification not found'; end if;
  if n.status = 'sent' then
    raise exception using errcode = '22023', message = 'notification already sent';
  end if;
  update lq_v2.notifications
     set status = 'sent', resolution = 'operator_marked_sent', provider_message_ts = coalesce(p_message_ts, provider_message_ts),
         sent_at = now(), lease_expires_at = null, operator_required = false, last_error = null, updated_at = now()
   where id = n.id;
  insert into lq_v2.operator_actions (notification_id, action, actor, note, previous_status)
  values (n.id, 'mark_sent', p_actor, p_note, n.status);
  return jsonb_build_object('id', n.id, 'previous_status', n.status, 'status', 'sent');
end $$;

-- RPC: error workflow log (best effort; Slack ops alert runs independently).
create function public.lq_v2_log_workflow_error(p_error jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id bigint;
begin
  insert into lq_v2.workflow_errors (workflow_name, execution_id, last_node, error_message, payload)
  values (left(p_error->>'workflow_name', 200), left(p_error->>'execution_id', 100), left(p_error->>'last_node', 200),
          left(p_error->>'error_message', 2000), p_error)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- RPC: narrowly scoped reset for one synthetic test run. Deletes only rows
-- whose source is 'synthetic' and whose source_event_id starts with
-- '<run_tag>-'; contacts are removed only when no other events reference them.
create function public.lq_v2_purge_synthetic_run(p_run_tag text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_events uuid[];
  v_contacts uuid[];
  v_deleted_contacts integer;
begin
  if p_run_tag is null or p_run_tag !~ '^[A-Za-z0-9]{6,64}$' then
    raise exception using errcode = '22023', message = 'run tag must be 6-64 alphanumeric characters';
  end if;
  select array_agg(id), array_agg(distinct contact_id) into v_events, v_contacts
    from lq_v2.source_events
   where source = 'synthetic' and starts_with(source_event_id, p_run_tag || '-');
  if v_events is null then
    return jsonb_build_object('events', 0, 'contacts', 0);
  end if;

  delete from lq_v2.operator_actions where notification_id in (select id from lq_v2.notifications where event_id = any(v_events));
  delete from lq_v2.delivery_attempts where notification_id in (select id from lq_v2.notifications where event_id = any(v_events));
  delete from lq_v2.notifications where event_id = any(v_events);
  delete from lq_v2.work_items where event_id = any(v_events);
  delete from lq_v2.scores where event_id = any(v_events);
  delete from lq_v2.source_events where id = any(v_events);
  delete from lq_v2.contacts c
   where c.id = any(v_contacts) and c.is_synthetic
     and not exists (select 1 from lq_v2.source_events e where e.contact_id = c.id);
  get diagnostics v_deleted_contacts = row_count;
  return jsonb_build_object('events', cardinality(v_events), 'contacts', v_deleted_contacts);
end $$;

-- Operator views (SQL editor / psql). Not exposed through the API.
create view lq_v2.ops_notification_summary as
select status, operator_required, count(*) as notifications, min(created_at) as oldest
  from lq_v2.notifications group by status, operator_required;

create view lq_v2.ops_attention as
select n.id, n.status, n.operator_required, n.attempt_count, n.max_attempts, n.reconcile_count,
       n.last_error, n.correlation_id, c.email_normalized as email, n.created_at, n.updated_at
  from lq_v2.notifications n join lq_v2.contacts c on c.id = n.contact_id
 where n.operator_required or n.status = 'failed'
    or (n.status in ('pending', 'uncertain') and n.created_at < now() - interval '10 minutes')
 order by n.created_at;

-- One row per accepted event: contact, exact scoring input, score, work item,
-- delivery state and receipt. Used for acceptance reconciliation.
create view lq_v2.event_ledger as
select e.source, e.source_event_id, e.received_at, e.is_new_contact, e.processing_outcome,
       c.email_normalized as email, c.touch_count,
       s.fit, s.urgency, s.route, s.score_version, s.scoring_input,
       w.kind as work_item_kind, w.queue_status,
       n.status as notification_status, n.attempt_count, n.resolution, n.provider_message_ts, n.correlation_id
  from lq_v2.source_events e
  join lq_v2.contacts c on c.id = e.contact_id
  join lq_v2.scores s on s.event_id = e.id
  left join lq_v2.work_items w on w.event_id = e.id
  left join lq_v2.notifications n on n.work_item_id = w.id;

-- Only service_role may call the RPC functions. Supabase grants EXECUTE on new
-- public functions to anon/authenticated by default, so revoke explicitly.
do $$
declare f text;
begin
  foreach f in array array[
    'public.lq_v2_accept_batch(jsonb)',
    'public.lq_v2_claim_notifications(integer, integer)',
    'public.lq_v2_record_send_result(uuid, integer, jsonb)',
    'public.lq_v2_record_reconcile_result(uuid, integer, jsonb)',
    'public.lq_v2_operator_requeue(uuid, text, text)',
    'public.lq_v2_operator_mark_sent(uuid, text, text, text)',
    'public.lq_v2_log_workflow_error(jsonb)',
    'public.lq_v2_purge_synthetic_run(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon, authenticated', f);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
end $$;

revoke all on all functions in schema lq_v2 from public;

insert into lq_v2.schema_migrations (version) values ('002_lq_v2_functions');

commit;
