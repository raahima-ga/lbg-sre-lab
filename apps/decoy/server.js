// Decoy services for lab 12 part 1.
//
// Lab 12 opens with a Copilot-generated query whose failure is selectivity:
//
//     where event_type = "GENERATE_FAILED"
//       and service_name like "meme*"
//
// That over-match is only real if there are other services whose names start
// with "meme" and which genuinely emit GENERATE_FAILED events. Without them the
// learner is told the query is too broad and has to take it on faith. With
// them, they run it and SEE the extra services in the results.
//
// Run twice from the same image:
//
//   meme-generator-canary   a canary deployment of the real service
//   meme-worker             an async background generator
//
// Both are legitimate parts of a plausible estate. Neither is the
// customer-facing path the SLI is supposed to measure, which is exactly why
// including them corrupts the number.
const express = require('express');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
const { trace, context } = require('@opentelemetry/api');

const NAME = process.env.OTEL_SERVICE_NAME || 'decoy';
const ROLE = process.env.DECOY_ROLE || 'worker';
const FAIL_EVERY_MS = Number(process.env.FAIL_EVERY_MS || 45000);
const ERROR_CODES = ['TEMPLATE_MISSING', 'RENDER_TIMEOUT', 'QUOTA_EXCEEDED'];

const logger = logs.getLogger(NAME);
const app = express();
app.use(express.json());

function emit(level, message, attrs) {
  const span = trace.getSpan(context.active());
  const ctx = span && span.spanContext();
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(), level, message,
    service_name: NAME, trace_id: ctx ? ctx.traceId : undefined, ...attrs,
  }));
  logger.emit({
    severityNumber: level === 'ERROR' ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: level,
    body: message,
    attributes: { service_name: NAME, ...attrs },
  });
}

app.get('/health', (req, res) => res.sendStatus(200));
app.get('/readyz', (req, res) => res.sendStatus(200));

// Background work, with the occasional failure event. Emitting on a timer
// rather than per-request keeps these services cheap -- they exist to be found
// by a query, not to carry load.
setInterval(() => {
  emit('ERROR', 'Meme generation failed', {
    event_type: 'GENERATE_FAILED',
    error_code: ERROR_CODES[Math.floor(Math.random() * ERROR_CODES.length)],
    role: ROLE,
  });
}, FAIL_EVERY_MS);

setInterval(() => {
  emit('INFO', 'Batch cycle complete', { event_type: 'CYCLE_COMPLETE', role: ROLE });
}, 120000);

const port = Number(process.env.PORT || 8095);
app.listen(port, () => emit('INFO', `${NAME} listening on ${port}`, { role: ROLE }));
