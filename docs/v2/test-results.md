# LQ v2 Test Results

Run date: 2026-10-30. Branch `feat/lq-v2-reliable-pipeline`. **98 automated tests, 98 passed, 0 failed.** Every test ran locally. No cloud resource, deployed workflow, production database or live Slack workspace was touched.

## Evidence levels

| Level | Meaning |
|---|---|
| **Unit** | Pure JS in Node 22. No I/O. |
| **DB** | Real PostgreSQL in Docker (`supabase/postgres:17.6.1.132`, the same image Supabase hosts, with the same roles). The real migrations and functions. |
| **n8n** | The built v2 workflows imported and activated in throwaway local **n8n 2.14.2 and 2.38.7** containers (12/12 on each; 2.38.7 is the Render version), called over HTTP. Real PostgREST v14.1 and Postgres. |
| **Simulated** | Slack, and in E7 the database outage, are fakes with failure injection. They model documented behavior. They are not the real service. |

| Suite | Command | Tests | Result |
|---|---|---|---|
| Unit: scoring parity, validation, classification | `npm run test:unit` | 44 | pass |
| Workflow exports: drift, graph, Code-node execution | `npm run test:workflows` | 12 | pass |
| DB: acceptance | `npm run test:db` | 16 | pass |
| DB: delivery state machine (Slack simulated) | `npm run test:db` | 14 | pass |
| n8n end-to-end (Slack simulated) | `npm run test:e2e` | 12 | pass |

Unit + workflow + DB = 86 tests (`npm test`). The e2e suite adds 12. The parity test covers 6 fixture profiles plus 6 extra inputs against the original v1 node code.

## Acceptance scenarios from the verification report

| # | Scenario | Result | Where | Evidence |
|---|---|---|---|---|
| 1 | New high-fit lead | **Pass** | DB 1, e2e E3 | One contact, event, score, work item and notification. Fit 100, urgency 65. One Slack message, `provider_message_ts` stored and equal to the message ts, `resolution = provider_ack`. **Slack simulated.** |
| 2 | Repeated source event | **Pass** | DB 2, 2b, 2c, e2e E4 | Duplicate returns the original event, score and notification ids. No writes. `touch_count` stays 1. A reused id with a different payload returns `conflict` and writes nothing. |
| 3 | Concurrent duplicate events | **Pass** | DB 3 (12 parallel), e2e E4 (8 parallel HTTP) | Exactly one `accepted`. One Slack message after further dispatcher cycles. |
| 4 | Returning lead, genuinely new event | **Pass** | DB 4, 5, e2e E6 | Same contact id, `touch_count` incremented, new score with that event's scoring input, no new work item or notification. 10 simultaneous engagements: `touch_count = 10`, exactly 1 work item. Late older event fills blanks only. |
| 5 | Deterministic routing boundaries | **Pass** | Unit, DB 6, 6b, e2e E5 | Fit 49 / 50 / 79 / 80 route to manual_review / nurture / nurture / call_now, stable across runs. VP + 250 employees + no deal scores 52 with `missing_inputs: [deal_size]`. The database rejects a route that contradicts fit. |
| 6 | Invalid input, unauthorized submissions, batches | **Pass** | Unit (13 bad-field cases + bad bodies), DB 7, 7b, e2e E1, E2, E5 | Missing or wrong token: 403 from n8n, no writes. Bad fields: 400 with per-field errors, no writes. Malformed JSON: 422 from n8n. Mixed batch: 207 with per-index outcomes. `anon` and `authenticated` cannot call the RPCs or read the tables. |
| 7 | Slack delivery failure and recovery | **Pass** | DB D2, D3, D4, e2e E8, E12 | Rate limit or refused connection: back to `pending` with backoff, then one confirmed message with no new lead or score. Permanent error: `failed` + `operator_required`, ops alert raised (E12), operator requeue recovers (D3). Retries stop at 5 (D4). **Slack simulated.** |
| 8 | Slack success, receipt persistence fails | **Pass** | DB D5, D9, e2e E9 | Row held in `sending`, then `uncertain` when the lease expires. Reconciliation finds the message: `sent (reconciled)`, still exactly one message. The error workflow posted an ops alert and logged `last_node = Record Send Result (RPC)`. A late receipt is still recorded (D9). **Slack and the receipt-write failure simulated.** |
| 9 | Database failure and recovery | **Pass** | DB 9, e2e E7 | Backend killed mid-transaction: nothing persisted, retry accepted exactly once (real Postgres termination). Unreachable database: the call fails, so there is no success response. Through n8n: 503 `not_accepted`, nothing written, retry accepted (outage **simulated** at the proxy in front of PostgREST). |
| 10 | Repeated execution without broad cleanup | **Pass** | DB 10, all suites | Every fixture uses a unique run tag. The DB and e2e suites were run repeatedly against the same database with no cleanup. The purge removes only its own run and refuses empty or wildcard tags. |
| Timeouts | Slack timeout or 5xx | **Pass** | DB D6, D7, e2e E10, E11 | A real 10 s n8n timeout fails the dispatcher run and alerts ops; lease expiry makes it `uncertain`; reconciled as absent; resent once (E10). 500 after posting: reconciled as delivered, never resent (E11). **Slack simulated.** |
| Ledger | Persisted-state reconciliation | **Pass** | DB ledger test | `lq_v2.event_ledger` ties contact, event, scoring input, score version, route, work item, delivery state and receipt. |
| Isolation | No install next to v1 | **Pass** | DB 11, workflow tests | Migration refuses a database containing `public.leads`. The build refuses the v1 URL. Exports contain no v1 URL, webhook path, Slack user or credential IDs. The original exports' checksums are unchanged. |

## Issues found by testing and fixed

1. **Error-output classification could be influenced by lead text.** On n8n 2.14.2, an HTTP node's error output carries the input item (including the lead's company and name) plus `error`. The classifier read the whole item. A lead named "ECONNREFUSED" could have turned a timeout into a retry and risked a duplicate message. Fix: classify and store only `$json.error`. A regression test covers it.
2. **Permanent failures were silent.** A notification marked `failed` came from a *successful* dispatcher run, so no alert fired. Fix: the **Raise Operator Alert** node errors after the state commit, which routes through the error handler (Slack ops + DB log). Verified in e2e E12.
3. **Execution volume.** A per-minute dispatcher saving all executions would add about 1,440 runs a day to n8n's SQLite. Fix: the dispatcher keeps failed executions only.
4. **Duplicate delivery missed on the reconcile path** (independent code review). A stale reconcile lookup that found a different message for an already-sent notification changed nothing. Fix: flag `operator_required`, same as the send path. Regression test D13.
5. A test-only bug: email lookup in the DB helper was case-sensitive.
6. **Deployment through the n8n-workflow-builder MCP drops per-node `onError`.** The workflows no longer use it: the RPC and Slack calls use never-error responses, and network failures fall back to the error workflow plus lease recovery. A test now fails if any node uses `onError`. This also supersedes fix 1, since error-output items are no longer classified.

Observed n8n behavior that the design now depends on (verified on 2.14.2): a webhook with Header Auth returns 403 before the workflow runs; malformed JSON returns 422; `Respond to Webhook` honors an expression response code; HTTP 4.2 `neverError` + `fullResponse` exposes status and body; `$('Split Claims').item` pairs correctly through IF and HTTP nodes; a timeout appears as `NodeApiError` "The connection was aborted, perhaps the server is offline" with no error code.

## Live verification (2026-10-31, Render n8n 2.38.7 + Supabase "Lead Qualifier Pro" + Slack)

| Item | Result | Evidence |
|---|---|---|
| Hosted Supabase API and key | **Pass** | `apikey` header only (secret key). An `Authorization` header holding a non-JWT fails with 401 PGRST301. |
| Credential binding after MCP update | **Pass** | All RPC and Slack nodes resolve their credentials |
| Webhook header auth on Render | **Pass** | Correct token accepted; missing token 403 before any execution |
| Intake: new hot lead, duplicate, returning contact, invalid input | **Pass** | Smoke run `smoke1793421159`: 202 accepted (fit 100 / urgency 65), 202 duplicate with original ids, 202 returning (touch_count 2, no notification), 400 |
| Real Slack permanent error | **Pass** | `not_in_channel` classified permanent: one attempt, `failed`, operator flag, error workflow logged `Raise Operator Alert` |
| Real Slack delivery | **Pass** | Smoke run `smoke1793504469`: `sent`, `provider_ack`, Slack ts `1793504477.477149` stored, first attempt |
| **Slack metadata round trip / reconciliation** | **Pass** | Row forced to `uncertain`; next dispatcher run found the same ts in `conversations.history` via metadata: `sent (reconciled)`, no second message |
| Narrow purge | **Pass** | `lq_v2_purge_synthetic_run('smoke1793421159')` removed 2 events, 1 contact, nothing else |

Still open: an ops alert reaching the ops channel after the bot was invited (the only alert so far fired before the invite), behavior under load, and Render free-tier sleep latency.

Out of scope by decision: HubSpot intake and signature verification (synthetic intake uses a shared header token), CRM writeback, AI scoring, enrichment, Slack buttons, nurture email sending.

## Reproduce

```bash
npm install
npm run db:up            # local Supabase Postgres in Docker, applies migrations
npm test                 # unit + workflow + DB
npm run e2e:up           # local n8n 2.14.2 + PostgREST + fake Slack
                         # (LQ_V2_E2E_N8N_IMAGE=n8nio/n8n:2.38.7 for the Render version)
npm run test:e2e
npm run e2e:down && npm run db:down
```
