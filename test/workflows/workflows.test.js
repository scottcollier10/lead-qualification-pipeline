// Static checks on the v2 workflow exports plus execution of each Code node
// with stubbed n8n globals ($input, $json, $). Does not prove n8n runtime
// behavior; the local n8n end-to-end run (test/e2e) covers that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildAll, placeholderConfig, deployConfig } = require('../../scripts/build-workflows');
const { prepareIntake } = require('../../src/intake');
const { lead, PROFILES } = require('../fixtures/leads');

const ROOT = path.join(__dirname, '../..');
const DIR = path.join(ROOT, 'workflows/v2');
const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const codeOf = (wf, name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;
const runCode = (code, globals) => new Function(...Object.keys(globals), code)(...Object.values(globals));

// Node typeVersions confirmed working on the existing n8n 2.14.2 instance.
const PROVEN_VERSIONS = {
  'n8n-nodes-base.httpRequest': 4.2,
  'n8n-nodes-base.code': 2,
  'n8n-nodes-base.if': 2,
  'n8n-nodes-base.webhook': 2,
  'n8n-nodes-base.scheduleTrigger': 1.2,
  'n8n-nodes-base.respondToWebhook': 1.1,
  'n8n-nodes-base.errorTrigger': 1,
  'n8n-nodes-base.stickyNote': 1
};

test('committed exports match a fresh build from src/ (no drift)', () => {
  const built = buildAll(placeholderConfig());
  assert.deepEqual(files.sort(), Object.keys(built).sort());
  for (const f of files) assert.deepEqual(load(f), JSON.parse(JSON.stringify(built[f])), f);
});

test('original v1 exports and schema snapshot are unchanged', () => {
  const lines = fs.readFileSync(path.join(ROOT, 'docs/v2/original-exports.sha256'), 'utf8').trim().split('\n');
  for (const line of lines) {
    const [hash, file] = line.split(/\s+/);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex');
    assert.equal(actual, hash, file);
  }
});

for (const f of files) {
  test(`${f}: inactive, valid graph, proven node versions, no legacy references`, () => {
    const wf = load(f);
    assert.equal(wf.active, false);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.equal(names.size, wf.nodes.length, 'unique node names');
    for (const n of wf.nodes) assert.equal(PROVEN_VERSIONS[n.type], n.typeVersion, `${n.name} ${n.type}`);
    for (const [from, c] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), from);
      for (const out of c.main) for (const t of out) assert.ok(names.has(t.node), t.node);
    }
    // Every non-trigger, non-note node has an incoming connection.
    const targets = new Set(Object.values(wf.connections).flatMap((c) => c.main.flat().map((t) => t.node)));
    for (const n of wf.nodes) {
      if (/Trigger|webhook|stickyNote/i.test(n.type)) continue;
      assert.ok(targets.has(n.name), `${n.name} unreachable`);
    }
    const text = JSON.stringify(wf);
    for (const legacy of ['ivzmpbtbxvbepzstcmjf', 'hubspot-lead-webhook-dd', 'U09D9L51DBP', 'localhost:5678']) {
      assert.ok(!text.includes(legacy), `${f} references legacy ${legacy}`);
    }
    assert.ok(!/xoxb-|eyJhbGci|sk-ant-/.test(text), 'no secrets');
    // Committed exports must never carry a real credential binding: every
    // credential reference is a build placeholder, whatever environment it
    // came from.
    for (const n of wf.nodes) {
      for (const [type, ref] of Object.entries(n.credentials || {})) {
        assert.match(ref.id, /^__LQ_V2_CRED_[A-Z]+_ID__$/, `${n.name} ${type} id is not a placeholder`);
        assert.match(ref.name, /^__LQ_V2_CRED_[A-Z]+_NAME__$/, `${n.name} ${type} name is not a placeholder`);
      }
    }
    // Same for environment values: Supabase URL and Slack channels.
    assert.ok(!/https:\/\/[a-z0-9]{20}\.supabase\.co/.test(text), 'real Supabase project URL');
    // Quotes inside Code nodes and expressions are escaped in the JSON text.
    assert.ok(!/\\?"C[A-Z0-9]{8,}\\?"/.test(text.replace(/__LQ_V2_[A-Z_]+__/g, '')), 'real Slack channel ID');
    // The n8n-workflow-builder MCP drops per-node onError/continueOnFail, so
    // the workflows must not depend on them.
    for (const n of wf.nodes) {
      assert.equal(n.onError, undefined, `${n.name} uses onError`);
      assert.equal(n.continueOnFail, undefined, `${n.name} uses continueOnFail`);
    }
    for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      assert.doesNotThrow(() => new Function('$input', '$json', '$', n.parameters.jsCode), n.name);
    }
  });
}

test('intake: new authenticated webhook path, responds only via Respond node', () => {
  const wf = load('lq-v2-intake.json');
  const hook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  assert.equal(hook.parameters.path, 'lq-v2-intake');
  assert.equal(hook.parameters.authentication, 'headerAuth');
  assert.equal(hook.parameters.responseMode, 'responseNode');
  assert.ok(hook.credentials.httpHeaderAuth);
  assert.ok(!JSON.stringify(wf).includes('chat.postMessage'), 'intake never calls Slack');
  const rpc = wf.nodes.find((n) => n.name === 'Accept Events (RPC)');
  assert.equal(rpc.parameters.options.response.response.neverError, true);
  assert.equal(wf.connections['Accept Events (RPC)'].main[0][0].node, 'Build Response');
});

test('intake Code nodes produce the same payloads as the tested modules', () => {
  const wf = load('lq-v2-intake.json');
  const body = [lead('wf', 'highFit', PROFILES.highFit), { source_event_id: 'bad', email: 3 }];
  const out = runCode(codeOf(wf, 'Validate and Score'), { $input: { first: () => ({ json: { body } }) } });
  assert.deepEqual(out[0].json, JSON.parse(JSON.stringify(prepareIntake(body, { slackChannelId: '__LQ_V2_SLACK_CHANNEL_ID__' }))));

  const prep = out[0].json;
  const respond = (input) => runCode(codeOf(wf, 'Build Response'), {
    $input: { first: () => ({ json: input }) },
    $: () => ({ first: () => ({ json: prep }) })
  })[0].json;
  const mixed = respond({ statusCode: 200, body: { results: [{ index: 0, outcome: 'accepted' }] } });
  assert.equal(mixed.statusCode, 207);
  assert.equal(respond({ statusCode: 200, body: '{"results":[{"index":0,"outcome":"accepted"}]}' }).statusCode, 207);
  assert.equal(respond(prep).statusCode, 400); // IF false branch passes the prep item through
  for (const failed of [{ statusCode: 503, body: { message: 'down' } }, { statusCode: 401, body: {} }, { statusCode: 200, body: 'garbage' }]) {
    assert.deepEqual(respond(failed), { statusCode: 503, body: { status: 503, error: 'not_accepted', retry: true } });
  }
});

test('dispatcher: Slack send has no n8n auto-retry; every HTTP answer reaches classification', () => {
  const wf = load('lq-v2-notification-dispatcher.json');
  const send = wf.nodes.find((n) => n.name === 'Slack chat.postMessage');
  assert.notEqual(send.retryOnFail, true);
  assert.equal(send.parameters.options.response.response.neverError, true);
  assert.equal(send.parameters.url, 'https://slack.com/api/chat.postMessage');
  assert.match(send.parameters.jsonBody, /lq_v2_notification/);
  assert.equal(wf.connections['Slack chat.postMessage'].main.length, 1);
  assert.equal(wf.connections['Slack chat.postMessage'].main[0][0].node, 'Classify Send Result');
  assert.equal(wf.settings.saveDataSuccessExecution, 'none');
  assert.equal(wf.settings.saveDataErrorExecution, 'all');
});

test('dispatcher Code nodes build RPC arguments from paired claims', () => {
  const wf = load('lq-v2-notification-dispatcher.json');
  const claim = { mode: 'send', notification_id: 'n1', attempt_no: 2, channel: 'C1', text: 'hi', correlation_id: 'lqv2:x:y' };
  const split = runCode(codeOf(wf, 'Split Claims'), { $input: { first: () => ({ json: { claims: [claim] } }) } });
  assert.deepEqual(split, [{ json: claim }]);
  assert.deepEqual(runCode(codeOf(wf, 'Split Claims'), { $input: { first: () => ({ json: { claims: [] } }) } }), []);

  const paired = { $: () => ({ item: { json: claim } }) };
  const ok = runCode(codeOf(wf, 'Classify Send Result'), { ...paired, $json: { statusCode: 200, body: { ok: true, ts: '1.1', channel: 'C1' } } }).json;
  assert.deepEqual(
    { ...ok, p_result: { ...ok.p_result, provider_response: undefined } },
    { p_notification_id: 'n1', p_attempt_no: 2, p_result: { outcome: 'sent', message_ts: '1.1', provider_channel: 'C1', http_status: 200, provider_response: undefined } }
  );
  const s500 = runCode(codeOf(wf, 'Classify Send Result'), { ...paired, $json: { statusCode: 500, body: 'oops' } }).json;
  assert.equal(s500.p_result.outcome, 'uncertain');
  assert.deepEqual(s500.p_result.provider_response, { raw: 'oops' });

  const rclaim = { ...claim, mode: 'reconcile' };
  const found = runCode(codeOf(wf, 'Classify Reconcile Result'), {
    $: () => ({ item: { json: rclaim } }),
    $json: { statusCode: 200, body: { ok: true, has_more: false, messages: [{ ts: '5.5', metadata: { event_type: 'lq_v2_notification', event_payload: { notification_id: 'n1' } } }] } }
  }).json;
  assert.equal(found.p_result.outcome, 'found');
  assert.equal(found.p_result.message_ts, '5.5');
});

test('dispatcher raises an alert only when a recorded result needs an operator', () => {
  const wf = load('lq-v2-notification-dispatcher.json');
  const code = codeOf(wf, 'Raise Operator Alert');
  const items = (list) => ({ $input: { all: () => list.map((json) => ({ json })) } });
  const fine = [{ applied: true, notification: { id: 'a', status: 'sent', operator_required: false } }];
  assert.equal(runCode(code, items(fine)).length, 1);
  assert.throws(
    () => runCode(code, items([...fine, { applied: true, notification: { id: 'b', status: 'failed', operator_required: true } }])),
    /needs operator action: b \(failed\)/
  );
});

test('error handler reads the documented error payload', () => {
  const wf = load('lq-v2-error-handler.json');
  assert.equal(wf.settings.errorWorkflow, undefined);
  const out = runCode(codeOf(wf, 'Describe Error'), {
    $input: { first: () => ({ json: { execution: { id: 42, lastNodeExecuted: 'Accept Events (RPC)', error: { message: 'boom <!channel>' }, mode: 'webhook' }, workflow: { id: 'w1', name: 'LQ v2 - Intake' } } }) }
  })[0].json;
  assert.equal(out.last_node, 'Accept Events (RPC)');
  assert.equal(out.error_message, 'boom <!channel>');
  assert.match(out.slack_text, /boom &lt;!channel&gt;/);
  for (const n of ['Slack Ops Alert', 'Log Error (RPC)']) {
    assert.equal(wf.nodes.find((x) => x.name === n).parameters.options.response.response.neverError, true);
  }
});

test('deploy build refuses missing values, the v1 database and non-local Slack overrides', () => {
  assert.throws(() => deployConfig({}), /LQ_V2_SUPABASE_URL is not set/);
  const good = {
    LQ_V2_SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', LQ_V2_SLACK_CHANNEL_ID: 'C0123ABCD',
    LQ_V2_CRED_SUPABASE_ID: 'a', LQ_V2_CRED_SUPABASE_NAME: 'b', LQ_V2_CRED_SLACK_ID: 'c', LQ_V2_CRED_SLACK_NAME: 'd',
    LQ_V2_CRED_WEBHOOK_ID: 'e', LQ_V2_CRED_WEBHOOK_NAME: 'f'
  };
  const c = deployConfig(good);
  assert.equal(c.LQ_V2_SLACK_OPS_CHANNEL_ID, 'C0123ABCD');
  assert.throws(() => deployConfig({ ...good, LQ_V2_SUPABASE_URL: 'https://ivzmpbtbxvbepzstcmjf.supabase.co' }), /v1 Lead Intake database/);
  assert.throws(() => deployConfig({ ...good, LQ_V2_SLACK_API_BASE: 'https://evil.example.com' }), /local test server/);
  assert.throws(() => deployConfig({ ...good, LQ_V2_SLACK_CHANNEL_ID: '#leads' }), /channel ID/);
  const wf = buildAll(c)['lq-v2-intake.json'];
  assert.ok(!JSON.stringify(wf).includes('__LQ_V2_'), 'no placeholders left in deploy build');
});
