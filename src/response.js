// Builds the intake HTTP response from validation rejects and database results.
// Status rules (docs/v2/event-contract.md):
//   202 every event accepted or duplicate
//   400 nothing accepted, all invalid/rejected
//   409 nothing accepted, all conflicts (event id reused with different payload)
//   207 mixed
//   503 database did not confirm acceptance (built separately in the workflow)

function buildIntakeResponse(invalid, dbResults) {
  const results = [
    ...invalid.map((r) => ({ index: r.index, source_event_id: r.source_event_id, outcome: 'invalid', errors: r.errors })),
    ...(dbResults || [])
  ].sort((a, b) => (a.index === null ? -1 : b.index === null ? 1 : a.index - b.index));

  const ok = results.filter((r) => r.outcome === 'accepted' || r.outcome === 'duplicate').length;
  const bad = results.length - ok;
  let statusCode;
  if (bad === 0) statusCode = 202;
  else if (ok > 0) statusCode = 207;
  else if (results.every((r) => r.outcome === 'conflict')) statusCode = 409;
  else statusCode = 400;

  return { statusCode, body: { status: statusCode, results } };
}

// @export-start
module.exports = { buildIntakeResponse };
// @export-end
