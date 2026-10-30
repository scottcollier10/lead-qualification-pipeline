// Intake preparation: validate, score and render each event, producing the
// payloads sent to public.lq_v2_accept_batch. This is the full logic of the
// "Validate and Score" Code node; the build inlines it.

// @import-start
const { normalizeRequest } = require('./normalize');
const { scoreLead } = require('./score');
const { renderSlackText } = require('./notify');
// @import-end

function prepareIntake(body, config) {
  const { valid, invalid } = normalizeRequest(body);
  const events = valid.map((e) => {
    const score = scoreLead(e.scoring_input);
    return {
      ...e,
      score,
      notification: { target: config.slackChannelId, text: renderSlackText(e, score) }
    };
  });
  return { events, invalid };
}

// @export-start
module.exports = { prepareIntake };
// @export-end
