#!/usr/bin/env bash
# Local-only end-to-end stack: Supabase Postgres image + PostgREST + n8n 2.14.2
# in Docker, plus test/e2e/fake-cloud.js on the host (Supabase-path proxy and
# fake Slack). Imports and activates the v2 workflows in the THROWAWAY local
# n8n only. Never contacts Render, Supabase cloud or Slack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/test/e2e/.work"
N8N_IMAGE=${LQ_V2_E2E_N8N_IMAGE:-n8nio/n8n:2.14.2}
PGRST_IMAGE=public.ecr.aws/supabase/postgrest:v14.1
JWT_SECRET=local-e2e-jwt-secret-at-least-32-characters-long
NET=lqv2-e2e
mkdir -p "$WORK/workflows"

if ! docker ps --format '{{.Names}}' | grep -q '^lqv2-local-db$'; then
  bash "$ROOT/scripts/local-db.sh" up
fi
docker exec lqv2-local-db psql -U supabase_admin -d postgres -qtAc "alter role authenticator with login password 'postgres'" >/dev/null

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
docker network connect "$NET" lqv2-local-db 2>/dev/null || true

docker rm -f lqv2-postgrest lqv2-n8n >/dev/null 2>&1 || true
docker run -d --name lqv2-postgrest --network "$NET" -p 54401:3000 \
  -e PGRST_DB_URI=postgres://authenticator:postgres@lqv2-local-db:5432/postgres \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  "$PGRST_IMAGE" >/dev/null

SERVICE_JWT=$(node -e '
const c=require("crypto");const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url");
const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"service_role",iss:"lqv2-local",exp:Math.floor(Date.now()/1000)+86400});
const s=c.createHmac("sha256",process.argv[1]).update(h+"."+p).digest("base64url");console.log(h+"."+p+"."+s)' "$JWT_SECRET")

cat > "$WORK/credentials.json" <<JSON
[
  {"id":"lqv2LocalSupa01","name":"LQ v2 Supabase Service Role (local e2e)","type":"httpMultipleHeadersAuth",
   "data":{"headers":{"values":[{"name":"apikey","value":"$SERVICE_JWT"},{"name":"Authorization","value":"Bearer $SERVICE_JWT"}]}}},
  {"id":"lqv2LocalSlack1","name":"LQ v2 Slack Bot (local e2e)","type":"httpHeaderAuth",
   "data":{"name":"Authorization","value":"Bearer xoxb-local-test"}},
  {"id":"lqv2LocalHook01","name":"LQ v2 Intake Webhook Token (local e2e)","type":"httpHeaderAuth",
   "data":{"name":"X-LQ-Webhook-Token","value":"local-e2e-token"}}
]
JSON

cat > "$WORK/e2e.env" <<ENV
LQ_V2_SUPABASE_URL=http://host.docker.internal:54400
LQ_V2_SLACK_API_BASE=http://host.docker.internal:54400/api
LQ_V2_SLACK_CHANNEL_ID=CE2ELEADS
LQ_V2_SLACK_OPS_CHANNEL_ID=CE2EOPS
LQ_V2_CRED_SUPABASE_ID=lqv2LocalSupa01
LQ_V2_CRED_SUPABASE_NAME=LQ v2 Supabase Service Role (local e2e)
LQ_V2_CRED_SLACK_ID=lqv2LocalSlack1
LQ_V2_CRED_SLACK_NAME=LQ v2 Slack Bot (local e2e)
LQ_V2_CRED_WEBHOOK_ID=lqv2LocalHook01
LQ_V2_CRED_WEBHOOK_NAME=LQ v2 Intake Webhook Token (local e2e)
LQ_V2_ERROR_WORKFLOW_ID=lqv2ErrHandler01
LQ_V2_TEST_DISPATCH_SECONDS=5
ENV

node "$ROOT/scripts/build-workflows.js" --env-file "$WORK/e2e.env" --out "$WORK/workflows" >/dev/null
# Fixed IDs so the error-workflow reference resolves after import.
node -e '
const fs=require("fs"),d=process.argv[1];
const ids={"lq-v2-intake.json":"lqv2Intake000001","lq-v2-notification-dispatcher.json":"lqv2Dispatch0001","lq-v2-error-handler.json":"lqv2ErrHandler01"};
for (const [f,id] of Object.entries(ids)) { const w=JSON.parse(fs.readFileSync(d+"/"+f)); w.id=id; fs.writeFileSync(d+"/"+f, JSON.stringify(w)); }' "$WORK/workflows"

docker run -d --name lqv2-n8n --network "$NET" -p 55678:5678 \
  --add-host host.docker.internal:host-gateway \
  -e N8N_ENCRYPTION_KEY=local-e2e-encryption-key -e N8N_DIAGNOSTICS_ENABLED=false \
  -e N8N_PERSONALIZATION_ENABLED=false -e N8N_SECURE_COOKIE=false -e GENERIC_TIMEZONE=UTC \
  "$N8N_IMAGE" >/dev/null

wait_up() { for i in $(seq 1 90); do curl -sf http://localhost:55678/healthz >/dev/null && return 0; sleep 1; done; echo "n8n did not start"; docker logs --tail 50 lqv2-n8n; exit 1; }
wait_up
docker cp "$WORK/credentials.json" lqv2-n8n:/tmp/credentials.json
docker cp "$WORK/workflows" lqv2-n8n:/tmp/lqv2-workflows
docker exec lqv2-n8n n8n import:credentials --input=/tmp/credentials.json
docker exec lqv2-n8n n8n import:workflow --separate --input=/tmp/lqv2-workflows
for id in lqv2Intake000001 lqv2Dispatch0001 lqv2ErrHandler01; do
  docker exec lqv2-n8n n8n publish:workflow --id="$id" 2>/dev/null || docker exec lqv2-n8n n8n update:workflow --id="$id" --active=true
done
docker restart lqv2-n8n >/dev/null
wait_up
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:55678/webhook/lq-v2-intake -H 'content-type: application/json' -d '{}')
  [ "$code" != "404" ] && break; sleep 1
done
echo "e2e stack ready (webhook unauthenticated probe -> HTTP $code)"
