// Deterministic lead scoring, ported unchanged from the v1 "Calculate Scores" node
// (lead-qualification-production-v1.json). Weights, regexes, thresholds and the
// reason text are identical; test/unit/score-parity.test.js runs the original
// node code against the same fixtures to prove it.
//
// Only addition: `missing_inputs` in the breakdown, so a missing deal size is
// explicit instead of silently scoring 0.

const SCORE_VERSION = 'rule-based-v1';
const FIT_CALL_NOW = 80;
const FIT_NURTURE = 50;

function routeForFit(fit) {
  if (fit >= FIT_CALL_NOW) return 'call_now';
  if (fit >= FIT_NURTURE) return 'nurture';
  return 'manual_review';
}

function scoreLead(s) {
  s = s || {};

  // ============ FIT SCORE (0-100) ============
  let companySizeScore = 0;
  const employees = parseInt(s.employee_count) || 0;
  if (employees >= 1000) companySizeScore = 30;
  else if (employees >= 500) companySizeScore = 25;
  else if (employees >= 100) companySizeScore = 20;
  else if (employees >= 50) companySizeScore = 15;
  else if (employees >= 10) companySizeScore = 8;
  else if (employees > 0) companySizeScore = 3;
  else companySizeScore = 0;

  let titleScore = 0;
  const title = (s.job_title || '').toLowerCase();
  if (title.match(/^(ceo|cto|cfo|cmo|coo|chief|founder|owner|president)/)) titleScore = 40;
  else if (title.match(/(vp|vice president|director)/)) titleScore = 32;
  else if (title.match(/(head of|senior manager|sr\. manager)/)) titleScore = 25;
  else if (title.match(/manager/)) titleScore = 18;
  else if (title.match(/(lead|principal|senior)/)) titleScore = 12;
  else if (title.match(/(engineer|developer|analyst|specialist)/)) titleScore = 6;
  else titleScore = 0;

  let dealScore = 0;
  const dealSize = parseFloat(s.deal_size) || 0;
  if (dealSize >= 100000) dealScore = 30;
  else if (dealSize >= 50000) dealScore = 24;
  else if (dealSize >= 25000) dealScore = 18;
  else if (dealSize >= 10000) dealScore = 12;
  else if (dealSize > 0) dealScore = 6;
  else dealScore = 0;

  const fitScore = Math.min(100, companySizeScore + titleScore + dealScore);

  // ============ URGENCY SCORE (0-100) ============
  let sourceScore = 0;
  const source = (s.lead_source || '').toLowerCase();
  if (source.match(/referral|partner/)) sourceScore = 40;
  else if (source.match(/demo|request|pricing/)) sourceScore = 38;
  else if (source.match(/organic|search/)) sourceScore = 28;
  else if (source.match(/paid|ads|ppc/)) sourceScore = 22;
  else if (source.match(/social|linkedin|twitter/)) sourceScore = 18;
  else if (source.match(/email|campaign/)) sourceScore = 14;
  else sourceScore = 8;

  let conversionScore = 0;
  const firstConv = (s.first_conversion || '').toLowerCase();
  const recentConv = (s.recent_conversion || '').toLowerCase();
  if (firstConv.match(/demo|pricing|contact sales/)) conversionScore += 20;
  else if (firstConv.match(/trial|signup/)) conversionScore += 15;
  else if (firstConv.match(/whitepaper|ebook|webinar/)) conversionScore += 8;
  if (recentConv.match(/demo|pricing|contact sales/)) conversionScore += 15;
  else if (recentConv.match(/trial|signup/)) conversionScore += 10;
  conversionScore = Math.min(35, conversionScore);

  // v1 behavior preserved: timing always contributes 25.
  const timingScore = 25;

  const urgencyScore = Math.min(100, sourceScore + conversionScore + timingScore);

  const reason = [
    `FIT (${fitScore}/100): Company size ${companySizeScore}/30, Title ${titleScore}/40, Deal potential ${dealScore}/30.`,
    `URGENCY (${urgencyScore}/100): Source quality ${sourceScore}/40, Conversion signals ${conversionScore}/35, Timing ${timingScore}/25.`,
    `Recommendation: ${fitScore >= 80 ? 'HIGH PRIORITY - Call immediately' : fitScore >= 50 ? 'MEDIUM - Add to nurture sequence' : 'LOW - Manual review needed'}`
  ].join(' ');

  const missingInputs = ['employee_count', 'job_title', 'deal_size'].filter(
    (k) => s[k] === null || s[k] === undefined || s[k] === ''
  );

  return {
    fit: fitScore,
    urgency: urgencyScore,
    route: routeForFit(fitScore),
    reason: reason,
    score_version: SCORE_VERSION,
    breakdown: {
      fit: { company_size: companySizeScore, title: titleScore, deal_size: dealScore },
      urgency: { source: sourceScore, conversion: conversionScore, timing: timingScore },
      missing_inputs: missingInputs
    }
  };
}

// @export-start
module.exports = { scoreLead, routeForFit, SCORE_VERSION, FIT_CALL_NOW, FIT_NURTURE };
// @export-end
