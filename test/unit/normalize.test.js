const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRequest } = require('../../src/normalize');
const { buildIntakeResponse } = require('../../src/response');
const { lead, PROFILES } = require('../fixtures/leads');

test('valid single event normalizes email and keeps scoring input', () => {
  const r = normalizeRequest(lead('t', 'highFit', { ...PROFILES.highFit, email: '  Ada.Founder@Example.TEST ' }));
  assert.equal(r.invalid.length, 0);
  const e = r.valid[0];
  assert.equal(e.contact.email, 'ada.founder@example.test');
  assert.equal(e.contact.name, 'Ada Founder');
  assert.deepEqual(e.scoring_input, {
    employee_count: 1000, job_title: 'CEO', deal_size: 100000, lead_source: 'referral', first_conversion: null, recent_conversion: null
  });
  assert.equal(e.source, 'synthetic');
});

test('v1 camelCase aliases are accepted', () => {
  const r = normalizeRequest({ source_event_id: 'a1', email: 'x@example.test', firstName: 'X', jobTitle: 'CTO', employeeCount: '500', dealSize: '25000.50' });
  assert.equal(r.invalid.length, 0);
  assert.equal(r.valid[0].scoring_input.employee_count, 500);
  assert.equal(r.valid[0].scoring_input.deal_size, 25000.5);
  assert.equal(r.valid[0].scoring_input.job_title, 'CTO');
});

const badCases = [
  ['missing email', { source_event_id: 'e1' }, 'email'],
  ['non-string email', { source_event_id: 'e1', email: 12345 }, 'email'],
  ['malformed email', { source_event_id: 'e1', email: 'not-an-email' }, 'email'],
  ['email with markup', { source_event_id: 'e1', email: '<a>@b.co' }, 'email'],
  ['missing event id', { email: 'a@b.co' }, 'source_event_id'],
  ['event id with spaces', { source_event_id: 'a b', email: 'a@b.co' }, 'source_event_id'],
  ['negative employees', { source_event_id: 'e1', email: 'a@b.co', employee_count: -5 }, 'employee_count'],
  ['fractional employees', { source_event_id: 'e1', email: 'a@b.co', employee_count: 10.5 }, 'employee_count'],
  ['text deal size', { source_event_id: 'e1', email: 'a@b.co', deal_size: 'lots' }, 'deal_size'],
  ['object job title', { source_event_id: 'e1', email: 'a@b.co', job_title: { x: 1 } }, 'job_title'],
  ['bad timestamp', { source_event_id: 'e1', email: 'a@b.co', occurred_at: 'yesterday' }, 'occurred_at'],
  ['bad source', { source_event_id: 'e1', email: 'a@b.co', source: 'Bad Source!' }, 'source'],
  ['oversized message', { source_event_id: 'e1', email: 'a@b.co', message: 'x'.repeat(6000) }, 'message']
];

for (const [name, ev, field] of badCases) {
  test(`invalid: ${name}`, () => {
    const r = normalizeRequest(ev);
    assert.equal(r.valid.length, 0);
    assert.equal(r.invalid.length, 1);
    assert.ok(r.invalid[0].errors.some((e) => e.field === field), JSON.stringify(r.invalid[0].errors));
  });
}

test('non-object bodies are rejected', () => {
  for (const body of [null, 'text', 42, [], new Array(51).fill({})]) {
    const r = normalizeRequest(body);
    assert.equal(r.valid.length, 0);
    assert.equal(r.invalid[0].index, null);
  }
});

test('batch keeps per-event separation and reports partial failures by index', () => {
  const r = normalizeRequest([
    lead('t', 'a', PROFILES.highFit),
    { source_event_id: 'bad', email: 'nope' },
    lead('t', 'b', PROFILES.fit49)
  ]);
  assert.deepEqual(r.valid.map((e) => e.index), [0, 2]);
  assert.deepEqual(r.invalid.map((e) => e.index), [1]);
  assert.notEqual(r.valid[0].contact.email, r.valid[1].contact.email);
});

test('response status codes', () => {
  const inv = [{ index: 1, source_event_id: 'x', errors: [] }];
  assert.equal(buildIntakeResponse([], [{ index: 0, outcome: 'accepted' }]).statusCode, 202);
  assert.equal(buildIntakeResponse([], [{ index: 0, outcome: 'duplicate' }]).statusCode, 202);
  assert.equal(buildIntakeResponse(inv, []).statusCode, 400);
  assert.equal(buildIntakeResponse([], [{ index: 0, outcome: 'conflict' }]).statusCode, 409);
  const mixed = buildIntakeResponse(inv, [{ index: 0, outcome: 'accepted' }, { index: 2, outcome: 'rejected' }]);
  assert.equal(mixed.statusCode, 207);
  assert.deepEqual(mixed.body.results.map((r) => r.index), [0, 1, 2]);
});

test('occurred_at more than 5 minutes ahead of the clock is rejected (fix: contact freeze)', () => {
  const now = Date.parse('2026-11-01T12:00:00.000Z');
  const at = (iso) => normalizeRequest({ source_event_id: 'f1', email: 'a@b.co', occurred_at: iso }, now);
  assert.equal(at('2026-11-01T12:05:00.000Z').invalid.length, 0, 'exactly 5 minutes ahead is allowed');
  assert.equal(at('2026-11-01T12:04:59.000Z').valid[0].occurred_at, '2026-11-01T12:04:59.000Z');
  const bad = at('2026-11-01T12:05:01.000Z');
  assert.equal(bad.valid.length, 0);
  assert.deepEqual(bad.invalid[0].errors, [{ field: 'occurred_at', problem: 'must not be more than 5 minutes in the future' }]);
  assert.equal(at('2099-01-01T00:00:00Z').valid.length, 0);
  assert.equal(at('2001-01-01T00:00:00Z').valid.length, 1, 'old dates stay valid');
});

test('the default clock is the system time', () => {
  const soon = new Date(Date.now() + 60 * 1000).toISOString();
  const far = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  assert.equal(normalizeRequest({ source_event_id: 'f2', email: 'a@b.co', occurred_at: soon }).valid.length, 1);
  assert.equal(normalizeRequest({ source_event_id: 'f3', email: 'a@b.co', occurred_at: far }).valid.length, 0);
});
