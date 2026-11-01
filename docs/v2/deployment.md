# LQ v2 Deployment and Rollback

v2 runs beside v1 without touching it. It has its own database project, webhook path, n8n credentials, workflows and Slack channel. Rolling back means turning v2 off. Nothing in v1 needs restoring, because nothing in v1 was changed.

**Nothing in this document has been executed against cloud resources.** Each step marked **[approval]** needs your explicit go-ahead.

## Isolation: what keeps v2 separate

Different webhook paths alone do not make resources isolated. These are the actual boundaries:

| Resource | v2 boundary | Enforced by |
|---|---|---|
| Database | New dedicated Supabase project, schema `lq_v2` | Migration 001 refuses to install if `public.leads/scores/actions/nurture_queue` exist. The build refuses the v1 project URL. |
| Database access | Only `public.lq_v2_*` functions, `service_role` only | Grants and RLS in the migrations (tested) |
| n8n workflows | `LQ v2 - Intake`, `LQ v2 - Notification Dispatcher`, `LQ v2 - Error Handler`. Exported inactive. | Tests assert `active: false` and no v1 references |
| Webhook | `/webhook/lq-v2-intake`, header token required | Webhook Header Auth (tested on local n8n 2.14.2 and 2.38.7) |
| Credentials | Three new credentials. None of the v1 credential IDs. | Tests reject known v1 credential IDs in exports |
| Slack | New channel. Ideally a new bot token. | Channel ID set at build time. Reusing an existing bot token isolates the channel, not the token. |
| n8n instance | **Shared** with the 46 active workflows | Not isolated. v2 adds one schedule per minute and low webhook volume. |

## Before deployment: decisions and approvals

1. **n8n version: 2.38.7 (confirmed).** The full local e2e suite passes on `n8nio/n8n:2.38.7`. For a future upgrade, rerun it with `LQ_V2_E2E_N8N_IMAGE=n8nio/n8n:<version>` first.
2. **[approval]** Create a dedicated Supabase project for v2.
3. **[approval]** Create a Slack channel for v2, and a bot token with `chat:write` plus `channels:history` (public channel) or `groups:history` (private channel). Invite the bot to the channel.
4. **[approval]** Create three credentials on the n8n instance.
5. **[approval]** Import the three workflows (they stay inactive).
6. **[approval]** Activate them and run the live smoke test. This posts one real Slack message.

## Steps

### 1. Database [approval]

```bash
export LQ_V2_DATABASE_URL='postgresql://...'   # new project, session pooler string; keep in shell only
psql "$LQ_V2_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/migrations/001_lq_v2_schema.sql
psql "$LQ_V2_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/migrations/002_lq_v2_functions.sql
psql "$LQ_V2_DATABASE_URL" -c 'select * from lq_v2.schema_migrations'
```

Each file runs as one transaction. Pasting them into the Supabase SQL editor works too. The files are not re-runnable: a second run fails instead of silently skipping. Future changes go in new numbered files.

Then, for v2.0.1 or later:

```bash
psql "$LQ_V2_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/migrations/003_review_fixes.sql
```

003 replaces four functions in place (same signatures, grants kept). Rollback: `sql/rollback/003_down.sql` restores the 002 versions; data is untouched. Tested as a round trip (apply, roll back, re-apply).

### 2. Slack [approval]

Create the channel, install the bot, invite it to the channel, and note the channel ID.

### 3. n8n credentials [approval]

| Name (suggested)            | Type                  | Content                                                                                                                                                           |
| --------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LQ v2 Supabase Service Role | Multiple Headers Auth | One header: `apikey` = the new project's secret key (`sb_secret_...`). Do **not** add `Authorization`: a non-JWT there fails with `401 PGRST301 Expected 3 parts in JWT`. Only with a legacy `service_role` JWT may you also send `Authorization: Bearer <jwt>`. |
| LQ v2 Slack Bot             | Header Auth           | `Authorization` = `Bearer xoxb-...`                                                                                                                               |
| LQ v2 Intake Webhook Token  | Header Auth           | `X-LQ-Webhook-Token` = a long random value. Share it only with the sender.                                                                                        |

Record each credential's ID. On this instance, import binds credentials only by exact ID (my notes, 2026-03-30). The method that has worked is reading `id, name, type` from the `credentials_entity` table of the n8n database.

### 4. Build deployable exports

```bash
cp config/lq-v2.env.example .env.lq-v2.local    # gitignored; holds IDs, not secrets
# fill in URL, channel ID, credential IDs and names
node scripts/build-workflows.js --env-file .env.lq-v2.local --out dist
```

`dist/` is gitignored. The build fails on missing values, placeholders, the v1 database URL or malformed channel IDs.

### 5. Import or update [approval]

**Updating through the n8n-workflow-builder MCP (the path used on Render).** Its `update_workflow` keeps nodes, parameters, credentials and connections, and republishes an active workflow. It silently drops per-node `onError` and cannot set workflow settings. The workflows are built not to depend on `onError` (a test enforces this). Set these two settings by hand in each workflow's Settings:

| Workflow | Error workflow | Save successful production executions |
|---|---|---|
| LQ v2 - Intake | LQ v2 - Error Handler | default |
| LQ v2 - Notification Dispatcher | LQ v2 - Error Handler | Do not save |

**Importing files:**

1. Import `dist/lq-v2-error-handler.json`. Note its workflow ID (it appears in the editor URL, `/workflow/<id>`).
2. Set `LQ_V2_ERROR_WORKFLOW_ID` in `.env.lq-v2.local`, rebuild, then import `dist/lq-v2-intake.json` and `dist/lq-v2-notification-dispatcher.json`.
3. Open each HTTP node and the webhook node and confirm a credential is shown. If one is empty, its ID in the env file is wrong. Fix it and re-import. Don't hand-edit nodes, because the committed exports would drift.

The other proven path on this instance is creating workflows through the `n8n-workflow-builder` MCP, which avoids the import binding bug. It needs the same approval.

### 6. Activate [approval]

Activate the Dispatcher first, then the Intake. In the local test all three workflows were published. n8n's documentation says an error workflow does not need to be active, so activating it is harmless either way.

### 7. Live smoke test [approval]

```bash
LQ_V2_LIVE_TEST_APPROVED=yes \
LQ_V2_WEBHOOK_URL=https://<n8n-host>/webhook/lq-v2-intake \
LQ_V2_WEBHOOK_TOKEN=<token> \
bash scripts/live-smoke-test.sh
```

Expected results are printed by the script. These checks confirm the items the local run could not prove (see test-results.md, "Unverified until live").

## Environment notes

- **Render instance type:** only Render's Free instance type spins down after inactivity. On a paid instance type the dispatcher runs every minute without interruption. If the service were ever moved to Free, notifications would be delayed (not lost) while it sleeps, and the first webhook after waking would be slow; sender retries are safe either way.
- **n8n's own SQLite can be wiped** on this host (ephemeral disk). Business state now lives in Supabase, so a wipe loses workflow definitions and credentials, not leads or delivery state. Re-import and pending work drains.
- The Dispatcher keeps only failed executions in n8n (setting applied 2026-11-01), to avoid 1,440 saved runs a day. Delivery history is in `lq_v2.delivery_attempts`.

## Rollback

v1 is untouched, so every rollback step only removes v2.

| Goal | Action |
|---|---|
| Stop intake now | Deactivate `LQ v2 - Intake`. The webhook stops answering. Nothing new is accepted. |
| Stop Slack messages now | Deactivate `LQ v2 - Notification Dispatcher`. Rows wait in `pending` and drain if it is reactivated. |
| Remove v2 from n8n | Delete the three v2 workflows and three v2 credentials. |
| Keep v2 data, then remove the schema | `pg_dump "$LQ_V2_DATABASE_URL" --schema=lq_v2 > lq_v2_backup.sql` then `psql "$LQ_V2_DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/rollback/down_lq_v2.sql` |
| Remove everything | Delete the dedicated Supabase project. Archive the v2 Slack channel and revoke the v2 bot token. |

`down_lq_v2.sql` drops only `lq_v2` and the `public.lq_v2_*` functions. To redeploy after a schema rollback, run migrations 001 and 002 again.
