// Event acceptance against a real local Postgres (Supabase image) running the
// v2 migrations. Verifies idempotency, concurrency, returning-contact handling,
// routing persistence, invalid input and crash boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { makePool, rpc, submit, countsForRun, contactByEmail, DB_URL, TEST_CHANNEL } = require('./helpers');
const { lead, PROFILES, EXPECTED, newRunTag } = require('../fixtures/leads');
const { prepareIntake } = require('../../src/intake');

const pool = makePool(25);
test.after(() => pool.end());

test('1. new high-fit lead: one contact, event, score, work item and pending notification', async () => {
  const run = newRunTag();
  const ev = lead(run, 'highFit', PROFILES.highFit);
  const { results } = await submit(pool, ev);
  assert.equal(results.length, 1);
  const r = results[0];
  assert.equal(r.outcome, 'accepted');
  assert.equal(r.is_new_contact, true);
  assert.equal(r.score.fit, 100);
  assert.equal(r.score.urgency, 65);
  assert.equal(r.score.route, 'call_now');
  assert.equal(r.score.score_version, 'rule-based-v1');
  assert.equal(r.work_item.kind, 'call_now');
  assert.equal(r.notification.status, 'pending');
  assert.equal(r.notification.correlation_id, `lqv2:synthetic:${run}-highFit`);
  assert.deepEqual(await countsForRun(pool, run), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });

  const { rows } = await pool.query('select scoring_input, breakdown from lq_v2.scores where id = $1', [r.score.id]);
  assert.deepEqual(rows[0].scoring_input, prepareIntake(ev, { slackChannelId: TEST_CHANNEL }).events[0].scoring_input);
  const n = await pool.query('select target, message_text from lq_v2.notifications where id = $1', [r.notification.id]);
  assert.equal(n.rows[0].target, TEST_CHANNEL);
  assert.match(n.rows[0].message_text, /Fit Score:\* 100\/100/);
});

test('2. repeated source event: same outcome, no new writes, touch count unchanged', async () => {
  const run = newRunTag();
  const ev = lead(run, 'highFit', PROFILES.highFit);
  const first = (await submit(pool, ev)).results[0];
  const second = (await submit(pool, ev)).results[0];
  const third = (await submit(pool, JSON.parse(JSON.stringify(ev)))).results[0];
  assert.equal(second.outcome, 'duplicate');
  assert.equal(third.outcome, 'duplicate');
  assert.equal(second.event_id, first.event_id);
  assert.equal(second.notification.id, first.notification.id);
  assert.equal(second.score.id, first.score.id);
  assert.deepEqual(await countsForRun(pool, run), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });
  assert.equal((await contactByEmail(pool, ev.email)).touch_count, 1);
});

test('2b. same event id with a different payload is a conflict and writes nothing', async () => {
  const run = newRunTag();
  const ev = lead(run, 'highFit', PROFILES.highFit);
  await submit(pool, ev);
  const r = (await submit(pool, { ...ev, company: 'Changed Inc' })).results[0];
  assert.equal(r.outcome, 'conflict');
  assert.deepEqual(await countsForRun(pool, run), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });
});

test('2c. same event twice inside one batch is processed once', async () => {
  const run = newRunTag();
  const ev = lead(run, 'fit50', PROFILES.fit50);
  const { results } = await submit(pool, [ev, ev]);
  assert.deepEqual(results.map((r) => r.outcome), ['accepted', 'duplicate']);
  assert.deepEqual(results.map((r) => r.index), [0, 1]);
  assert.equal((await countsForRun(pool, run)).events, 1);
});

test('3. concurrent duplicate events: exactly one accepted', async () => {
  const run = newRunTag();
  const ev = lead(run, 'highFit', PROFILES.highFit);
  const all = await Promise.all(Array.from({ length: 12 }, () => submit(pool, ev)));
  const outcomes = all.map((x) => x.results[0].outcome);
  assert.equal(outcomes.filter((o) => o === 'accepted').length, 1, outcomes.join());
  assert.equal(outcomes.filter((o) => o === 'duplicate').length, 11);
  assert.equal(new Set(all.map((x) => x.results[0].event_id)).size, 1);
  assert.deepEqual(await countsForRun(pool, run), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });
  assert.equal((await contactByEmail(pool, ev.email)).touch_count, 1);
});

test('4. simultaneous genuine engagements for one contact: no lost updates, one initial outreach', async () => {
  const run = newRunTag();
  const email = `same+${run}@example.test`;
  const evs = Array.from({ length: 10 }, (_, i) => lead(run, `eng${i}`, { ...PROFILES.highFit, email }));
  const all = await Promise.all(evs.map((ev) => submit(pool, ev)));
  const rs = all.map((x) => x.results[0]);
  assert.ok(rs.every((r) => r.outcome === 'accepted'));
  assert.equal(new Set(rs.map((r) => r.contact_id)).size, 1);
  assert.equal(rs.filter((r) => r.is_new_contact).length, 1);
  assert.deepEqual(await countsForRun(pool, run), { events: 10, contacts: 1, scores: 10, work_items: 1, notifications: 1 });
  assert.equal((await contactByEmail(pool, email)).touch_count, 10);
});

test('5. returning lead with a new event: same contact, new score, fresh input, no new outreach', async () => {
  const run = newRunTag();
  const email = `returning+${run}@example.test`;
  const first = (await submit(pool, lead(run, 'first', { ...PROFILES.highFit, email, occurred_at: '2026-10-01T00:00:00Z' }))).results[0];
  const second = (await submit(pool, lead(run, 'second', { ...PROFILES.fit49, email, company: 'New Employer', occurred_at: '2026-10-02T00:00:00Z' }))).results[0];
  assert.equal(second.outcome, 'accepted');
  assert.equal(second.contact_id, first.contact_id);
  assert.equal(second.is_new_contact, false);
  assert.equal(second.processing_outcome, 'returning_contact_no_new_action');
  assert.equal(second.score.fit, 49);
  assert.notEqual(second.score.id, first.score.id);
  assert.equal(second.work_item, null);
  assert.equal(second.notification, null);
  const c = await contactByEmail(pool, email);
  assert.equal(c.touch_count, 2);
  assert.equal(c.company, 'New Employer');
  assert.equal(c.job_title, 'Lead Engineer');
  const { rows } = await pool.query('select scoring_input from lq_v2.scores where id = $1', [second.score.id]);
  assert.equal(rows[0].scoring_input.job_title, 'Lead Engineer');

  // An older event arriving late fills blanks but does not overwrite newer data.
  await submit(pool, lead(run, 'late', { email, company: 'Old Employer', phone: '555-0100', occurred_at: '2026-09-01T00:00:00Z' }));
  const c2 = await contactByEmail(pool, email);
  assert.equal(c2.company, 'New Employer');
  assert.equal(c2.phone, '555-0100');
  assert.equal(c2.touch_count, 3);
  assert.equal(new Date(c2.last_event_at).toISOString(), '2026-10-02T00:00:00.000Z');
});

test('6. deterministic routing boundaries persist the right work items', async () => {
  const run = newRunTag();
  const keys = ['fit49', 'fit50', 'fit79', 'fit80', 'vpNoDeal'];
  const { results } = await submit(pool, keys.map((k) => lead(run, k, PROFILES[k])));
  const kinds = { manual_review: 'manual_review', nurture: 'nurture', call_now: 'call_now' };
  results.forEach((r, i) => {
    const exp = EXPECTED[keys[i]];
    assert.equal(r.score.fit, exp.fit, keys[i]);
    assert.equal(r.score.route, exp.route, keys[i]);
    assert.equal(r.work_item.kind, kinds[exp.route], keys[i]);
    assert.equal(r.notification !== null, exp.route === 'call_now', keys[i]);
  });
  const { rows } = await pool.query(
    `select w.next_action_at - w.created_at as delay from lq_v2.work_items w
       join lq_v2.source_events e on e.id = w.event_id where e.source_event_id = $1`, [`${run}-fit50`]);
  assert.equal(rows[0].delay.days, 3);
});

test('6b. database rejects a score whose route contradicts the thresholds', async () => {
  const run = newRunTag();
  const [ev] = prepareIntake(lead(run, 'fit79', PROFILES.fit79), { slackChannelId: TEST_CHANNEL }).events;
  ev.score.route = 'call_now';
  const r = await rpc(pool, 'lq_v2_accept_batch', [JSON.stringify([ev])]);
  assert.equal(r.results[0].outcome, 'rejected');
  assert.match(r.results[0].errors[0].problem, /scores_route_matches_fit/);
  assert.equal((await countsForRun(pool, run)).events, 0);
});

test('7. invalid input causes no writes; mixed batch reports per-event outcomes', async () => {
  const run = newRunTag();
  const bad = [
    { source_event_id: `${run}-noemail` },
    { source_event_id: `${run}-bademail`, email: 'nope' },
    { source_event_id: `${run}-badtype`, email: `x+${run}@example.test`, employee_count: 'many' }
  ];
  const r1 = await submit(pool, bad);
  assert.equal(r1.invalid.length, 3);
  assert.equal(r1.results.length, 0);
  assert.equal((await countsForRun(pool, run)).events, 0);

  const r2 = await submit(pool, [lead(run, 'ok1', PROFILES.fit50), { source_event_id: `${run}-bad`, email: 12 }, lead(run, 'ok2', PROFILES.fit80)]);
  assert.deepEqual(r2.invalid.map((x) => x.index), [1]);
  assert.deepEqual(r2.results.map((x) => [x.index, x.outcome]), [[0, 'accepted'], [2, 'accepted']]);

  // Defense in depth: bad data that bypasses JS validation is rejected by the database.
  const [ev] = prepareIntake(lead(run, 'bypass', PROFILES.fit50), { slackChannelId: TEST_CHANNEL }).events;
  ev.contact.email = 'NOT NORMALIZED';
  const r3 = await rpc(pool, 'lq_v2_accept_batch', [JSON.stringify([ev])]);
  assert.equal(r3.results[0].outcome, 'rejected');
  assert.equal((await countsForRun(pool, run)).events, 2);
});

test('7b. unauthorized roles cannot call the RPC or read tables', async () => {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    for (const role of ['anon', 'authenticated']) {
      await client.query(`set role ${role}`);
      await assert.rejects(client.query(`select public.lq_v2_accept_batch('[]'::jsonb)`), /permission denied/);
      await assert.rejects(client.query('select * from lq_v2.notifications'), /permission denied/);
      await client.query('reset role');
    }
  } finally {
    await client.end();
  }
});

test('8. missing notification target aborts the whole batch (no partial acceptance)', async () => {
  const run = newRunTag();
  await assert.rejects(
    submit(pool, [lead(run, 'nurture', PROFILES.fit50), lead(run, 'hot', PROFILES.highFit)], { channel: null }),
    /notification target missing or malformed/
  );
  assert.equal((await countsForRun(pool, run)).events, 0);
});

test('9. database crash before commit loses nothing accepted; retry is accepted once', async () => {
  const run = newRunTag();
  const ev = lead(run, 'highFit', PROFILES.highFit);
  const [payload] = prepareIntake(ev, { slackChannelId: TEST_CHANNEL }).events;

  const victim = new Client({ connectionString: DB_URL });
  victim.on('error', () => {});
  await victim.connect();
  const { rows } = await victim.query('select pg_backend_pid() as pid');
  await victim.query('begin');
  await victim.query('select public.lq_v2_accept_batch($1)', [JSON.stringify([payload])]);
  // Kill the session mid-transaction, as a crash or dropped connection would.
  await pool.query('select pg_terminate_backend($1)', [rows[0].pid]);
  await assert.rejects(victim.query('commit'));
  await victim.end().catch(() => {});
  assert.equal((await countsForRun(pool, run)).events, 0);

  // Unreachable database: the call fails, so the workflow returns 503, never 2xx.
  const down = new Pool({ connectionString: DB_URL.replace(/:\d+\//, ':1/'), max: 1, connectionTimeoutMillis: 2000 });
  await assert.rejects(rpc(down, 'lq_v2_accept_batch', [JSON.stringify([payload])]));
  await down.end();

  // Sender retry after recovery: accepted exactly once.
  const r1 = (await submit(pool, ev)).results[0];
  const r2 = (await submit(pool, ev)).results[0];
  assert.equal(r1.outcome, 'accepted');
  assert.equal(r2.outcome, 'duplicate');
  assert.deepEqual(await countsForRun(pool, run), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });
});

test('10. repeatable runs: purge removes only its own synthetic run', async () => {
  const runA = newRunTag();
  const runB = newRunTag();
  await submit(pool, [lead(runA, 'highFit', PROFILES.highFit), lead(runA, 'fit50', PROFILES.fit50)]);
  await submit(pool, [lead(runB, 'highFit', PROFILES.highFit)]);
  const purged = await rpc(pool, 'lq_v2_purge_synthetic_run', [runA]);
  assert.deepEqual(purged, { events: 2, contacts: 2 });
  assert.equal((await countsForRun(pool, runA)).events, 0);
  assert.deepEqual(await countsForRun(pool, runB), { events: 1, contacts: 1, scores: 1, work_items: 1, notifications: 1 });
  await assert.rejects(rpc(pool, 'lq_v2_purge_synthetic_run', ['']), /run tag/);
  await assert.rejects(rpc(pool, 'lq_v2_purge_synthetic_run', ['%']), /run tag/);

  // Re-running the same fixtures after a purge works with no other cleanup.
  const again = await submit(pool, [lead(runA, 'highFit', PROFILES.highFit)]);
  assert.equal(again.results[0].outcome, 'accepted');
});

test('11. isolation guard refuses to install next to v1 tables', async () => {
  const dbName = 'lqv2_guard_' + newRunTag().toLowerCase();
  await pool.query(`create database ${dbName}`);
  const url = DB_URL.replace(/\/[^/]+$/, `/${dbName}`);
  try {
    execFileSync('psql', [url, '-q', '-c', 'create table public.leads (id int)']);
    let stderr = '';
    try {
      execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(__dirname, '../../sql/migrations/001_lq_v2_schema.sql')], { stdio: 'pipe' });
    } catch (e) {
      stderr = e.stderr.toString();
    }
    assert.match(stderr, /lq_v2 install refused/);
    const schema = execFileSync('psql', [url, '-qtAc', "select count(*) from pg_namespace where nspname = 'lq_v2'"]).toString().trim();
    assert.equal(schema, '0');
  } finally {
    await pool.query(`drop database ${dbName} with (force)`);
  }
});

test('ledger view reconciles contact, event, scoring input, score, route and notification', async () => {
  const run = newRunTag();
  await submit(pool, lead(run, 'highFit', PROFILES.highFit));
  const { rows } = await pool.query('select * from lq_v2.event_ledger where source_event_id = $1', [`${run}-highFit`]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.fit, 100);
  assert.equal(r.route, 'call_now');
  assert.equal(r.work_item_kind, 'call_now');
  assert.equal(r.notification_status, 'pending');
  assert.equal(r.scoring_input.job_title, 'CEO');
  assert.equal(r.score_version, 'rule-based-v1');
});
