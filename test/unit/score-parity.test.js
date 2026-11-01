// Regression parity: the v2 scorer must produce exactly what the original v1
// "Calculate Scores" node produces, for the same scoring input. The original
// code is read from the untouched v1 export and executed with a stub $input.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { scoreLead, routeForFit } = require('../../src/score');
const { normalizeEvent } = require('../../src/normalize');
const { PROFILES, EXPECTED, lead } = require('../fixtures/leads');

const v1 = JSON.parse(fs.readFileSync(path.join(__dirname, '../../lead-qualification-production-v1.json'), 'utf8'));
const v1Code = v1.nodes.find((n) => n.name === 'Calculate Scores').parameters.jsCode;
const runV1 = (scoringData) => new Function('$input', v1Code)({ first: () => ({ json: { scoring_data: scoringData } }) })[0].json;

const extraCases = [
  {},
  { job_title: 'Chief Revenue Officer', employee_count: 12, deal_size: 5, lead_source: 'paid ads', first_conversion: 'Free trial', recent_conversion: 'pricing page' },
  { job_title: 'Senior Manager', employee_count: 60, deal_size: 9999.99, lead_source: 'Organic Search', first_conversion: 'Demo request', recent_conversion: 'Contact Sales' },
  { job_title: 'data analyst', employee_count: 3, lead_source: 'linkedin', first_conversion: 'webinar' },
  { job_title: 'Sr. Manager', employee_count: 99, deal_size: 24999, lead_source: 'email campaign', recent_conversion: 'signup' },
  { job_title: 'Founder', employee_count: 0, deal_size: 0, lead_source: 'partner' }
];

test('v2 scorer matches original v1 node code for every fixture', () => {
  const inputs = [
    ...Object.keys(PROFILES).map((k) => normalizeEvent(lead('parity', k, PROFILES[k])).event.scoring_input),
    ...extraCases
  ];
  for (const input of inputs) {
    const original = runV1(input);
    const v2 = scoreLead(input);
    assert.equal(v2.fit, original.fit, JSON.stringify(input));
    assert.equal(v2.urgency, original.urgency, JSON.stringify(input));
    assert.equal(v2.reason, original.reason, JSON.stringify(input));
    assert.deepEqual(v2.breakdown.fit, original.score_breakdown.fit);
    assert.deepEqual(v2.breakdown.urgency, original.score_breakdown.urgency);
    assert.equal(v2.score_version, original.model);
  }
});

test('fixture profiles produce the documented scores and routes', () => {
  for (const [key, exp] of Object.entries(EXPECTED)) {
    const s = scoreLead(normalizeEvent(lead('t', key, PROFILES[key])).event.scoring_input);
    assert.equal(s.fit, exp.fit, key);
    if (exp.urgency !== undefined) assert.equal(s.urgency, exp.urgency, key);
    assert.equal(s.route, exp.route, key);
  }
});

test('routing boundaries 49/50/79/80 are exact and stable across runs', () => {
  const table = { 0: 'manual_review', 49: 'manual_review', 50: 'nurture', 79: 'nurture', 80: 'call_now', 100: 'call_now' };
  for (let run = 0; run < 3; run++) {
    for (const [fit, route] of Object.entries(table)) assert.equal(routeForFit(Number(fit)), route);
  }
});

test('missing deal size is explicit in the breakdown', () => {
  const s = scoreLead(normalizeEvent(lead('t', 'vpNoDeal', PROFILES.vpNoDeal)).event.scoring_input);
  assert.equal(s.fit, 52);
  assert.deepEqual(s.breakdown.missing_inputs, ['deal_size']);
});
