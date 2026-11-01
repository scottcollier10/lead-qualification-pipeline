// Regression tests for the PR #1 review fixes (migration 003).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { makePool, rpc, submit, countsForRun, contactByEmail, DB_URL, TEST_CHANNEL } = require('./helpers');
const { lead, PROFILES, newRunTag } = require('../fixtures/leads');
const { prepareIntake } = require('../../src/intake');

const pool = makePool(10);
test.after(() => pool.end());
const ROOT = path.join(__dirname, '../..');

test('fix 1: database rejects occurred_at more than 5 minutes ahead, even if JS validation is bypassed', async () => {
  const run = newRunTag();
  const [ok] = prepareIntake(lead(run, 'ok', PROFILES.fit50), { slackChannelId: TEST_CHANNEL }).events;
  const [future] = prepareIntake(lead(run, 'future', PROFILES.fit50), { slackChannelId: TEST_CHANNEL }).events;
  future.occurred_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const r = await rpc(pool, 'lq_v2_accept_batch', [JSON.stringify([ok, future])]);
  assert.deepEqual(r.results.map((x) => x.outcome), ['accepted', 'rejected']);
  assert.match(r.results[1].errors[0].problem, /more than 5 minutes in the future/);
  assert.equal((await countsForRun(pool, run)).events, 1);

  // Within tolerance (clock skew) is accepted.
  const [skew] = prepareIntake(lead(run, 'skew', PROFILES.fit50), { slackChannelId: TEST_CHANNEL }).events;
  skew.occurred_at = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  assert.equal((await rpc(pool, 'lq_v2_accept_batch', [JSON.stringify([skew])])).results[0].outcome, 'accepted');
});

test('fix 1: a later normal event still updates the contact (no freeze)', async () => {
  const run = newRunTag();
  const email = `freeze+${run}@example.test`;
  await submit(pool, lead(run, 'a', { ...PROFILES.highFit, email, occurred_at: new Date(Date.now() - 60000).toISOString() }));
  const [future] = prepareIntake(lead(run, 'b', { email, company: 'From The Future' }), { slackChannelId: TEST_CHANNEL }).events;
  future.occurred_at = '2099-01-01T00:00:00.000Z';
  await rpc(pool, 'lq_v2_accept_batch', [JSON.stringify([future])]);
  await submit(pool, lead(run, 'c', { email, company: 'Current Employer', occurred_at: new Date().toISOString() }));
  const c = await contactByEmail(pool, email);
  assert.equal(c.company, 'Current Employer');
  assert.ok(new Date(c.last_event_at) < new Date(Date.now() + 5 * 60 * 1000));
});

test('fix 2: malformed Slack target aborts the whole request (503 path), no lead lost or half-written', async () => {
  for (const channel of ['__LQ_V2_SLACK_CHANNEL_ID__', '#leads', 'c0lowercase', '']) {
    const run = newRunTag();
    await assert.rejects(
      submit(pool, [lead(run, 'cold', PROFILES.fit50), lead(run, 'hot', PROFILES.highFit)], { channel }),
      /notification target missing or malformed/,
      `channel ${JSON.stringify(channel)}`
    );
    assert.equal((await countsForRun(pool, run)).events, 0, 'whole batch rolled back, so the sender retry carries both');
    // After the configuration is fixed, the retry is accepted in full.
    const retry = await submit(pool, [lead(run, 'cold', PROFILES.fit50), lead(run, 'hot', PROFILES.highFit)]);
    assert.deepEqual(retry.results.map((x) => x.outcome), ['accepted', 'accepted']);
    assert.equal((await countsForRun(pool, run)).notifications, 1);
  }
});

test('fix 3: claim reports a newly flagged row once; the flag persists without any alert', async () => {
  const run = newRunTag();
  const id = (await submit(pool, lead(run, 'hot', PROFILES.highFit))).results[0].notification.id;
  // Simulate the dispatcher dying during its final allowed reconcile attempt.
  await pool.query(
    `update lq_v2.notifications set status = 'uncertain', reconcile_count = max_reconciles,
       next_reconcile_at = now() - interval '1 second' where id = $1`, [id]);
  const first = await rpc(pool, 'lq_v2_claim_notifications', [50, 120]);
  assert.deepEqual(first.flagged.filter((f) => f.id === id), [{ id, status: 'uncertain' }]);
  // Nothing alerted here (the alert is the workflow's job); the flag is already committed.
  const { rows } = await pool.query('select operator_required from lq_v2.notifications where id = $1', [id]);
  assert.equal(rows[0].operator_required, true);
  const second = await rpc(pool, 'lq_v2_claim_notifications', [50, 120]);
  assert.equal(second.flagged.filter((f) => f.id === id).length, 0, 'no duplicate alert on later runs');
  assert.ok(Array.isArray(second.flagged));
});

test('fix 3: record results report newly_flagged only on the call that set the flag', async () => {
  const run = newRunTag();
  const id = (await submit(pool, lead(run, 'hot', PROFILES.highFit))).results[0].notification.id;
  await pool.query(`update lq_v2.notifications set next_attempt_at = now() + interval '1 hour' where status = 'pending' and id <> $1`, [id]);
  const { claims } = await rpc(pool, 'lq_v2_claim_notifications', [50, 120]);
  const mine = claims.find((c) => c.notification_id === id);
  const fail = await rpc(pool, 'lq_v2_record_send_result', [id, mine.attempt_no, JSON.stringify({ outcome: 'permanent_failure', provider_error: 'channel_not_found' })]);
  assert.equal(fail.newly_flagged, true);
  assert.equal(fail.notification.operator_required, true);
  const stale = await rpc(pool, 'lq_v2_record_send_result', [id, mine.attempt_no, JSON.stringify({ outcome: 'permanent_failure', provider_error: 'again' })]);
  assert.equal(stale.newly_flagged, false, 'a repeat result does not re-alert');
  await pool.query(`update lq_v2.notifications set next_attempt_at = now() where status = 'pending'`);
  // Healthy result: not flagged.
  const run2 = newRunTag();
  const id2 = (await submit(pool, lead(run2, 'hot', PROFILES.highFit))).results[0].notification.id;
  const c2 = (await rpc(pool, 'lq_v2_claim_notifications', [50, 120])).claims.find((c) => c.notification_id === id2);
  const ok = await rpc(pool, 'lq_v2_record_send_result', [id2, c2.attempt_no, JSON.stringify({ outcome: 'sent', message_ts: '3.0', provider_channel: TEST_CHANNEL })]);
  assert.equal(ok.newly_flagged, false);
});

test('rollback: 003_down restores 002 behavior and 003 re-applies cleanly', async () => {
  const dbName = 'lqv2_rollback_' + newRunTag().toLowerCase();
  await pool.query(`create database ${dbName}`);
  const url = DB_URL.replace(/\/[^/]+$/, `/${dbName}`);
  const psql = (file) => execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, file)], { stdio: 'pipe' });
  const q = (sql) => execFileSync('psql', [url, '-qtAc', sql]).toString().trim();
  const claimHasFlagged = () => q("select public.lq_v2_claim_notifications(1, 60) ? 'flagged'");
  try {
    for (const f of ['001_lq_v2_schema.sql', '002_lq_v2_functions.sql', '003_review_fixes.sql']) psql(`sql/migrations/${f}`);
    assert.equal(claimHasFlagged(), 't');
    psql('sql/rollback/003_down.sql');
    assert.equal(claimHasFlagged(), 'f', '002 claim function restored');
    assert.equal(q("select string_agg(version, ',' order by version) from lq_v2.schema_migrations"), '001_lq_v2_schema,002_lq_v2_functions');
    assert.equal(q("select has_function_privilege('anon', 'public.lq_v2_claim_notifications(integer, integer)', 'execute')"), 'f', 'grants intact after rollback');
    psql('sql/migrations/003_review_fixes.sql');
    assert.equal(claimHasFlagged(), 't');
    assert.equal(q("select has_function_privilege('service_role', 'public.lq_v2_claim_notifications(integer, integer)', 'execute')"), 't');
    assert.equal(q("select has_function_privilege('anon', 'public.lq_v2_accept_batch(jsonb)', 'execute')"), 'f');
  } finally {
    await pool.query(`drop database ${dbName} with (force)`);
  }
});
