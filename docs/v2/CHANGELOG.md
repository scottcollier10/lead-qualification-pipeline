# LQ v2 Changelog

## 2.0.1 (2026-11-01, review fixes, deployed 2026-11-01)

From the independent review of PR #1. Requires migration `003_review_fixes.sql` and updated Intake and Dispatcher workflows.

- **Future-dated events:** `occurred_at` more than 5 minutes ahead (UTC) is rejected, in validation and in `lq_v2.accept_event`. Previously one bad clock could freeze a contact's fields.
- **Malformed Slack channel:** now a deployment error (503 and an ops alert, with the whole request retried later) instead of a per-event 400 that silently dropped hot leads.
- **Ops alerts:** rows flagged by the claim step now raise one ops alert. Record functions report `newly_flagged`, so each flag alerts exactly once. Flags persist even if the alert fails.

## 2.0.0 (2026-10-30, not deployed)

A selective refactor of the v1 basic workflow (`lead-qualification-production-v1.json`). The scoring and routing rules stay the same. The event handling, persistence and Slack delivery underneath them are replaced.

### Kept from v1
- Scoring code unchanged (`rule-based-v1`). A parity test runs the original node against it.
- Fit thresholds: 80 or above call now, 50 to 79 nurture, below 50 manual review.
- First-contact-only outreach. Nurture `next_action_at` of +3 days. Slack message content.
- v1 input aliases (`firstName`, `jobTitle`, `employeeCount`, `dealSize`).

### Replaced
- **Event identity:** `(source, source_event_id)` replaces email lookup as the duplicate check. Retransmissions return the original outcome and never increment `touch_count`. Returning contacts are still recognized by email.
- **Persistence:** one transactional RPC (`lq_v2_accept_batch`) replaces seven separate Supabase REST calls. No lookup-then-insert or read-then-increment races. A uniqueness constraint backs every invariant.
- **Acknowledgement:** the webhook responds only after commit: 202 / 207 / 400 / 409, or 503 when not committed.
- **Validation:** strict types, email shape, size limits, per-event errors, batches of up to 50.
- **Authentication:** webhook header token (v1 had none).
- **Slack delivery:** moved out of intake into a dispatcher. Durable pending, sending, sent, failed and uncertain states, leases, bounded retries with backoff, Slack response validation, stored receipts, reconciliation through Slack message metadata, and operator requeue / mark-sent.
- **Error handling:** an error workflow that reads n8n's documented payload and alerts Slack and logs to the database independently. Operator-required notifications raise an alert.
- **Schema:** one canonical `lq_v2` schema with migrations, a rollback, an install guard against the v1 database, RLS, and service-role-only RPCs. Scoring input and score version are stored with every score.

### Removed from scope
Premium AI scoring, enrichment, news, Slack buttons, nurture email sending, HubSpot intake and writeback, multi-tenancy.

### Untouched
All v1 workflow exports, the v1 database and the deployed workflows. Checksums of the original exports are pinned in `docs/v2/original-exports.sha256` and checked by the test suite.
