// Validates and normalizes intake requests. Contract: docs/v2/event-contract.md.
// Pure function: no I/O, no clock. Every rejected event is reported with its
// index and reasons; nothing invalid reaches the database.

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_EVENT_BYTES = 20000;
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const SOURCE_RE = /^[a-z0-9_-]{1,40}$/;
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

// field -> [accepted input names (first match wins), max length]
const TEXT_FIELDS = {
  first_name: [['first_name', 'firstName'], 100],
  last_name: [['last_name', 'lastName'], 100],
  phone: [['phone'], 50],
  company: [['company'], 200],
  website: [['website'], 255],
  industry: [['industry'], 100],
  job_title: [['job_title', 'jobTitle'], 200],
  lead_source: [['lead_source', 'leadSource'], 100],
  first_conversion: [['first_conversion', 'firstConversion'], 200],
  recent_conversion: [['recent_conversion', 'recentConversion'], 200],
  message: [['message'], 5000]
};

function pick(obj, names) {
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null) return { name: n, value: obj[n] };
  }
  return { name: names[0], value: null };
}

function readText(ev, names, maxLen, errors) {
  const { name, value } = pick(ev, names);
  if (value === null) return null;
  if (typeof value !== 'string') {
    errors.push({ field: name, problem: 'must be a string' });
    return null;
  }
  const v = value.trim();
  if (v.length > maxLen) {
    errors.push({ field: name, problem: `must be at most ${maxLen} characters` });
    return null;
  }
  return v === '' ? null : v;
}

function readNumber(ev, names, { integer }, errors) {
  const { name, value } = pick(ev, names);
  if (value === null || value === '') return null;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(value)) n = Number(value);
  else {
    errors.push({ field: name, problem: 'must be a non-negative number' });
    return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > 1e12) {
    errors.push({ field: name, problem: 'must be a non-negative number' });
    return null;
  }
  if (integer && !Number.isInteger(n)) {
    errors.push({ field: name, problem: 'must be a whole number' });
    return null;
  }
  return n;
}

function normalizeEvent(ev) {
  const errors = [];
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    return { errors: [{ field: '(event)', problem: 'must be a JSON object' }] };
  }
  if (JSON.stringify(ev).length > MAX_EVENT_BYTES) {
    return { errors: [{ field: '(event)', problem: `must be at most ${MAX_EVENT_BYTES} bytes` }] };
  }

  let sourceEventId = null;
  if (typeof ev.source_event_id !== 'string' || !EVENT_ID_RE.test(ev.source_event_id)) {
    errors.push({ field: 'source_event_id', problem: 'required; 1-200 chars of A-Z a-z 0-9 . _ : -' });
  } else {
    sourceEventId = ev.source_event_id;
  }

  let source = 'synthetic';
  if (ev.source !== undefined && ev.source !== null) {
    if (typeof ev.source !== 'string' || !SOURCE_RE.test(ev.source)) {
      errors.push({ field: 'source', problem: '1-40 chars of a-z 0-9 _ -' });
    } else {
      source = ev.source;
    }
  }

  let occurredAt = null;
  if (ev.occurred_at !== undefined && ev.occurred_at !== null) {
    const t = typeof ev.occurred_at === 'string' ? Date.parse(ev.occurred_at) : NaN;
    if (Number.isNaN(t)) errors.push({ field: 'occurred_at', problem: 'must be an ISO 8601 timestamp' });
    else occurredAt = new Date(t).toISOString();
  }

  let email = null;
  if (typeof ev.email !== 'string') {
    errors.push({ field: 'email', problem: 'required string' });
  } else {
    const e = ev.email.trim().toLowerCase();
    if (e.length === 0 || e.length > 254 || !EMAIL_RE.test(e)) {
      errors.push({ field: 'email', problem: 'must be a valid email address' });
    } else {
      email = e;
    }
  }

  let crmObjectId = null;
  if (ev.crm_object_id !== undefined && ev.crm_object_id !== null) {
    const v = ev.crm_object_id;
    if ((typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)) || (Number.isInteger(v) && v >= 0)) {
      crmObjectId = String(v);
    } else {
      errors.push({ field: 'crm_object_id', problem: 'string or integer id, max 64 chars' });
    }
  }

  const text = {};
  for (const [field, [names, maxLen]] of Object.entries(TEXT_FIELDS)) {
    text[field] = readText(ev, names, maxLen, errors);
  }
  const employeeCount = readNumber(ev, ['employee_count', 'employeeCount'], { integer: true }, errors);
  const dealSize = readNumber(ev, ['deal_size', 'dealSize'], { integer: false }, errors);

  if (errors.length) return { source_event_id: sourceEventId, errors };

  const name = [text.first_name, text.last_name].filter(Boolean).join(' ') || null;
  return {
    event: {
      source,
      source_event_id: sourceEventId,
      occurred_at: occurredAt,
      contact: {
        email,
        crm_object_id: crmObjectId,
        name,
        phone: text.phone,
        company: text.company,
        website: text.website,
        industry: text.industry,
        job_title: text.job_title,
        employee_count: employeeCount,
        deal_size: dealSize
      },
      // Exactly what the scorer sees; persisted with the score.
      scoring_input: {
        employee_count: employeeCount,
        job_title: text.job_title,
        deal_size: dealSize,
        lead_source: text.lead_source || 'unknown',
        first_conversion: text.first_conversion,
        recent_conversion: text.recent_conversion
      },
      message: text.message,
      raw: ev
    }
  };
}

// body: one event object, or an array of 1..MAX_EVENTS_PER_REQUEST events.
function normalizeRequest(body) {
  let list;
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MAX_EVENTS_PER_REQUEST) {
      return {
        valid: [],
        invalid: [{ index: null, source_event_id: null, errors: [{ field: '(body)', problem: `array must hold 1-${MAX_EVENTS_PER_REQUEST} events` }] }]
      };
    }
    list = body;
  } else if (body !== null && typeof body === 'object') {
    list = [body];
  } else {
    return {
      valid: [],
      invalid: [{ index: null, source_event_id: null, errors: [{ field: '(body)', problem: 'must be a JSON object or array' }] }]
    };
  }

  const valid = [];
  const invalid = [];
  list.forEach((ev, index) => {
    const r = normalizeEvent(ev);
    if (r.errors) {
      invalid.push({ index, source_event_id: r.source_event_id || null, errors: r.errors });
      return;
    }
    r.event.index = index;
    valid.push(r.event);
  });
  return { valid, invalid };
}

// @export-start
module.exports = { normalizeRequest, normalizeEvent, MAX_EVENTS_PER_REQUEST };
// @export-end
