// Slack notification helpers: message rendering, send-result classification and
// reconciliation lookup. Pure functions; the n8n dispatcher does the HTTP calls.
// State machine: docs/v2/delivery-contract.md.

const METADATA_EVENT_TYPE = 'lq_v2_notification';

// Slack mrkdwn control characters. Escaping stops lead-supplied text from
// injecting mentions such as <!channel> or links.
function slackEscape(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function correlationIdFor(event) {
  return `lqv2:${event.source}:${event.source_event_id}`;
}

// Content preserved from the v1 "Send Slack Alert" node. The localhost
// workflow link is replaced by the correlation reference.
function renderSlackText(event, score) {
  const c = event.contact;
  return [
    '🔥 *HIGH PRIORITY LEAD - CALL NOW*',
    '',
    `*Name:* ${slackEscape(c.name)}`,
    `*Company:* ${slackEscape(c.company)}`,
    `*Email:* ${slackEscape(c.email)}`,
    '',
    `*Fit Score:* ${score.fit}/100`,
    `*Urgency Score:* ${score.urgency}/100`,
    '',
    `*Analysis:* ${slackEscape(score.reason)}`,
    '',
    `*Ref:* ${slackEscape(correlationIdFor(event))}`
  ].join('\n');
}

const RETRYABLE_SLACK_ERRORS = new Set(['ratelimited', 'rate_limited', 'service_unavailable']);
const AMBIGUOUS_SLACK_ERRORS = new Set(['internal_error', 'fatal_error', 'request_timeout']);
// Network errors where the request cannot have reached Slack. Includes n8n's
// humanized wording for a refused connection. Everything else (n8n reports
// timeouts as "The connection was aborted...") stays uncertain.
const NOT_DELIVERED_NETWORK_RE = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|CERT_|certificate|refused the connection/i;

function parseBody(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }
  return body && typeof body === 'object' ? body : null;
}

// Input: { statusCode, body } for an HTTP response, or { error } when no
// response arrived. Output outcome is one of:
//   sent | retryable_failure | permanent_failure | uncertain
// Anything we cannot prove either way is "uncertain", never "failed".
function classifySendResponse({ statusCode, body, error }) {
  if (error !== undefined && error !== null && statusCode === undefined) {
    const text = typeof error === 'string' ? error : JSON.stringify(error);
    if (NOT_DELIVERED_NETWORK_RE.test(text)) {
      return { outcome: 'retryable_failure', provider_error: 'network: ' + text.slice(0, 300) };
    }
    return { outcome: 'uncertain', provider_error: 'no response: ' + text.slice(0, 300) };
  }

  const b = parseBody(body);
  if (statusCode === 429) return { outcome: 'retryable_failure', provider_error: 'ratelimited', http_status: 429 };
  if (statusCode >= 500) return { outcome: 'uncertain', provider_error: `http_${statusCode}`, http_status: statusCode };
  if (statusCode >= 400) {
    return { outcome: 'permanent_failure', provider_error: (b && b.error) || `http_${statusCode}`, http_status: statusCode };
  }
  if (!b) return { outcome: 'uncertain', provider_error: 'unparseable_response', http_status: statusCode };

  if (b.ok === true) {
    if (typeof b.ts === 'string' && b.ts && typeof b.channel === 'string' && b.channel) {
      return { outcome: 'sent', message_ts: b.ts, provider_channel: b.channel, http_status: statusCode };
    }
    // Slack says ok but gave no receipt: it probably posted. Reconcile.
    return { outcome: 'uncertain', provider_error: 'ok_without_receipt', http_status: statusCode };
  }
  const err = typeof b.error === 'string' ? b.error : 'unknown_error';
  if (RETRYABLE_SLACK_ERRORS.has(err)) return { outcome: 'retryable_failure', provider_error: err, http_status: statusCode };
  if (AMBIGUOUS_SLACK_ERRORS.has(err)) return { outcome: 'uncertain', provider_error: err, http_status: statusCode };
  return { outcome: 'permanent_failure', provider_error: err, http_status: statusCode };
}

// Looks for our message in a conversations.history response.
// found: message exists (with ts). not_found: conclusive absence.
// reconcile_error: could not decide (API error or more pages to read).
function findReconciledMessage({ statusCode, body, error }, notificationId) {
  if (error !== undefined && error !== null && statusCode === undefined) {
    return { outcome: 'reconcile_error', provider_error: 'no response: ' + String(typeof error === 'string' ? error : JSON.stringify(error)).slice(0, 300) };
  }
  const b = parseBody(body);
  if (!b || b.ok !== true || !Array.isArray(b.messages)) {
    return { outcome: 'reconcile_error', provider_error: (b && b.error) || `http_${statusCode}`, http_status: statusCode };
  }
  const hit = b.messages.find(
    (m) =>
      m &&
      m.metadata &&
      m.metadata.event_type === METADATA_EVENT_TYPE &&
      m.metadata.event_payload &&
      m.metadata.event_payload.notification_id === notificationId
  );
  if (hit) return { outcome: 'found', message_ts: hit.ts, http_status: statusCode };
  if (b.has_more) return { outcome: 'reconcile_error', provider_error: 'inconclusive_more_pages', http_status: statusCode };
  return { outcome: 'not_found', http_status: statusCode };
}

// @export-start
module.exports = {
  slackEscape,
  correlationIdFor,
  renderSlackText,
  classifySendResponse,
  findReconciledMessage,
  METADATA_EVENT_TYPE
};
// @export-end
