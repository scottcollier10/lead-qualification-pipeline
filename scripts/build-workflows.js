#!/usr/bin/env node
// Builds the v2 n8n workflow exports from src/ so Code nodes run exactly the
// tested modules.
//
//   node scripts/build-workflows.js
//     -> workflows/v2/*.json with __PLACEHOLDER__ values (committed, inactive)
//   node scripts/build-workflows.js --env-file .env.lq-v2.local --out dist
//     -> deployable copies with real URL, channel and credential IDs injected
//        (n8n 2.14.x import binds credentials only by exact ID)
//
// The build never contacts n8n, Supabase or Slack.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const VERSION = require(path.join(ROOT, 'package.json')).version;

const KEYS = [
  'LQ_V2_SUPABASE_URL',
  'LQ_V2_SLACK_CHANNEL_ID',
  'LQ_V2_SLACK_OPS_CHANNEL_ID',
  'LQ_V2_CRED_SUPABASE_ID',
  'LQ_V2_CRED_SUPABASE_NAME',
  'LQ_V2_CRED_SLACK_ID',
  'LQ_V2_CRED_SLACK_NAME',
  'LQ_V2_CRED_WEBHOOK_ID',
  'LQ_V2_CRED_WEBHOOK_NAME'
];
// LQ_V2_SLACK_API_BASE and LQ_V2_TEST_DISPATCH_SECONDS are local-test seams only.
const OPTIONAL = ['LQ_V2_ERROR_WORKFLOW_ID', 'LQ_V2_SLACK_API_BASE', 'LQ_V2_TEST_DISPATCH_SECONDS'];

function placeholderConfig() {
  const c = {};
  for (const k of KEYS) c[k] = `__${k}__`;
  c.LQ_V2_SLACK_API_BASE = 'https://slack.com/api';
  c.LQ_V2_ERROR_WORKFLOW_ID = '';
  return c;
}

function parseEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function deployConfig(env) {
  const c = { ...placeholderConfig(), LQ_V2_SLACK_OPS_CHANNEL_ID: env.LQ_V2_SLACK_CHANNEL_ID };
  for (const k of [...KEYS, ...OPTIONAL]) if (env[k]) c[k] = env[k];
  const problems = [];
  for (const k of KEYS) if (!c[k] || c[k].startsWith('__')) problems.push(`${k} is not set`);
  if (c.LQ_V2_SUPABASE_URL && !/^https:\/\/[a-z0-9-]+\.supabase\.co$|^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal|[a-z0-9-]+)(:\d+)?$/.test(c.LQ_V2_SUPABASE_URL)) {
    problems.push('LQ_V2_SUPABASE_URL must be https://<ref>.supabase.co (no trailing slash)');
  }
  if (c.LQ_V2_SUPABASE_URL && c.LQ_V2_SUPABASE_URL.includes('ivzmpbtbxvbepzstcmjf')) {
    problems.push('LQ_V2_SUPABASE_URL points at the v1 Lead Intake database; v2 requires a dedicated project');
  }
  for (const k of ['LQ_V2_SLACK_CHANNEL_ID', 'LQ_V2_SLACK_OPS_CHANNEL_ID']) {
    if (c[k] && !/^[CGD][A-Z0-9]{2,30}$/.test(c[k])) problems.push(`${k} must be a Slack channel ID like C0123ABCD`);
  }
  const localSlack = c.LQ_V2_SLACK_API_BASE !== 'https://slack.com/api';
  if (localSlack && !/^http:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal|[a-z0-9-]+)(:\d+)?(\/[A-Za-z0-9_/-]*)?$/.test(c.LQ_V2_SLACK_API_BASE)) {
    problems.push('LQ_V2_SLACK_API_BASE may only be overridden with a local test server');
  }
  if (c.LQ_V2_TEST_DISPATCH_SECONDS && (!localSlack || !/^\d+$/.test(c.LQ_V2_TEST_DISPATCH_SECONDS))) {
    problems.push('LQ_V2_TEST_DISPATCH_SECONDS is only allowed in local test builds');
  }
  if (problems.length) throw new Error('Build config invalid:\n  ' + problems.join('\n  '));
  return c;
}

// Inline src modules: drop require/export blocks, keep the functions.
function bundle(...files) {
  return files
    .map((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
      return `// ---- src/${f} ----\n` + src.replace(/\/\/ @(import|export)-start[\s\S]*?\/\/ @\1-end\n?/g, '').trim();
    })
    .join('\n\n');
}

function stableId(...parts) {
  const h = crypto.createHash('sha256').update(parts.join('/')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function workflowBuilder(wfName) {
  const nodes = [];
  const connections = {};
  const add = (name, type, typeVersion, position, parameters, extra = {}) => {
    nodes.push({ id: stableId(wfName, name), name, type, typeVersion, position, parameters, ...extra });
    return name;
  };
  const connect = (from, to, output = 0) => {
    connections[from] = connections[from] || { main: [] };
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({ node: to, type: 'main', index: 0 });
  };
  return { nodes, connections, add, connect };
}

function sticky(b, wfName, text, position, height = 260) {
  b.add('Read Me', 'n8n-nodes-base.stickyNote', 1, position, { content: text, height, width: 420 });
}

function settings(c) {
  const s = { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveManualExecutions: true };
  if (c.LQ_V2_ERROR_WORKFLOW_ID) s.errorWorkflow = c.LQ_V2_ERROR_WORKFLOW_ID;
  return s;
}

function rpcParams(c, fn, jsonBody) {
  return {
    method: 'POST',
    url: `${c.LQ_V2_SUPABASE_URL}/rest/v1/rpc/${fn}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'httpMultipleHeadersAuth',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    options: { timeout: 15000 }
  };
}
const supabaseCred = (c) => ({ httpMultipleHeadersAuth: { id: c.LQ_V2_CRED_SUPABASE_ID, name: c.LQ_V2_CRED_SUPABASE_NAME } });
const slackCred = (c) => ({ httpHeaderAuth: { id: c.LQ_V2_CRED_SLACK_ID, name: c.LQ_V2_CRED_SLACK_NAME } });

function slackParams(c, method, extra) {
  return {
    url: `${c.LQ_V2_SLACK_API_BASE}/${method}`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'httpHeaderAuth',
    ...extra,
    // Full response + never error: we classify Slack's answer ourselves.
    // Network failures (no response) go to the error output.
    options: { timeout: 10000, response: { response: { fullResponse: true, neverError: true } } }
  };
}

function buildIntake(c) {
  const name = 'LQ v2 - Intake';
  const b = workflowBuilder(name);
  sticky(b, name,
    `## LQ v2 Intake (v${VERSION})\nPOST /webhook/lq-v2-intake with header auth.\n\n1. Validate + score in JS (src/ modules, inlined).\n2. One RPC call: lq_v2_accept_batch commits contact, event, score, work item and notification intent in one transaction. Repeats of a source_event_id return the original outcome.\n3. Respond only after the commit: 202 / 207 / 400 / 409, or 503 if the database answered with an error. If the database is unreachable the run fails and n8n answers 500; nothing was committed either way.\n\nSlack is NOT called here. The dispatcher workflow delivers notifications.\nContract: docs/v2/event-contract.md`,
    [-80, -320], 320);

  b.add('Intake Webhook', 'n8n-nodes-base.webhook', 2, [0, 0], {
    httpMethod: 'POST',
    path: 'lq-v2-intake',
    authentication: 'headerAuth',
    responseMode: 'responseNode',
    options: {}
  }, { webhookId: stableId(name, 'webhook'), credentials: { httpHeaderAuth: { id: c.LQ_V2_CRED_WEBHOOK_ID, name: c.LQ_V2_CRED_WEBHOOK_NAME } } });

  b.add('Validate and Score', 'n8n-nodes-base.code', 2, [220, 0], {
    jsCode: [
      bundle('normalize.js', 'score.js', 'notify.js', 'intake.js'),
      '',
      '// ---- node ----',
      `const SLACK_CHANNEL_ID = ${JSON.stringify(c.LQ_V2_SLACK_CHANNEL_ID)};`,
      'const body = $input.first().json.body;',
      'const { events, invalid } = prepareIntake(body, { slackChannelId: SLACK_CHANNEL_ID });',
      'return [{ json: { events, invalid } }];'
    ].join('\n')
  });

  b.add('Any Valid Events', 'n8n-nodes-base.if', 2, [440, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ id: stableId(name, 'cond-valid'), leftValue: '={{ $json.events.length }}', rightValue: 0, operator: { type: 'number', operation: 'gt' } }],
      combinator: 'and'
    },
    options: {}
  });

  b.add('Accept Events (RPC)', 'n8n-nodes-base.httpRequest', 4.2, [660, -100],
    {
      ...rpcParams(c, 'lq_v2_accept_batch', '={{ JSON.stringify({ p_events: $json.events }) }}'),
      // Any HTTP status reaches Build Response, which turns non-2xx into 503.
      // No per-node onError: the n8n-workflow-builder MCP drops that field.
      options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true } } }
    },
    { credentials: supabaseCred(c) });

  b.add('Build Response', 'n8n-nodes-base.code', 2, [900, 0], {
    jsCode: [
      bundle('response.js'),
      '',
      '// ---- node ----',
      "const prep = $('Validate and Score').first().json;",
      'const db = $input.first().json;',
      '// From the "no valid events" branch the input is the prep item itself.',
      'if (db.statusCode === undefined) return [{ json: buildIntakeResponse(prep.invalid, []) }];',
      "let body = db.body;",
      "if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }",
      'if (db.statusCode >= 200 && db.statusCode < 300 && body && Array.isArray(body.results)) {',
      '  return [{ json: buildIntakeResponse(prep.invalid, body.results) }];',
      '}',
      '// The database did not confirm acceptance. Nothing was committed, so the',
      '// sender must retry; retries are safe because acceptance is idempotent.',
      "return [{ json: { statusCode: 503, body: { status: 503, error: 'not_accepted', retry: true } } }];"
    ].join('\n')
  });

  b.add('Respond', 'n8n-nodes-base.respondToWebhook', 1.1, [1120, 0], {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify($json.body) }}',
    options: { responseCode: '={{ $json.statusCode }}' }
  });

  b.connect('Intake Webhook', 'Validate and Score');
  b.connect('Validate and Score', 'Any Valid Events');
  b.connect('Any Valid Events', 'Accept Events (RPC)', 0);
  b.connect('Any Valid Events', 'Build Response', 1);
  b.connect('Accept Events (RPC)', 'Build Response', 0);
  b.connect('Build Response', 'Respond');

  return { name, nodes: b.nodes, connections: b.connections, settings: settings(c), active: false, pinData: {}, meta: { lqVersion: VERSION } };
}

function buildDispatcher(c) {
  const name = 'LQ v2 - Notification Dispatcher';
  const b = workflowBuilder(name);
  sticky(b, name,
    `## LQ v2 Notification Dispatcher (v${VERSION})\nEvery minute:\n1. lq_v2_claim_notifications: expired leases -> uncertain; lease due pending rows; claim due uncertain rows for reconciliation.\n2. send: chat.postMessage with metadata {notification_id}. Result classified as sent / retryable / permanent / uncertain and recorded with the Slack receipt.\n3. reconcile: conversations.history searched by metadata. found -> sent. not found -> requeue. inconclusive -> retry, then operator.\n\nIf a Slack call gets no response at all (timeout, network), the run fails, ops is alerted, and the lease expiry marks the row uncertain so reconciliation decides. No n8n auto-retry: retries are scheduled by the database.\nContract: docs/v2/delivery-contract.md`,
    [-80, -360], 340);

  b.add('Every Minute', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 0], {
    rule: {
      interval: [c.LQ_V2_TEST_DISPATCH_SECONDS
        ? { field: 'seconds', secondsInterval: Number(c.LQ_V2_TEST_DISPATCH_SECONDS) }
        : { field: 'minutes', minutesInterval: 1 }]
    }
  });

  b.add('Claim Notifications (RPC)', 'n8n-nodes-base.httpRequest', 4.2, [220, 0],
    rpcParams(c, 'lq_v2_claim_notifications', '{"p_limit": 10, "p_lease_seconds": 120}'),
    { credentials: supabaseCred(c) });

  b.add('Split Claims', 'n8n-nodes-base.code', 2, [440, 0], {
    jsCode: 'return ($input.first().json.claims || []).map((c) => ({ json: c }));'
  });

  b.add('Send or Reconcile', 'n8n-nodes-base.if', 2, [660, 0], {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
      conditions: [{ id: stableId(name, 'cond-mode'), leftValue: '={{ $json.mode }}', rightValue: 'send', operator: { type: 'string', operation: 'equals' } }],
      combinator: 'and'
    },
    options: {}
  });

  b.add('Slack chat.postMessage', 'n8n-nodes-base.httpRequest', 4.2, [900, -160], slackParams(c, 'chat.postMessage', {
    method: 'POST',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ channel: $json.channel, text: $json.text, unfurl_links: false, unfurl_media: false, metadata: { event_type: 'lq_v2_notification', event_payload: { notification_id: $json.notification_id, correlation_id: $json.correlation_id } } }) }}"
  }), { credentials: slackCred(c) });

  const notify = bundle('notify.js');
  const recordFrom = (resultExpr) => [
    notify,
    '',
    '// ---- node ----',
    "const claim = $('Split Claims').item.json;",
    `const result = ${resultExpr};`,
    'const raw = $json.body;',
    "const provider_response = raw && typeof raw === 'object' ? raw : { raw: String(raw).slice(0, 2000) };",
    'return { json: { p_notification_id: claim.notification_id, p_attempt_no: claim.attempt_no, p_result: { ...result, provider_response } } };'
  ].join('\n');

  b.add('Classify Send Result', 'n8n-nodes-base.code', 2, [1140, -240], {
    mode: 'runOnceForEachItem',
    jsCode: recordFrom('classifySendResponse({ statusCode: $json.statusCode, body: $json.body })')
  });
  b.add('Record Send Result (RPC)', 'n8n-nodes-base.httpRequest', 4.2, [1380, -160],
    rpcParams(c, 'lq_v2_record_send_result', '={{ JSON.stringify($json) }}'),
    { credentials: supabaseCred(c) });

  b.add('Slack conversations.history', 'n8n-nodes-base.httpRequest', 4.2, [900, 160], slackParams(c, 'conversations.history', {
    method: 'GET',
    sendQuery: true,
    queryParameters: {
      parameters: [
        { name: 'channel', value: '={{ $json.channel }}' },
        { name: 'oldest', value: '={{ $json.oldest }}' },
        { name: 'include_all_metadata', value: 'true' },
        { name: 'limit', value: '200' }
      ]
    }
  }), { credentials: slackCred(c) });

  b.add('Classify Reconcile Result', 'n8n-nodes-base.code', 2, [1140, 80], {
    mode: 'runOnceForEachItem',
    jsCode: recordFrom('findReconciledMessage({ statusCode: $json.statusCode, body: $json.body }, claim.notification_id)')
  });
  b.add('Record Reconcile Result (RPC)', 'n8n-nodes-base.httpRequest', 4.2, [1380, 160],
    rpcParams(c, 'lq_v2_record_reconcile_result', '={{ JSON.stringify($json) }}'),
    { credentials: supabaseCred(c) });

  // A failed/uncertain notification that needs a human is a normal, successful
  // dispatcher run. Raise it as an error so the error workflow alerts ops.
  // State is already committed before this throws.
  b.add('Raise Operator Alert', 'n8n-nodes-base.code', 2, [1620, 0], {
    jsCode: [
      'const flagged = $input.all().map((i) => i.json.notification).filter((n) => n && n.operator_required);',
      'if (flagged.length) {',
      "  throw new Error('LQ v2 notification needs operator action: ' + flagged.map((n) => `${n.id} (${n.status})`).join(', '));",
      '}',
      'return $input.all();'
    ].join('\n')
  });

  b.connect('Every Minute', 'Claim Notifications (RPC)');
  b.connect('Claim Notifications (RPC)', 'Split Claims');
  b.connect('Split Claims', 'Send or Reconcile');
  b.connect('Send or Reconcile', 'Slack chat.postMessage', 0);
  b.connect('Send or Reconcile', 'Slack conversations.history', 1);
  b.connect('Slack chat.postMessage', 'Classify Send Result', 0);
  b.connect('Classify Send Result', 'Record Send Result (RPC)');
  b.connect('Slack conversations.history', 'Classify Reconcile Result', 0);
  b.connect('Classify Reconcile Result', 'Record Reconcile Result (RPC)');
  b.connect('Record Send Result (RPC)', 'Raise Operator Alert');
  b.connect('Record Reconcile Result (RPC)', 'Raise Operator Alert');

  // Runs every minute: keep only failed executions in n8n. Every delivery
  // outcome is already in lq_v2.delivery_attempts.
  const s = { ...settings(c), saveDataSuccessExecution: 'none' };
  return { name, nodes: b.nodes, connections: b.connections, settings: s, active: false, pinData: {}, meta: { lqVersion: VERSION } };
}

function buildErrorHandler(c) {
  const name = 'LQ v2 - Error Handler';
  const b = workflowBuilder(name);
  sticky(b, name,
    `## LQ v2 Error Handler (v${VERSION})\nSet as the error workflow of Intake and Dispatcher.\nAlerts Slack and logs to lq_v2.workflow_errors in parallel; each is best effort so one outage does not hide the other.\nReads the documented payload: execution.error, execution.lastNodeExecuted.`,
    [-80, -300], 220);

  b.add('Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {});
  b.add('Describe Error', 'n8n-nodes-base.code', 2, [220, 0], {
    jsCode: [
      bundle('notify.js'),
      '',
      '// ---- node ----',
      'const e = $input.first().json;',
      'const ex = e.execution || {};',
      'const err = ex.error || (e.trigger && e.trigger.error) || {};',
      'const info = {',
      "  workflow_name: (e.workflow && e.workflow.name) || null,",
      "  workflow_id: (e.workflow && e.workflow.id) || null,",
      '  execution_id: ex.id ? String(ex.id) : null,',
      '  execution_url: ex.url || null,',
      '  last_node: ex.lastNodeExecuted || null,',
      "  error_message: String(err.message || 'unknown error').slice(0, 2000),",
      '  mode: ex.mode || null',
      '};',
      'info.slack_text = [',
      "  ':rotating_light: *LQ v2 workflow error*',",
      '  `*Workflow:* ${slackEscape(info.workflow_name)}`,',
      '  `*Node:* ${slackEscape(info.last_node)}`,',
      '  `*Error:* ${slackEscape(info.error_message.slice(0, 500))}`,',
      '  `*Execution:* ${slackEscape(info.execution_id)}`',
      "].join('\\n');",
      'return [{ json: info }];'
    ].join('\n')
  });
  b.add('Slack Ops Alert', 'n8n-nodes-base.httpRequest', 4.2, [460, -100], {
    method: 'POST',
    url: `${c.LQ_V2_SLACK_API_BASE}/chat.postMessage`,
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'httpHeaderAuth',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ channel: ${JSON.stringify(c.LQ_V2_SLACK_OPS_CHANNEL_ID)}, text: $json.slack_text, unfurl_links: false }) }}`,
    // neverError: an HTTP failure here must not stop the database log branch.
    options: { timeout: 10000, response: { response: { neverError: true } } }
  }, { credentials: slackCred(c) });
  b.add('Log Error (RPC)', 'n8n-nodes-base.httpRequest', 4.2, [460, 100],
    { ...rpcParams(c, 'lq_v2_log_workflow_error', '={{ JSON.stringify({ p_error: $json }) }}'), options: { timeout: 15000, response: { response: { neverError: true } } } },
    { credentials: supabaseCred(c) });

  b.connect('Error Trigger', 'Describe Error');
  b.connect('Describe Error', 'Slack Ops Alert');
  b.connect('Describe Error', 'Log Error (RPC)');

  // The error workflow must not point at itself.
  const s = settings(c);
  delete s.errorWorkflow;
  return { name, nodes: b.nodes, connections: b.connections, settings: s, active: false, pinData: {}, meta: { lqVersion: VERSION } };
}

function buildAll(c) {
  return {
    'lq-v2-intake.json': buildIntake(c),
    'lq-v2-notification-dispatcher.json': buildDispatcher(c),
    'lq-v2-error-handler.json': buildErrorHandler(c)
  };
}

function main() {
  const args = process.argv.slice(2);
  const envIdx = args.indexOf('--env-file');
  const outIdx = args.indexOf('--out');
  let config;
  let outDir;
  if (envIdx >= 0) {
    config = deployConfig(parseEnvFile(args[envIdx + 1]));
    outDir = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'dist'));
    if (outDir.startsWith(path.join(ROOT, 'workflows'))) throw new Error('Deployable builds contain environment values; do not write them into workflows/');
  } else {
    config = placeholderConfig();
    outDir = path.join(ROOT, 'workflows', 'v2');
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, wf] of Object.entries(buildAll(config))) {
    fs.writeFileSync(path.join(outDir, file), JSON.stringify(wf, null, 2) + '\n');
    console.log('wrote', path.relative(ROOT, path.join(outDir, file)));
  }
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

module.exports = { buildAll, placeholderConfig, deployConfig, bundle, parseEnvFile };
