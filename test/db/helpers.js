// Shared helpers for database tests. Requires the local container:
//   npm run db:up
// All RPC calls run as service_role, the role n8n uses through Supabase.
const { Pool } = require('pg');
const { prepareIntake } = require('../../src/intake');

const DB_URL = process.env.LQ_V2_TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:54329/postgres';
if (!/localhost|127\.0\.0\.1/.test(DB_URL)) {
  throw new Error('DB tests only run against a local database');
}
const TEST_CHANNEL = 'CTESTLQV2';

function makePool(max = 20) {
  return new Pool({ connectionString: DB_URL, max });
}

async function rpc(pool, fn, args) {
  const client = await pool.connect();
  try {
    await client.query('set role service_role');
    const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await client.query(`select public.${fn}(${placeholders}) as r`, args);
    return rows[0].r;
  } finally {
    await client.query('reset role').catch(() => {});
    client.release();
  }
}

// Same path as the intake workflow: validate + score in JS, then one RPC.
async function submit(pool, body, { channel = TEST_CHANNEL } = {}) {
  const { events, invalid } = prepareIntake(body, { slackChannelId: channel });
  const db = events.length ? await rpc(pool, 'lq_v2_accept_batch', [JSON.stringify(events)]) : { results: [] };
  return { invalid, results: db.results };
}

async function countsForRun(pool, runTag) {
  const like = `${runTag}-%`;
  const { rows } = await pool.query(
    `select
       (select count(*) from lq_v2.source_events where source_event_id like $1)::int as events,
       (select count(distinct contact_id) from lq_v2.source_events where source_event_id like $1)::int as contacts,
       (select count(*) from lq_v2.scores s join lq_v2.source_events e on e.id = s.event_id where e.source_event_id like $1)::int as scores,
       (select count(*) from lq_v2.work_items w join lq_v2.source_events e on e.id = w.event_id where e.source_event_id like $1)::int as work_items,
       (select count(*) from lq_v2.notifications n join lq_v2.source_events e on e.id = n.event_id where e.source_event_id like $1)::int as notifications`,
    [like]
  );
  return rows[0];
}

async function contactByEmail(pool, email) {
  const { rows } = await pool.query('select * from lq_v2.contacts where email_normalized = $1', [email.trim().toLowerCase()]);
  return rows[0];
}

module.exports = { makePool, rpc, submit, countsForRun, contactByEmail, DB_URL, TEST_CHANNEL };
