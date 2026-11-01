// Notification delivery state machine against the real local database.
// The dispatcher loop below mirrors the n8n "LQ v2 Notification Dispatcher"
// workflow (claim -> Slack call -> classify -> record) using the same src/
// classifiers and RPC functions. Slack is an in-process fake with failure
// injection, so these are SIMULATED provider behaviors, not live Slack calls.
// Time is fast-forwarded by editing next_attempt_at / lease_expires_at.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePool, rpc, submit, countsForRun } = require('./helpers');
const { lead, PROFILES, newRunTag } = require('../fixtures/leads');
const { classifySendResponse, findReconciledMessage, METADATA_EVENT_TYPE } = require('../../src/notify');

const pool = makePool(10);
test.after(() => pool.end());

class FakeSlack {
  constructor() {
    this.messages = [];
    this.plan = new Map();
    this.historyDown = false;
    this.seq = 0;
  }
  setPlan(id, behaviors) {
    this.plan.set(id, [...behaviors]);
  }
  post(req) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(++this.seq).padStart(6, '0')}`;
    this.messages.push({ ts, channel: req.channel, text: req.text, metadata: req.metadata });
    return ts;
  }
  postMessage(req) {
    const id = req.metadata.event_payload.notification_id;
    const b = (this.plan.get(id) || []).shift() || 'ok';
    switch (b) {
      case 'ok':
        return { statusCode: 200, body: { ok: true, channel: req.channel, ts: this.post(req) } };
      case 'ratelimited':
        return { statusCode: 429, body: { ok: false, error: 'ratelimited' } };
      case 'refused':
        return { error: { message: 'connect ECONNREFUSED 127.0.0.1:443' } };
      case 'channel_not_found':
        return { statusCode: 200, body: { ok: false, error: 'channel_not_found' } };
      case 'timeout_after_post':
        this.post(req);
        return { error: { message: 'timeout of 10000ms exceeded' } };
      case 'timeout_before_post':
        return { error: { message: 'timeout of 10000ms exceeded' } };
      default:
        throw new Error('unknown behavior ' + b);
    }
  }
  history({ channel, oldest }) {
    if (this.historyDown) return { statusCode: 200, body: { ok: false, error: 'internal_error' } };
    const messages = this.messages.filter((m) => m.channel === channel && Number(m.ts) >= Number(oldest)).reverse();
    return { statusCode: 200, body: { ok: true, messages, has_more: false } };
  }
  count(id) {
    return this.messages.filter((m) => m.metadata.event_payload.notification_id === id).length;
  }
}

// One dispatcher run. skipRecord simulates the receipt write failing after Slack accepted.
async function dispatchOnce(slack, { skipRecord = false } = {}) {
  const { claims } = await rpc(pool, 'lq_v2_claim_notifications', [50, 120]);
  for (const c of claims) {
    if (c.mode === 'send') {
      const resp = slack.postMessage({
        channel: c.channel,
        text: c.text,
        metadata: { event_type: METADATA_EVENT_TYPE, event_payload: { notification_id: c.notification_id, correlation_id: c.correlation_id } }
      });
      if (skipRecord) continue;
      const result = classifySendResponse(resp);
      await rpc(pool, 'lq_v2_record_send_result', [c.notification_id, c.attempt_no, JSON.stringify({ ...result, provider_response: resp.body || { error: resp.error } })]);
    } else {
      const resp = slack.history({ channel: c.channel, oldest: c.oldest });
      const result = findReconciledMessage(resp, c.notification_id);
      await rpc(pool, 'lq_v2_record_reconcile_result', [c.notification_id, c.attempt_no, JSON.stringify(result)]);
    }
  }
  return claims;
}

async function hotLead(run, key = 'hot') {
  const r = (await submit(pool, lead(run, key, PROFILES.highFit))).results[0];
  assert.equal(r.notification.status, 'pending');
  return r.notification.id;
}
async function state(id) {
  const { rows } = await pool.query('select * from lq_v2.notifications where id = $1', [id]);
  return rows[0];
}
async function attempts(id) {
  const { rows } = await pool.query('select kind, attempt_no, outcome from lq_v2.delivery_attempts where notification_id = $1 order by id', [id]);
  return rows.map((r) => `${r.kind}#${r.attempt_no}:${r.outcome}`);
}
const dueNow = (id) => pool.query(`update lq_v2.notifications set next_attempt_at = now(), next_reconcile_at = now() where id = $1`, [id]);
const expireLease = (id) => pool.query(`update lq_v2.notifications set lease_expires_at = now() - interval '1 second' where id = $1 and status = 'sending'`, [id]);

test('drain notifications left by other test files', async () => {
  const slack = new FakeSlack();
  for (let i = 0; i < 20 && (await dispatchOnce(slack)).length; i++);
});

test('D1. success stores receipt and correlation; repeated runs do not resend', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  await dispatchOnce(slack);
  const n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(n.resolution, 'provider_ack');
  assert.equal(n.provider_message_ts, slack.messages.find((m) => m.metadata.event_payload.notification_id === id).ts);
  assert.equal(n.provider_channel, 'CTESTLQV2');
  assert.equal(slack.messages[slack.messages.length - 1].metadata.event_payload.correlation_id, n.correlation_id);
  assert.deepEqual(await attempts(id), ['send#1:sent']);
  const { rows } = await pool.query(`select provider_response from lq_v2.delivery_attempts where notification_id = $1`, [id]);
  assert.equal(rows[0].provider_response.ok, true);
  await dispatchOnce(slack);
  await dispatchOnce(slack);
  assert.equal(slack.count(id), 1);
});

test('D2. Slack fails before delivery: retry with backoff, then one confirmed message, no new lead or score', async () => {
  const slack = new FakeSlack();
  const run = newRunTag();
  const id = await hotLead(run);
  slack.setPlan(id, ['refused', 'ratelimited']);

  await dispatchOnce(slack);
  let n = await state(id);
  assert.equal(n.status, 'pending');
  assert.match(n.last_error, /ECONNREFUSED/);
  assert.ok(new Date(n.next_attempt_at) > new Date(), 'backoff scheduled');
  await dispatchOnce(slack); // too early: backoff respected
  assert.equal((await state(id)).attempt_count, 1);

  await dueNow(id);
  await dispatchOnce(slack);
  n = await state(id);
  assert.equal(n.status, 'pending');
  assert.equal(n.attempt_count, 2);

  await dueNow(id);
  await dispatchOnce(slack);
  n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(slack.count(id), 1);
  assert.deepEqual(await attempts(id), ['send#1:retryable_failure', 'send#2:retryable_failure', 'send#3:sent']);
  assert.deepEqual(await countsForRun(pool, run), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });
});

test('D3. permanent Slack error: failed + operator flag, operator requeue recovers', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, ['channel_not_found']);
  await dispatchOnce(slack);
  let n = await state(id);
  assert.equal(n.status, 'failed');
  assert.equal(n.operator_required, true);
  assert.match(n.last_error, /permanent: channel_not_found/);
  const att = await pool.query('select id from lq_v2.ops_attention where id = $1', [id]);
  assert.equal(att.rows.length, 1);

  await rpc(pool, 'lq_v2_operator_requeue', [id, 'test-operator', 'channel fixed']);
  await dispatchOnce(slack);
  n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(n.operator_required, false);
  assert.equal(slack.count(id), 1);
  const ops = await pool.query('select action, previous_status from lq_v2.operator_actions where notification_id = $1', [id]);
  assert.deepEqual(ops.rows, [{ action: 'requeue', previous_status: 'failed' }]);
});

test('D4. retries are bounded: 5 transient failures end in failed + operator flag', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, Array(5).fill('ratelimited'));
  for (let i = 0; i < 5; i++) {
    await dueNow(id);
    await dispatchOnce(slack);
  }
  const n = await state(id);
  assert.equal(n.status, 'failed');
  assert.equal(n.attempt_count, 5);
  assert.equal(n.operator_required, true);
  assert.match(n.last_error, /retries exhausted/);
  await dueNow(id);
  await dispatchOnce(slack);
  assert.equal((await state(id)).attempt_count, 5, 'no attempts after exhaustion');
});

test('D5. Slack accepted but receipt write failed: marked uncertain, reconciled, never resent', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  await dispatchOnce(slack, { skipRecord: true });
  assert.equal((await state(id)).status, 'sending');
  assert.equal(slack.count(id), 1);

  await dispatchOnce(slack); // lease still held: not reclaimed
  assert.equal(slack.count(id), 1);

  await expireLease(id);
  await dispatchOnce(slack); // sweep -> uncertain -> reconcile finds the message
  const n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(n.resolution, 'reconciled');
  assert.equal(n.provider_message_ts, slack.messages.find((m) => m.metadata.event_payload.notification_id === id).ts);
  assert.equal(slack.count(id), 1);
  assert.deepEqual(await attempts(id), ['send#1:lease_expired', 'reconcile#1:found']);
});

test('D6. timeout after Slack posted: uncertain, reconcile finds it, no resend', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, ['timeout_after_post']);
  await dispatchOnce(slack);
  assert.equal((await state(id)).status, 'uncertain');
  await dispatchOnce(slack); // reconcile waits 60s first
  assert.equal((await state(id)).reconcile_count, 0);
  await dueNow(id);
  await dispatchOnce(slack);
  const n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(n.resolution, 'reconciled');
  assert.equal(slack.count(id), 1);
});

test('D7. timeout before Slack posted: reconcile proves absence, requeue, one message', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, ['timeout_before_post']);
  await dispatchOnce(slack);
  await dueNow(id);
  await dispatchOnce(slack); // reconcile: not_found -> pending
  assert.equal((await state(id)).status, 'pending');
  await dispatchOnce(slack); // resend
  const n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(slack.count(id), 1);
  assert.deepEqual(await attempts(id), ['send#1:uncertain', 'reconcile#1:not_found', 'send#2:sent']);
});

test('D8. reconciliation keeps failing: operator flag, no blind resend; operator requeue recovers', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, ['timeout_before_post']);
  slack.historyDown = true;
  await dispatchOnce(slack);
  for (let i = 0; i < 8; i++) {
    await dueNow(id);
    await dispatchOnce(slack);
  }
  let n = await state(id);
  assert.equal(n.status, 'uncertain');
  assert.equal(n.operator_required, true);
  assert.equal(n.reconcile_count, 6);
  assert.equal(slack.count(id), 0);

  slack.historyDown = false;
  await rpc(pool, 'lq_v2_operator_requeue', [id, 'test-operator', 'checked channel, not present']);
  await dispatchOnce(slack);
  n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(slack.count(id), 1);
});

test('D9. late receipt after lease expiry is still recorded as sent', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.historyDown = true; // keep reconciliation from resolving it first
  await dispatchOnce(slack, { skipRecord: true });
  const ts = slack.messages[slack.messages.length - 1].ts;
  await expireLease(id);
  await dispatchOnce(slack); // sweep -> uncertain, reconcile errors
  assert.equal((await state(id)).status, 'uncertain');
  const r = await rpc(pool, 'lq_v2_record_send_result', [id, 1, JSON.stringify({ outcome: 'sent', message_ts: ts, provider_channel: 'CTESTLQV2' })]);
  assert.equal(r.applied, true);
  const n = await state(id);
  assert.equal(n.status, 'sent');
  assert.equal(n.provider_message_ts, ts);
});

test('D10. stale attempt results are ignored; duplicate receipts are flagged', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, ['refused']);
  await dispatchOnce(slack);
  await dueNow(id);
  const { claims } = await rpc(pool, 'lq_v2_claim_notifications', [50, 120]);
  const mine = claims.find((c) => c.notification_id === id);
  assert.equal(mine.attempt_no, 2);
  const stale = await rpc(pool, 'lq_v2_record_send_result', [id, 1, JSON.stringify({ outcome: 'permanent_failure', provider_error: 'late' })]);
  assert.equal(stale.applied, false);
  assert.equal((await state(id)).status, 'sending');
  await rpc(pool, 'lq_v2_record_send_result', [id, 2, JSON.stringify({ outcome: 'sent', message_ts: '1.000001', provider_channel: 'CTESTLQV2' })]);
  assert.equal((await state(id)).status, 'sent');
  await rpc(pool, 'lq_v2_record_send_result', [id, 2, JSON.stringify({ outcome: 'sent', message_ts: '1.000002', provider_channel: 'CTESTLQV2' })]);
  const n = await state(id);
  assert.equal(n.provider_message_ts, '1.000001');
  assert.equal(n.operator_required, true);
  assert.match(n.last_error, /duplicate delivery detected/);
  for (const c of claims.filter((c) => c.notification_id !== id && c.mode === 'send')) {
    await rpc(pool, 'lq_v2_record_send_result', [c.notification_id, c.attempt_no, JSON.stringify({ outcome: 'sent', message_ts: '9.0', provider_channel: 'CTESTLQV2' })]);
  }
});

test('D11. overlapping dispatcher runs never claim the same notification', async () => {
  const run = newRunTag();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await hotLead(run, `hot${i}`));
  const [a, b] = await Promise.all([
    rpc(pool, 'lq_v2_claim_notifications', [3, 120]),
    rpc(pool, 'lq_v2_claim_notifications', [3, 120])
  ]);
  const claimed = [...a.claims, ...b.claims].filter((c) => c.mode === 'send').map((c) => c.notification_id);
  assert.equal(new Set(claimed).size, claimed.length);
  for (const c of [...a.claims, ...b.claims].filter((c) => c.mode === 'send')) {
    await rpc(pool, 'lq_v2_record_send_result', [c.notification_id, c.attempt_no, JSON.stringify({ outcome: 'sent', message_ts: '2.0', provider_channel: 'CTESTLQV2' })]);
  }
  const slack = new FakeSlack();
  await dispatchOnce(slack);
  for (const id of ids) assert.equal((await state(id)).status, 'sent');
});

test('D12. invalid results are refused by the database', async () => {
  const id = await hotLead(newRunTag());
  await assert.rejects(rpc(pool, 'lq_v2_record_send_result', [id, 1, JSON.stringify({ outcome: 'sent' })]), /requires message_ts/);
  await assert.rejects(rpc(pool, 'lq_v2_record_send_result', [id, 1, JSON.stringify({ outcome: 'maybe' })]), /invalid outcome/);
  await assert.rejects(pool.query(`update lq_v2.notifications set status = 'sent' where id = $1`, [id]), /notifications_sent_has_receipt/);
});

test('D13. stale reconcile finding a different message for a sent notification is flagged', async () => {
  const slack = new FakeSlack();
  const id = await hotLead(newRunTag());
  slack.setPlan(id, ['timeout_after_post']);
  await dispatchOnce(slack);
  await dueNow(id);
  const { claims } = await rpc(pool, 'lq_v2_claim_notifications', [50, 120]);
  const rec = claims.find((c) => c.notification_id === id);
  assert.equal(rec.mode, 'reconcile');
  // Meanwhile an operator resolves it with a different ts.
  await rpc(pool, 'lq_v2_operator_mark_sent', [id, 'test-operator', '7.000001', 'seen']);
  const r = await rpc(pool, 'lq_v2_record_reconcile_result', [id, rec.attempt_no, JSON.stringify({ outcome: 'found', message_ts: '7.000002' })]);
  assert.equal(r.notification.status, 'sent');
  assert.equal(r.notification.operator_required, true);
  assert.match((await state(id)).last_error, /duplicate delivery detected: reconcile/);
  for (const c of claims.filter((c) => c.notification_id !== id && c.mode === 'send')) {
    await rpc(pool, 'lq_v2_record_send_result', [c.notification_id, c.attempt_no, JSON.stringify({ outcome: 'sent', message_ts: '9.0', provider_channel: 'CTESTLQV2' })]);
  }
});
