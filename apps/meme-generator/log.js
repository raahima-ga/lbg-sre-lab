// Structured logging. Every line goes to stdout as JSON *and* into the OTel log
// pipeline, with trace_id and span_id pulled from the active span context.
//
// This is what lab 05 step 4 (log <-> trace correlation) checks: open a trace,
// switch to the Logs tab, and the log lines must carry the same trace_id.
//
// Contrast with template-store and caption-renderer, which log unstructured
// text on purpose.
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');
const { trace, context } = require('@opentelemetry/api');

const logger = logs.getLogger('meme-generator');
const SEV = {
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
};

function log(level, message, attrs = {}) {
  const span = trace.getSpan(context.active());
  const ctx = span && span.spanContext();

  // stdout: JSON, one object per line, for kubectl logs and the collector's
  // filelog receiver.
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    trace_id: ctx ? ctx.traceId : undefined,
    span_id: ctx ? ctx.spanId : undefined,
    ...attrs,
  }));

  // OTLP: trace context is attached automatically from the active context.
  logger.emit({
    severityNumber: SEV[level] || SeverityNumber.INFO,
    severityText: level,
    body: message,
    attributes: attrs,
  });
}

module.exports = { log };
