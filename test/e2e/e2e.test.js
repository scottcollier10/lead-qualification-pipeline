// End-to-end against the LOCAL stack from test/e2e/setup.sh: real n8n 2.14.2
// running the built v2 workflows, real PostgREST + Postgres, fake Slack.
// Run: node test/e2e/fake-cloud.js &  bash test/e2e/setup.sh  &&  npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { lead, PROFILES, newRunTag } = require('../fixtures/leads');

const WEBHOOK = 'http://localhost:55678/webhook/lq-v2-intake';
const CLOUD = 'http://localhost:54400';
const TOKEN = 'local-e2e-token';
const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:54329/postgres', max: 5 });
test.after(() => pool.end());

async function post(body, { token = TOKEN, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['X-LQ-Webhook-Token'] = token;
  const r = await fetch(WEBHOOK, { method: 'POST', headers, body: raw !== undefined ? raw : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: r.status, json, text };
}
const ctl = (obj) => fetch(`${CLOUD}/_control/set`, { method: 'POST', body: JSON.stringify(obj) });
const cloud = async () => (await fetch(`${CLOUD}/_control/state`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 45000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(1000);
  }
  throw new Error('timed out waiting; last value: ' + JSON.stringify(last));
}
async function notif(correlation) {
  const { rows } = await pool.query('select * from lq_v2.notifications where correlation_id = $1', [correlation]);
  return rows[0];
}
async function eventCount(run) {
  const { rows } = await pool.query('select count(*)::int as n from lq_v2.source_events where source_event_id like $1', [`${run}-%`]);
  return rows[0].n;
}
const slackCount = (s, id) => s.messages.filter((m) => m.metadata && m.metadata.event_payload.notification_id === id).length;
const sendStatus = (id) => async () => { const n = await notif(id); return n && n.status === 'sent' ? n : null; };

test.before(async () => {
  await fetch(`${CLOUD}/_control/reset`, { method: 'POST' });
  // Let the dispatcher drain anything left by earlier local runs.
  await waitFor(async () => {
    const { rows } = await pool.query(`select count(*)::int as n from lq_v2.notifications where status in ('pending','sending')`);
    return rows[0].n === 0;
  }, 60000).catch(() => {});
});

test('E1. missing or wrong webhook token: rejected by n8n, no writes', async () => {
  const run = newRunTag();
  const none = await post(lead(run, 'a', PROFILES.highFit), { token: null });
  const wrong = await post(lead(run, 'b', PROFILES.highFit), { token: 'nope' });
  assert.ok([401, 403].includes(none.status), String(none.status));
  assert.ok([401, 403].includes(wrong.status), String(wrong.status));
  await sleep(1000);
  assert.equal(await eventCount(run), 0);
});

test('E2. invalid input: 400 with per-field errors, no writes', async () => {
  const run = newRunTag();
  const r = await post({ source_event_id: `${run}-bad`, email: 'nope', employee_count: 'lots' });
  assert.equal(r.status, 400);
  assert.equal(r.json.results[0].outcome, 'invalid');
  assert.deepEqual(r.json.results[0].errors.map((e) => e.field).sort(), ['email', 'employee_count']);
  const malformed = await post(null, { raw: '{"source_event_id": ' });
  assert.ok(malformed.status >= 400 && malformed.status < 600, `malformed JSON -> ${malformed.status}`);
  assert.notEqual(malformed.status, 202);
  assert.equal(await eventCount(run), 0);
});

test('E3. new high-fit lead: 202 after commit, one Slack message with receipt stored', async () => {
  const run = newRunTag();
  const r = await post(lead(run, 'highFit', PROFILES.highFit));
  assert.equal(r.status, 202);
  const res = r.json.results[0];
  assert.equal(res.outcome, 'accepted');
  assert.equal(res.score.fit, 100);
  assert.equal(res.score.urgency, 65);
  const n = await waitFor(sendStatus(res.notification.correlation_id));
  const s = await cloud();
  assert.equal(slackCount(s, n.id), 1);
  const msg = s.messages.find((m) => m.metadata && m.metadata.event_payload.notification_id === n.id);
  assert.equal(n.provider_message_ts, msg.ts);
  assert.equal(msg.channel, 'CE2ELEADS');
  assert.match(msg.text, /HIGH PRIORITY LEAD - CALL NOW/);
  assert.equal(n.resolution, 'provider_ack');
});

test('E4. retransmitted event (sequential and concurrent): one outcome, one message', async () => {
  const run = newRunTag();
  const ev = lead(run, 'highFit', PROFILES.highFit);
  const first = await post(ev);
  const again = await Promise.all(Array.from({ length: 8 }, () => post(ev)));
  assert.equal(first.json.results[0].outcome, 'accepted');
  for (const a of again) {
    assert.equal(a.status, 202);
    assert.equal(a.json.results[0].outcome, 'duplicate');
    assert.equal(a.json.results[0].event_id, first.json.results[0].event_id);
  }
  const n = await waitFor(sendStatus(first.json.results[0].notification.correlation_id));
  await sleep(6000); // another dispatcher cycle
  assert.equal(slackCount(await cloud(), n.id), 1);
  assert.equal(await eventCount(run), 1);
  const { rows } = await pool.query('select touch_count from lq_v2.contacts where email_normalized = $1', [ev.email.toLowerCase()]);
  assert.equal(rows[0].touch_count, 1);
});

test('E5. batch with boundaries and one invalid event: 207 with per-event outcomes', async () => {
  const run = newRunTag();
  const r = await post([
    lead(run, 'fit49', PROFILES.fit49), lead(run, 'fit50', PROFILES.fit50), lead(run, 'fit79', PROFILES.fit79),
    lead(run, 'fit80', PROFILES.fit80), { source_event_id: `${run}-bad`, email: 5 }
  ]);
  assert.equal(r.status, 207);
  assert.deepEqual(r.json.results.map((x) => [x.index, x.outcome, x.score && x.score.route]), [
    [0, 'accepted', 'manual_review'], [1, 'accepted', 'nurture'], [2, 'accepted', 'nurture'], [3, 'accepted', 'call_now'], [4, 'invalid', undefined]
  ]);
});

test('E6. returning lead with a genuinely new event: same contact, new score, no new notification', async () => {
  const run = newRunTag();
  const email = `ret+${run}@example.test`;
  const a = (await post(lead(run, 'one', { ...PROFILES.highFit, email }))).json.results[0];
  const b = (await post(lead(run, 'two', { ...PROFILES.fit50, email, occurred_at: '2026-10-31T00:00:00Z' }))).json.results[0];
  assert.equal(b.outcome, 'accepted');
  assert.equal(b.contact_id, a.contact_id);
  assert.equal(b.is_new_contact, false);
  assert.equal(b.notification, null);
  assert.equal(b.score.fit, 50);
});

test('E7. database unavailable: 503, nothing written; retry after recovery accepted once', async () => {
  const run = newRunTag();
  const ev = lead(run, 'hot', PROFILES.highFit);
  await ctl({ dbDown: true });
  let r;
  try {
    r = await post(ev);
  } finally {
    await ctl({ dbDown: false });
  }
  assert.equal(r.status, 503);
  assert.deepEqual(r.json, { status: 503, error: 'not_accepted', retry: true });
  assert.equal(await eventCount(run), 0);
  const r2 = await post(ev);
  assert.equal(r2.status, 202);
  assert.equal(r2.json.results[0].outcome, 'accepted');
  await waitFor(sendStatus(r2.json.results[0].notification.correlation_id));
});

test('E8. Slack rate-limited, then recovers: retried from persisted intent, one message', async () => {
  const run = newRunTag();
  await ctl({ plan: ['ratelimited'] });
  const res = (await post(lead(run, 'hot', PROFILES.highFit))).json.results[0];
  const cid = res.notification.correlation_id;
  await waitFor(async () => { const n = await notif(cid); return n.attempt_count === 1 && n.status === 'pending' ? n : null; });
  await pool.query('update lq_v2.notifications set next_attempt_at = now() where correlation_id = $1', [cid]); // skip 30s backoff
  const n = await waitFor(sendStatus(cid));
  assert.equal(n.attempt_count, 2);
  assert.equal(slackCount(await cloud(), n.id), 1);
  assert.equal(await eventCount(run), 1);
});

test('E9. Slack accepted, receipt write failed: error alert raised, later reconciled without resend', async () => {
  const run = newRunTag();
  const before = await cloud();
  const opsBefore = before.messages.filter((m) => m.channel === 'CE2EOPS').length;
  const { rows: errBefore } = await pool.query('select count(*)::int as n from lq_v2.workflow_errors');
  await ctl({ failRecordSend: true });
  const res = (await post(lead(run, 'hot', PROFILES.highFit))).json.results[0];
  const cid = res.notification.correlation_id;
  const id = res.notification.id;
  try {
    await waitFor(async () => slackCount(await cloud(), id) === 1);
    await waitFor(async () => (await notif(cid)).status === 'sending');
    await sleep(3000);
  } finally {
    await ctl({ failRecordSend: false });
  }
  // Error workflow: ops alert in Slack and a row in lq_v2.workflow_errors.
  await waitFor(async () => (await cloud()).messages.filter((m) => m.channel === 'CE2EOPS').length > opsBefore);
  await waitFor(async () => (await pool.query('select count(*)::int as n from lq_v2.workflow_errors')).rows[0].n > errBefore[0].n);
  const { rows: errs } = await pool.query('select last_node, workflow_name from lq_v2.workflow_errors order by id desc limit 1');
  assert.equal(errs[0].last_node, 'Record Send Result (RPC)');
  assert.equal(errs[0].workflow_name, 'LQ v2 - Notification Dispatcher');

  await pool.query(`update lq_v2.notifications set lease_expires_at = now() - interval '1 second' where correlation_id = $1`, [cid]); // skip 120s lease
  const n = await waitFor(sendStatus(cid));
  assert.equal(n.resolution, 'reconciled');
  assert.equal(slackCount(await cloud(), id), 1);
});

test('E10. Slack timeout before posting: run fails and alerts, lease expiry -> uncertain, reconciled as absent, resent once', async () => {
  const run = newRunTag();
  const { rows: errBefore } = await pool.query('select coalesce(max(id), 0)::int as id from lq_v2.workflow_errors');
  await ctl({ plan: ['hang_before_post'] });
  const res = (await post(lead(run, 'hot', PROFILES.highFit))).json.results[0];
  const cid = res.notification.correlation_id;
  // No response from Slack: the dispatcher run fails and the error workflow alerts.
  const err = await waitFor(async () => {
    const { rows } = await pool.query('select * from lq_v2.workflow_errors where id > $1 and last_node = $2', [errBefore[0].id, 'Slack chat.postMessage']);
    return rows[0];
  }, 60000);
  assert.equal(err.workflow_name, 'LQ v2 - Notification Dispatcher');
  assert.equal((await notif(cid)).status, 'sending');
  await pool.query(`update lq_v2.notifications set lease_expires_at = now() - interval '1 second' where correlation_id = $1`, [cid]); // skip 120s lease
  const n = await waitFor(sendStatus(cid), 60000);
  assert.equal(n.resolution, 'provider_ack');
  assert.equal(slackCount(await cloud(), res.notification.id), 1);
  const { rows } = await pool.query(
    `select kind || '#' || attempt_no || ':' || outcome as a from lq_v2.delivery_attempts where notification_id = $1 order by id`, [n.id]);
  assert.deepEqual(rows.map((r) => r.a), ['send#1:lease_expired', 'reconcile#1:not_found', 'send#2:sent']);
});

test('E11. Slack 500 after posting: uncertain, reconciled as delivered, never resent', async () => {
  const run = newRunTag();
  await ctl({ plan: ['http500_after_post'] });
  const res = (await post(lead(run, 'hot', PROFILES.highFit))).json.results[0];
  const cid = res.notification.correlation_id;
  await waitFor(async () => (await notif(cid)).status === 'uncertain');
  await pool.query('update lq_v2.notifications set next_reconcile_at = now() where correlation_id = $1', [cid]);
  const n = await waitFor(sendStatus(cid));
  assert.equal(n.resolution, 'reconciled');
  assert.equal(slackCount(await cloud(), res.notification.id), 1);
});

test('E12. permanent Slack error: failed, flagged, and ops alerted', async () => {
  const run = newRunTag();
  const { rows: errBefore } = await pool.query('select coalesce(max(id), 0)::int as id from lq_v2.workflow_errors');
  await ctl({ plan: ['channel_not_found'] });
  const res = (await post(lead(run, 'hot', PROFILES.highFit))).json.results[0];
  const n = await waitFor(async () => { const x = await notif(res.notification.correlation_id); return x.status === 'failed' ? x : null; });
  assert.equal(n.operator_required, true);
  assert.match(n.last_error, /channel_not_found/);
  const err = await waitFor(async () => {
    const { rows } = await pool.query('select * from lq_v2.workflow_errors where id > $1 and last_node = $2', [errBefore[0].id, 'Raise Operator Alert']);
    return rows[0];
  });
  assert.ok(err.error_message.includes(n.id));
  await waitFor(async () => (await cloud()).messages.some((m) => m.channel === 'CE2EOPS' && m.text.includes(n.id)));
});
