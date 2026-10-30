const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSlackText, classifySendResponse, findReconciledMessage, correlationIdFor } = require('../../src/notify');
const { scoreLead } = require('../../src/score');
const { normalizeEvent } = require('../../src/normalize');
const { lead, PROFILES } = require('../fixtures/leads');

test('message keeps v1 content, adds correlation ref, escapes lead text', () => {
  const ev = normalizeEvent(lead('t', 'highFit', { ...PROFILES.highFit, company: '<!channel> & Co' })).event;
  const text = renderSlackText(ev, scoreLead(ev.scoring_input));
  assert.match(text, /HIGH PRIORITY LEAD - CALL NOW/);
  assert.match(text, /\*Fit Score:\* 100\/100/);
  assert.match(text, /\*Urgency Score:\* 65\/100/);
  assert.match(text, /&lt;!channel&gt; &amp; Co/);
  assert.ok(!text.includes('<!channel>'));
  assert.ok(text.includes(correlationIdFor(ev)));
  assert.ok(!text.includes('localhost'));
});

const sendCases = [
  ['ok with receipt', { statusCode: 200, body: { ok: true, ts: '1.2', channel: 'C1' } }, 'sent'],
  ['ok as JSON string', { statusCode: 200, body: '{"ok":true,"ts":"1.2","channel":"C1"}' }, 'sent'],
  ['ok without ts', { statusCode: 200, body: { ok: true } }, 'uncertain'],
  ['channel_not_found', { statusCode: 200, body: { ok: false, error: 'channel_not_found' } }, 'permanent_failure'],
  ['invalid_auth', { statusCode: 200, body: { ok: false, error: 'invalid_auth' } }, 'permanent_failure'],
  ['ratelimited body', { statusCode: 200, body: { ok: false, error: 'ratelimited' } }, 'retryable_failure'],
  ['http 429', { statusCode: 429, body: {} }, 'retryable_failure'],
  ['internal_error', { statusCode: 200, body: { ok: false, error: 'internal_error' } }, 'uncertain'],
  ['http 500', { statusCode: 500, body: 'oops' }, 'uncertain'],
  ['http 503', { statusCode: 503, body: '' }, 'uncertain'],
  ['http 403', { statusCode: 403, body: { ok: false, error: 'not_allowed' } }, 'permanent_failure'],
  ['html 200', { statusCode: 200, body: '<html>' }, 'uncertain'],
  ['connection refused', { error: { message: 'connect ECONNREFUSED 1.2.3.4:443' } }, 'retryable_failure'],
  ['dns failure', { error: 'getaddrinfo ENOTFOUND slack.com' }, 'retryable_failure'],
  ['timeout', { error: { message: 'timeout of 10000ms exceeded', code: 'ECONNABORTED' } }, 'uncertain'],
  ['socket reset', { error: 'socket hang up ECONNRESET' }, 'uncertain'],
  ['unknown error', { error: 'something odd' }, 'uncertain'],
  // Real n8n 2.14.2 error-output shapes (observed in the local e2e run)
  ['n8n timeout', { error: { name: 'NodeApiError', context: {}, message: 'The connection was aborted, perhaps the server is offline' } }, 'uncertain'],
  ['n8n refused', { error: { name: 'NodeApiError', message: 'The service refused the connection - perhaps it is offline' } }, 'retryable_failure']
];
for (const [name, input, outcome] of sendCases) {
  test(`classify send: ${name} -> ${outcome}`, () => {
    assert.equal(classifySendResponse(input).outcome, outcome);
  });
}

test('sent result carries receipt fields', () => {
  const r = classifySendResponse({ statusCode: 200, body: { ok: true, ts: '171.001', channel: 'C9' } });
  assert.deepEqual(r, { outcome: 'sent', message_ts: '171.001', provider_channel: 'C9', http_status: 200 });
});

test('reconcile: found / not_found / inconclusive / error', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const msg = (nid, ts) => ({ ts, metadata: { event_type: 'lq_v2_notification', event_payload: { notification_id: nid } } });
  assert.deepEqual(
    findReconciledMessage({ statusCode: 200, body: { ok: true, messages: [msg('other', '1'), msg(id, '2')], has_more: false } }, id),
    { outcome: 'found', message_ts: '2', http_status: 200 }
  );
  assert.equal(findReconciledMessage({ statusCode: 200, body: { ok: true, messages: [msg('other', '1')], has_more: false } }, id).outcome, 'not_found');
  assert.equal(findReconciledMessage({ statusCode: 200, body: { ok: true, messages: [], has_more: true } }, id).outcome, 'reconcile_error');
  assert.equal(findReconciledMessage({ statusCode: 200, body: { ok: false, error: 'missing_scope' } }, id).outcome, 'reconcile_error');
  assert.equal(findReconciledMessage({ error: 'ETIMEDOUT' }, id).outcome, 'reconcile_error');
});
