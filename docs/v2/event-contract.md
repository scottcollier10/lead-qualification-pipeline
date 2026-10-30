# LQ v2 Event and Data Contract

A lead event is accepted once, scored once and stored with the exact input that produced its score. A retransmitted event returns the original outcome and changes nothing. The sender gets a success response only after everything is committed.

## Intake request

`POST /webhook/lq-v2-intake`

| Header | Value |
|---|---|
| `X-LQ-Webhook-Token` | Shared secret from the n8n Header Auth credential. Missing or wrong: n8n answers 403 before the workflow runs. |
| `Content-Type` | `application/json` |

Body: one event object, or an array of 1 to 50 event objects.

| Field | Required | Rules |
|---|---|---|
| `source_event_id` | yes | 1-200 chars of `A-Z a-z 0-9 . _ : -`. Stable for the life of the event: a sender retry must reuse it. |
| `source` | no | 1-40 chars of `a-z 0-9 _ -`. Default `synthetic`. Idempotency key is `(source, source_event_id)`. |
| `occurred_at` | no | ISO 8601. Used to order contact updates. Defaults to receive time. |
| `email` | yes | String, trimmed and lowercased, max 254, basic address shape. |
| `crm_object_id` | no | String or integer id, max 64. Stored, not used for identity yet. |
| `first_name` / `firstName`, `last_name` / `lastName` | no | Strings, max 100. |
| `company` | no | String, max 200. |
| `job_title` / `jobTitle` | no | String, max 200. Scoring input. |
| `employee_count` / `employeeCount` | no | Whole number >= 0, or a digit string. Scoring input. |
| `deal_size` / `dealSize` | no | Number >= 0, or a numeric string. Scoring input. Missing is recorded in `breakdown.missing_inputs`. |
| `lead_source` / `leadSource` | no | String, max 100. Scoring input. Default `unknown`. |
| `first_conversion`, `recent_conversion` | no | Strings, max 200. Scoring input. |
| `phone`, `website`, `industry`, `message` | no | Strings (50 / 255 / 100 / 5000 max). |

Each event is limited to 20,000 bytes of JSON. Unknown fields are ignored but kept in `raw_payload`. Wrong types are rejected, not coerced.

Example:

```json
{
  "source_event_id": "demo-0001",
  "source": "synthetic",
  "occurred_at": "2026-10-30T12:00:00Z",
  "email": "ada@example.test",
  "first_name": "Ada",
  "company": "Big Co",
  "job_title": "CEO",
  "employee_count": 1000,
  "deal_size": 100000,
  "lead_source": "referral"
}
```

That example scores fit 100, urgency 65, route `call_now`.

## Intake response

| Status | Meaning | Sender action |
|---|---|---|
| 202 | Every event `accepted` or `duplicate`. Committed. | Done. |
| 207 | Mixed. Read `results[].outcome` per index. | Fix and resend only the failed indexes. |
| 400 | Nothing accepted: every event `invalid` or `rejected`. No writes. | Fix the payload. Do not retry unchanged. |
| 409 | Nothing accepted: every event is a `conflict`. | The event id was reused for different content. Use a new id. |
| 403 | Missing or wrong webhook token (from n8n). No workflow run. | Fix the token. |
| 422 | Body is not valid JSON (from n8n). No workflow run. | Fix the body. |
| 503 | Database did not confirm. Nothing committed. | Retry with the same ids. Safe. |

Body: `{ "status": <code>, "results": [ ... ] }`, sorted by `index`. Per-event outcomes:

| `outcome` | Meaning |
|---|---|
| `accepted` | New event. Contact, event, score and any work item and notification intent committed together. |
| `duplicate` | Same `(source, source_event_id)` and identical payload already accepted. Returns the original ids, score and current notification status. Nothing written. Touch count unchanged. |
| `conflict` | Same id, different payload. Nothing written. |
| `invalid` | Failed validation. `errors[]` lists `{field, problem}`. Nothing written. |
| `rejected` | Passed validation but failed a database constraint. Nothing written for that event. Indicates a bug; check `errors[]`. |

An `accepted` or `duplicate` result includes `event_id`, `contact_id`, `is_new_contact`, `processing_outcome`, `score {id, fit, urgency, route, score_version}`, `work_item {id, kind}` or null, and `notification {id, status, correlation_id}` or null.

## Business rules preserved from v1

- Scoring is the v1 `Calculate Scores` code, unchanged (`score_version: rule-based-v1`). Timing still always adds 25 urgency points. A parity test runs the original node code against the same inputs.
- Routing by fit: 80 or above `call_now`, 50 to 79 `nurture`, below 50 `manual_review`. Enforced again by a database check constraint.
- Only a contact's first accepted event creates a work item. Only `call_now` work items create a Slack notification. Nurture and manual review are queue rows (`lq_v2.work_items`), not sent emails. Nurture keeps the v1 `next_action_at` of +3 days.

## Identity and returning contacts

- **Event identity:** `(source, source_event_id)`, unique in the database. Concurrent copies are serialized; exactly one is accepted.
- **Contact identity:** normalized email, unique. `crm_object_id` is stored for a future CRM adapter.
- **Returning contact:** a new event id for a known email. The contact is updated, `touch_count` goes up by one, a new score is stored with that event's scoring input, and no new work item or notification is created.
- **Field updates:** a newer event (by `occurred_at`) overwrites contact fields with its non-null values. An older, late-arriving event only fills blanks. `last_event_at` never moves backwards.
- **Retransmission is not engagement:** a duplicate never increments `touch_count`.

## Database contract (schema `lq_v2`)

Migrations: `sql/migrations/001_lq_v2_schema.sql`, `002_lq_v2_functions.sql`. Rollback: `sql/rollback/down_lq_v2.sql`.

| Table | One row per | Key guarantees |
|---|---|---|
| `contacts` | person | unique `email_normalized`; `touch_count` = distinct accepted events |
| `source_events` | accepted event | unique `(source, source_event_id)`; `payload_hash` (sha256 of the raw event); `raw_payload` and `normalized` kept; `processing_outcome` is `work_item_created` or `returning_contact_no_new_action` |
| `scores` | accepted event | unique `event_id`; `scoring_input`, `breakdown`, `score_version`; route must match fit |
| `work_items` | contact's first event | unique `event_id` and unique `contact_id` (first-contact policy enforced under concurrency) |
| `notifications` | `call_now` work item | unique `work_item_id` and `correlation_id`; delivery state machine (see delivery-contract.md) |
| `delivery_attempts` | send or reconcile attempt | provider response, HTTP status, Slack `ts` |
| `operator_actions` | operator requeue or mark-sent | actor, note, previous status |
| `workflow_errors` | error workflow run | workflow, execution id, last node, message |

An event row exists only if its contact update, score and any work item and notification intent were committed in the same transaction. There is no partially processed state to clean up.

Access: RLS is enabled on every table with no policies. The schema is not exposed through the Supabase API. n8n calls only these `public` functions, which are executable by `service_role` only:

| Function | Used by |
|---|---|
| `lq_v2_accept_batch(p_events jsonb)` | Intake |
| `lq_v2_claim_notifications(p_limit, p_lease_seconds)` | Dispatcher |
| `lq_v2_record_send_result(p_notification_id, p_attempt_no, p_result)` | Dispatcher |
| `lq_v2_record_reconcile_result(p_notification_id, p_attempt_no, p_result)` | Dispatcher |
| `lq_v2_log_workflow_error(p_error)` | Error handler |
| `lq_v2_operator_requeue`, `lq_v2_operator_mark_sent` | Operator (SQL editor) |
| `lq_v2_purge_synthetic_run(p_run_tag)` | Test reset (synthetic data only) |

The payload `lq_v2_accept_batch` receives per event is the normalized event from `src/normalize.js` plus `score` (from `src/score.js`) and `notification {target, text}` (from `src/notify.js`), as built by `src/intake.js`.

## Repeatable demo data

Use a run tag in every event id and email, for example `source_event_id: "demo7k2p-hot"` and `email: "hot+demo7k2p@example.test"`. A new tag gives a clean run with no cleanup. To remove one run:

```sql
select public.lq_v2_purge_synthetic_run('demo7k2p');
```

It deletes only `source = 'synthetic'` events whose id starts with `demo7k2p-`, plus their scores, work items, notifications and attempts. A contact is removed only if no other event references it. It refuses empty or wildcard tags.
