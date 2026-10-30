# LQ v2 Notification Delivery Contract

Accepting a lead and telling Slack about it are separate steps. Intake commits a durable notification row. A dispatcher workflow delivers it, records Slack's receipt, retries within limits, and checks Slack's own history before resending anything it is unsure about.

**What this does not promise:** exactly-once delivery to Slack. Slack's `chat.postMessage` has no idempotency key, so no system can guarantee that. This design guarantees at most one *recorded* delivery per notification, never resends when Slack may already have the message, and flags any detected duplicate for an operator.

## States

| Status | Meaning |
|---|---|
| `pending` | Waiting for `next_attempt_at`. |
| `sending` | Claimed by a dispatcher run, which holds a 120 second lease. |
| `sent` | Done. Has `sent_at`, a `resolution`, and a Slack `provider_message_ts` (unless an operator marked it sent). |
| `failed` | Permanent Slack error, or 5 attempts used up. `operator_required = true`. |
| `uncertain` | Slack may have the message: timeout, 5xx, or no receipt recorded. Must be reconciled before any resend. |

`resolution` on sent rows: `provider_ack` (Slack returned ok with a ts), `reconciled` (found in channel history), `operator_marked_sent`.

## Transitions

```text
pending --claim--> sending --ok + ts-----------------------> sent (provider_ack)
                           --429 / rate limited / refused--> pending (backoff 30s, 60s, 120s ... max 15m)
                                                             or failed after 5 attempts
                           --4xx / ok:false permanent------> failed (operator_required)
                           --timeout / 5xx / ok without ts-> uncertain (reconcile after 60s)
                           --lease expired, no result------> uncertain (reconcile now)

uncertain --history has message----------> sent (reconciled)
          --history conclusively lacks it-> pending (resend now), or failed if no attempts left
          --history call failed / more pages--> retry later; after 6 lookups operator_required

failed or uncertain --operator requeue---> pending (+3 attempts)
any but sent        --operator mark sent-> sent (operator_marked_sent)
```

Rules the database enforces:

- Only the attempt holding the lease can change state with a non-success result. Late or stale results are logged but ignored.
- A Slack receipt (`sent` with a ts) is always recorded, even if it arrives late. If a different ts arrives for an already sent notification, the row is flagged `operator_required` with "duplicate delivery detected".
- `sent` without a receipt is rejected by a check constraint.
- Overlapping dispatcher runs cannot claim the same row (`FOR UPDATE SKIP LOCKED`).

## Slack call details

- Send: `POST https://slack.com/api/chat.postMessage` with `channel`, `text`, `unfurl_links: false`, and `metadata: {event_type: "lq_v2_notification", event_payload: {notification_id, correlation_id}}`.
- Reconcile: `GET conversations.history?channel=...&oldest=<first attempt - 60s>&include_all_metadata=true&limit=200`, then match `metadata.event_payload.notification_id`. If `has_more` is true and no match is found, the result is inconclusive rather than "not found".
- The HTTP node uses full response plus never-error, so the classifier sees every Slack answer. Network failures go to the node's error output. Only the `error` field of that item is classified. The n8n item also carries the claim, including lead-supplied text, and that text must not influence the outcome.
- n8n's auto-retry is off on Slack calls. All retries are scheduled by the database, so they are bounded and visible.
- Correlation id: `lqv2:<source>:<source_event_id>`. It appears in the message text (`*Ref:*`), in Slack metadata, and in `lq_v2.notifications`.

Classification (`src/notify.js`):

| Slack answer | Outcome |
|---|---|
| 2xx, `ok: true`, has `ts` and `channel` | `sent` |
| 2xx, `ok: true`, missing `ts` | `uncertain` |
| `ok: false` with `ratelimited` / `service_unavailable`, or HTTP 429 | `retryable_failure` |
| `ok: false` with `internal_error` / `fatal_error` / `request_timeout`, or HTTP 5xx | `uncertain` |
| Any other `ok: false` (e.g. `channel_not_found`, `invalid_auth`, `not_in_channel`), or other 4xx | `permanent_failure` |
| Connection refused or DNS failure (request never sent) | `retryable_failure` |
| Timeout, reset, or any other network error | `uncertain` |

## Visibility

- A workflow run that errors (for example the receipt write fails) triggers **LQ v2 - Error Handler**. It posts to the ops channel and writes `lq_v2.workflow_errors` in parallel. Either can fail without blocking the other.
- A recorded result that needs a human (`failed`, or reconciliation exhausted) makes the dispatcher raise an error at the **Raise Operator Alert** node *after* the state is committed. The error handler then alerts the same way.
- Known gap: if a dispatcher run crashes mid-reconciliation six times in a row, the claim sweep flags the row without an alert. It still appears in `lq_v2.ops_attention`.

## Operator runbook (Supabase SQL editor)

```sql
-- Overview
select * from lq_v2.ops_notification_summary;

-- Needs attention: failed, flagged, or pending/uncertain for over 10 minutes
select * from lq_v2.ops_attention;

-- Full history of one notification
select * from lq_v2.delivery_attempts where notification_id = '<id>' order by id;

-- Recent workflow errors
select * from lq_v2.workflow_errors order by id desc limit 20;

-- After fixing the cause (e.g. bot re-invited to the channel): send again.
-- For an 'uncertain' row, check the channel first: requeue accepts duplicate risk.
select public.lq_v2_operator_requeue('<id>', '<your name>', '<why>');

-- You can see the message in Slack: record it as delivered, no resend.
select public.lq_v2_operator_mark_sent('<id>', '<your name>', '<slack ts or null>', '<why>');

-- Reconcile one lead end to end
select * from lq_v2.event_ledger where source_event_id = '<id>';
```

Every operator action is written to `lq_v2.operator_actions`.

## Recovery behavior

| Failure | What happens |
|---|---|
| Slack down or rate limited | Rows wait in `pending` with backoff. They deliver when Slack recovers. Lead and score are untouched. |
| Slack accepted, receipt write failed | The row stays `sending`. When the lease expires it becomes `uncertain`, reconciliation finds the message, and it is marked `sent (reconciled)`. No resend. |
| n8n crashes mid-send | Same as above. |
| Database down during dispatch | The claim fails, so nothing is sent. The next run picks up. |
| Database down during intake | The sender gets 503 and nothing is committed. The sender retries. |
| Dispatcher workflow inactive | Rows accumulate in `pending`. Activating it drains them. |
