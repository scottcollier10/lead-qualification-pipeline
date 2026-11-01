-- Lead Qualification Pipeline v2: isolated schema.
-- Apply to a DEDICATED, empty Supabase project with:
--   psql "$LQ_V2_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/migrations/001_lq_v2_schema.sql
-- Not re-runnable on purpose: plain CREATE fails loudly instead of silently
-- accepting a pre-existing, possibly incompatible object.

begin;

-- Isolation guard. Refuses to install next to the v1 tables unless the operator
-- explicitly overrides with: set lq_v2.allow_shared_database = 'yes-i-understand';
do $$
begin
  if (to_regclass('public.leads') is not null
      or to_regclass('public.scores') is not null
      or to_regclass('public.actions') is not null
      or to_regclass('public.nurture_queue') is not null)
     and coalesce(current_setting('lq_v2.allow_shared_database', true), '') <> 'yes-i-understand' then
    raise exception 'lq_v2 install refused: this database contains v1 lead tables (public.leads/scores/actions/nurture_queue). Use a dedicated project.';
  end if;
end $$;

create schema lq_v2;
revoke all on schema lq_v2 from public;

create table lq_v2.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

-- One row per person. Identity is the normalized email; the CRM object id is
-- kept alongside for a later CRM adapter.
create table lq_v2.contacts (
  id uuid primary key default gen_random_uuid(),
  email_normalized text not null unique
    check (email_normalized = lower(btrim(email_normalized)) and length(email_normalized) between 3 and 254 and email_normalized like '%_@_%'),
  crm_object_id text,
  name text,
  phone text,
  company text,
  website text,
  industry text,
  job_title text,
  employee_count integer check (employee_count >= 0),
  deal_size numeric check (deal_size >= 0),
  -- Number of distinct accepted source events. Retransmissions never increment it.
  touch_count integer not null default 1 check (touch_count >= 1),
  last_event_at timestamptz not null,
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per accepted source event. (source, source_event_id) is the
-- idempotency key; payload_hash detects an id reused for different content.
-- A row exists only if contact update, score and any work item/notification
-- intent were committed in the same transaction.
create table lq_v2.source_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source ~ '^[a-z0-9_-]{1,40}$'),
  source_event_id text not null check (source_event_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  payload_hash text not null,
  contact_id uuid not null references lq_v2.contacts(id),
  is_new_contact boolean not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  raw_payload jsonb not null,
  normalized jsonb not null,
  processing_outcome text not null
    check (processing_outcome in ('work_item_created', 'returning_contact_no_new_action')),
  constraint source_events_idempotency_key unique (source, source_event_id)
);
create index source_events_contact_idx on lq_v2.source_events (contact_id);

-- Exactly one score per accepted event, with the exact scoring input used.
create table lq_v2.scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references lq_v2.source_events(id),
  contact_id uuid not null references lq_v2.contacts(id),
  fit integer not null check (fit between 0 and 100),
  urgency integer not null check (urgency between 0 and 100),
  route text not null check (route in ('call_now', 'nurture', 'manual_review')),
  reason text not null,
  breakdown jsonb not null,
  scoring_input jsonb not null,
  score_version text not null,
  created_at timestamptz not null default now(),
  -- v1 thresholds enforced by the database as a backstop.
  constraint scores_route_matches_fit check (
    (fit >= 80 and route = 'call_now')
    or (fit between 50 and 79 and route = 'nurture')
    or (fit < 50 and route = 'manual_review')
  )
);

-- Work queue: call_now, nurture queue, manual review. v1 policy preserved:
-- only a contact's first accepted event creates a work item. unique(contact_id)
-- enforces that even under concurrency.
create table lq_v2.work_items (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references lq_v2.source_events(id),
  contact_id uuid not null unique references lq_v2.contacts(id),
  score_id uuid not null references lq_v2.scores(id),
  kind text not null check (kind in ('call_now', 'nurture', 'manual_review')),
  queue_status text not null default 'open' check (queue_status in ('open', 'done', 'cancelled')),
  next_action_at timestamptz,
  created_at timestamptz not null default now()
);

-- Durable notification intent plus delivery state.
--   pending   waiting to be sent (next_attempt_at)
--   sending   claimed by a dispatcher run (lease_expires_at)
--   sent      provider receipt stored, reconciled, or marked by an operator
--   failed    permanent error or retries exhausted; operator_required
--   uncertain the provider may have received it; reconcile before any resend
create table lq_v2.notifications (
  id uuid primary key default gen_random_uuid(),
  work_item_id uuid not null unique references lq_v2.work_items(id),
  event_id uuid not null references lq_v2.source_events(id),
  contact_id uuid not null references lq_v2.contacts(id),
  correlation_id text not null unique,
  channel text not null default 'slack' check (channel = 'slack'),
  target text not null check (target ~ '^[CGD][A-Z0-9]{2,30}$'),
  message_text text not null check (length(message_text) between 1 and 8000),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'uncertain')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz not null default now(),
  lease_expires_at timestamptz,
  reconcile_count integer not null default 0,
  max_reconciles integer not null default 6,
  next_reconcile_at timestamptz,
  operator_required boolean not null default false,
  last_error text,
  provider_message_ts text,
  provider_channel text,
  sent_at timestamptz,
  resolution text check (resolution in ('provider_ack', 'reconciled', 'operator_marked_sent')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notifications_sent_has_receipt check (
    status <> 'sent'
    or (sent_at is not null and resolution is not null
        and (provider_message_ts is not null or resolution = 'operator_marked_sent'))
  ),
  constraint notifications_sending_has_lease check (status <> 'sending' or lease_expires_at is not null)
);
create index notifications_due_idx on lq_v2.notifications (next_attempt_at) where status = 'pending';
create index notifications_uncertain_idx on lq_v2.notifications (next_reconcile_at) where status = 'uncertain';

-- Every send and reconcile attempt, with the provider response (receipt log).
create table lq_v2.delivery_attempts (
  id bigint generated always as identity primary key,
  notification_id uuid not null references lq_v2.notifications(id),
  kind text not null check (kind in ('send', 'reconcile')),
  attempt_no integer not null check (attempt_no >= 1),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in (
    'sent', 'retryable_failure', 'permanent_failure', 'uncertain', 'lease_expired',
    'found', 'not_found', 'reconcile_error')),
  http_status integer,
  provider_error text,
  message_ts text,
  provider_response jsonb,
  constraint delivery_attempts_unique unique (notification_id, kind, attempt_no)
);

create table lq_v2.operator_actions (
  id bigint generated always as identity primary key,
  notification_id uuid not null references lq_v2.notifications(id),
  action text not null check (action in ('requeue', 'mark_sent')),
  actor text not null check (length(actor) between 1 and 100),
  note text,
  previous_status text not null,
  created_at timestamptz not null default now()
);

create table lq_v2.workflow_errors (
  id bigint generated always as identity primary key,
  workflow_name text,
  execution_id text,
  last_node text,
  error_message text,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- Tables are reachable only through the public.lq_v2_* functions (migration 002).
-- RLS with no policies denies anon/authenticated even if the schema is later exposed.
alter table lq_v2.schema_migrations enable row level security;
alter table lq_v2.contacts enable row level security;
alter table lq_v2.source_events enable row level security;
alter table lq_v2.scores enable row level security;
alter table lq_v2.work_items enable row level security;
alter table lq_v2.notifications enable row level security;
alter table lq_v2.delivery_attempts enable row level security;
alter table lq_v2.operator_actions enable row level security;
alter table lq_v2.workflow_errors enable row level security;

insert into lq_v2.schema_migrations (version) values ('001_lq_v2_schema');

commit;
