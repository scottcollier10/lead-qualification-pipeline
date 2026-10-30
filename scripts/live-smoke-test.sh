#!/usr/bin/env bash
# Post-deploy smoke test against the REAL v2 webhook. Sends synthetic leads and
# causes ONE real Slack message in the v2 channel. Run only after deployment
# and live testing are approved.
#   LQ_V2_LIVE_TEST_APPROVED=yes LQ_V2_WEBHOOK_URL=https://<n8n-host>/webhook/lq-v2-intake \
#   LQ_V2_WEBHOOK_TOKEN=... bash scripts/live-smoke-test.sh
set -euo pipefail
[ "${LQ_V2_LIVE_TEST_APPROVED:-}" = "yes" ] || { echo "Refusing: set LQ_V2_LIVE_TEST_APPROVED=yes once live testing is approved." >&2; exit 1; }
: "${LQ_V2_WEBHOOK_URL:?set LQ_V2_WEBHOOK_URL}"
: "${LQ_V2_WEBHOOK_TOKEN:?set LQ_V2_WEBHOOK_TOKEN}"
case "$LQ_V2_WEBHOOK_URL" in *lq-v2-intake) ;; *) echo "Refusing: URL must end in lq-v2-intake" >&2; exit 1 ;; esac

RUN="smoke$(date +%s)"
post() { curl -s -w ' -> HTTP %{http_code}\n' -X POST "$LQ_V2_WEBHOOK_URL" -H 'content-type: application/json' "$@"; }
auth=(-H "X-LQ-Webhook-Token: $LQ_V2_WEBHOOK_TOKEN")
hot="{\"source_event_id\":\"$RUN-hot\",\"email\":\"hot+$RUN@example.test\",\"first_name\":\"Smoke\",\"company\":\"Smoke Test Co\",\"job_title\":\"CEO\",\"employee_count\":1000,\"deal_size\":100000,\"lead_source\":\"referral\"}"

echo "Run tag: $RUN"
echo "1. new high-fit lead (expect 202 accepted, fit 100, notification pending)"; post "${auth[@]}" -d "$hot"
echo "2. same event again (expect 202 duplicate, same event_id)";               post "${auth[@]}" -d "$hot"
echo "3. returning contact, new event (expect 202 accepted, notification null)"
post "${auth[@]}" -d "{\"source_event_id\":\"$RUN-again\",\"email\":\"hot+$RUN@example.test\",\"job_title\":\"Manager\",\"employee_count\":100,\"deal_size\":10000}"
echo "4. invalid email (expect 400)";  post "${auth[@]}" -d "{\"source_event_id\":\"$RUN-bad\",\"email\":\"nope\"}"
echo "5. no token (expect 403)";        post -d "$hot"
cat <<MSG

Within about a minute, expect exactly ONE message in the v2 Slack channel with Ref lqv2:synthetic:$RUN-hot.
Verify in the Supabase SQL editor:
  select * from lq_v2.event_ledger where source_event_id like '$RUN-%';
  -- expect 2 rows; the hot row: notification_status = sent, resolution = provider_ack, provider_message_ts set; touch_count = 2
Remove the run afterwards (optional):
  select public.lq_v2_purge_synthetic_run('$RUN');
MSG
