# Lead Qualification Pipeline v2

Synthetic lead in, deterministic score, durable work item, one confirmed Slack alert for hot leads. Retries, duplicates and outages do not create double leads, double scores or blind resends.

```text
sender --POST /webhook/lq-v2-intake (header token)--> n8n: LQ v2 - Intake
   validate + score (src/, inlined)  ->  RPC lq_v2_accept_batch  (one transaction)
   respond 202/207/400/409 after commit, 503 if not committed

n8n: LQ v2 - Notification Dispatcher (every minute)
   RPC claim -> Slack chat.postMessage (with metadata) -> classify -> RPC record
   uncertain -> Slack conversations.history -> found / not found -> RPC record
   needs operator -> error -> LQ v2 - Error Handler -> Slack ops + lq_v2.workflow_errors
```

| Deliverable | Location |
|---|---|
| n8n workflow exports (inactive, placeholders) | `workflows/v2/` |
| Database migrations and rollback | `sql/migrations/`, `sql/rollback/` |
| Event and data contract | `docs/v2/event-contract.md` |
| Delivery contract and operator runbook | `docs/v2/delivery-contract.md` |
| Test harness and fixtures | `test/`, `test/fixtures/leads.js` |
| Test results | `docs/v2/test-results.md` |
| Config template (no secrets) | `config/lq-v2.env.example` |
| Deployment and rollback | `docs/v2/deployment.md` |
| Changelog | `docs/v2/CHANGELOG.md` |

Source of truth for workflow logic is `src/`. Edit there, run `npm run build`, and the tests fail if the exports drift. Verification baseline: `docs/research/track-c/lead-qualification-verification.md`.
