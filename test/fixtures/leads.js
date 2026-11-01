// Synthetic lead fixtures. Expected scores are derived from the v1 rules and
// cross-checked against the original node code in score-parity.test.js.
// `runTag` makes event IDs and emails unique per test run, so repeated runs
// never need a broad database cleanup.

function lead(runTag, key, fields) {
  return {
    source: 'synthetic',
    source_event_id: `${runTag}-${key}`,
    occurred_at: '2026-10-30T12:00:00.000Z',
    email: `${key}+${runTag}@example.test`,
    ...fields
  };
}

const PROFILES = {
  // Verification report section 2 example: fit 100, urgency 65, call_now.
  highFit: { first_name: 'Ada', last_name: 'Founder', company: 'Big Co', job_title: 'CEO', employee_count: 1000, deal_size: 100000, lead_source: 'referral' },
  // Verification report: VP / 250 employees / no deal scores 52, not high fit.
  vpNoDeal: { first_name: 'Val', last_name: 'Vp', company: 'Mid Co', job_title: 'VP Sales', employee_count: 250 },
  fit80: { job_title: 'VP Marketing', employee_count: 1000, deal_size: 25000, company: 'Eighty Inc' },
  fit79: { job_title: 'Head of Ops', employee_count: 1000, deal_size: 50000, company: 'Seventy Nine Inc' },
  fit50: { job_title: 'Manager', employee_count: 100, deal_size: 10000, company: 'Fifty LLC' },
  fit49: { job_title: 'Lead Engineer', employee_count: 500, deal_size: 10000, company: 'Forty Nine LLC' }
};

const EXPECTED = {
  highFit: { fit: 100, urgency: 65, route: 'call_now' },
  vpNoDeal: { fit: 52, urgency: 33, route: 'nurture' },
  fit80: { fit: 80, route: 'call_now' },
  fit79: { fit: 79, route: 'nurture' },
  fit50: { fit: 50, route: 'nurture' },
  fit49: { fit: 49, route: 'manual_review' }
};

function newRunTag() {
  return 'run' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = { lead, PROFILES, EXPECTED, newRunTag };
