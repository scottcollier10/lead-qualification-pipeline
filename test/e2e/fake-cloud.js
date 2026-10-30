// Local stand-in for the two cloud services, used only by the local n8n e2e run.
//   /rest/v1/*  -> proxied to a local PostgREST (same path shape as Supabase)
//   /api/*      -> fake Slack Web API (chat.postMessage, conversations.history)
//   /_control/* -> test switches: Slack behavior plan, database outage,
//                  receipt-write failure, history outage
// Listens on all interfaces so the n8n container can reach it through
// host.docker.internal; run it only on a trusted dev machine. It never forwards
// anywhere except the local PostgREST.
const http = require('node:http');

const PORT = Number(process.env.FAKE_CLOUD_PORT || 54400);
const POSTGREST = process.env.FAKE_CLOUD_POSTGREST || 'http://127.0.0.1:54401';
const SLACK_TOKEN = 'Bearer xoxb-local-test';

let state;
function reset() {
  state = { messages: [], plan: [], dbDown: false, failRecordSend: false, historyDown: false, seq: 0, slackCalls: 0, rpcCalls: {} };
}
reset();

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});
const send = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postMessage(body) {
  const ts = `${Math.floor(Date.now() / 1000)}.${String(++state.seq).padStart(6, '0')}`;
  state.messages.push({ ts, channel: body.channel, text: body.text, metadata: body.metadata || null });
  return ts;
}

async function slack(req, res, url) {
  state.slackCalls++;
  if (req.headers.authorization !== SLACK_TOKEN) return send(res, 200, { ok: false, error: 'invalid_auth' });
  if (url.pathname === '/api/chat.postMessage') {
    const body = JSON.parse((await readBody(req)).toString() || '{}');
    const isOps = !body.metadata;
    const behavior = isOps ? 'ok' : state.plan.shift() || 'ok';
    switch (behavior) {
      case 'ok':
        return send(res, 200, { ok: true, channel: body.channel, ts: postMessage(body) });
      case 'ratelimited':
        return send(res, 429, { ok: false, error: 'ratelimited' });
      case 'channel_not_found':
        return send(res, 200, { ok: false, error: 'channel_not_found' });
      case 'http500_after_post':
        postMessage(body);
        return send(res, 500, { ok: false, error: 'internal_error' });
      case 'hang_after_post':
        postMessage(body);
        await sleep(15000);
        return send(res, 200, { ok: true, channel: body.channel, ts: 'late' });
      case 'hang_before_post':
        await sleep(15000);
        return send(res, 503, { ok: false });
      default:
        return send(res, 500, { error: 'unknown behavior ' + behavior });
    }
  }
  if (url.pathname === '/api/conversations.history') {
    if (state.historyDown) return send(res, 200, { ok: false, error: 'internal_error' });
    const channel = url.searchParams.get('channel');
    const oldest = Number(url.searchParams.get('oldest') || 0);
    const withMeta = url.searchParams.get('include_all_metadata') === 'true';
    const messages = state.messages
      .filter((m) => m.channel === channel && Number(m.ts) >= oldest)
      .reverse()
      .map((m) => (withMeta ? m : { ...m, metadata: undefined }));
    return send(res, 200, { ok: true, messages, has_more: false });
  }
  return send(res, 404, { ok: false, error: 'unknown_method' });
}

async function supabase(req, res, url) {
  const rpc = url.pathname.replace('/rest/v1/rpc/', '');
  state.rpcCalls[rpc] = (state.rpcCalls[rpc] || 0) + 1;
  if (state.dbDown) return send(res, 503, { message: 'local test: database unavailable' });
  if (state.failRecordSend && rpc === 'lq_v2_record_send_result') {
    return send(res, 503, { message: 'local test: receipt write failed' });
  }
  const body = await readBody(req);
  const target = POSTGREST + url.pathname.replace('/rest/v1', '') + url.search;
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  const r = await fetch(target, { method: req.method, headers, body: req.method === 'GET' ? undefined : body });
  res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

async function control(req, res, url) {
  if (url.pathname === '/_control/reset') {
    reset();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/_control/set') {
    Object.assign(state, JSON.parse((await readBody(req)).toString() || '{}'));
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/_control/state') return send(res, 200, state);
  return send(res, 404, {});
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) return await slack(req, res, url);
      if (url.pathname.startsWith('/rest/v1/')) return await supabase(req, res, url);
      if (url.pathname.startsWith('/_control/')) return await control(req, res, url);
      send(res, 404, {});
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  })
  .listen(PORT, '0.0.0.0', () => console.log(`fake-cloud listening on ${PORT}`));
