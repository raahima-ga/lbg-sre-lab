// Raw OTLP/HTTP JSON emitters.
//
// The SDK stamps every span with "now", which is useless for history. These
// builders take explicit timestamps so the seeder can place events at chosen
// points on a timeline.
//
// Payload shapes follow the OTLP/HTTP JSON encoding: resourceSpans,
// resourceMetrics, resourceLogs.

const ENDPOINT = process.env.OTLP_ENDPOINT || 'http://collector:4318';

const nano = (ms) => String(Math.round(ms * 1e6));
const hex = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return s;
};
const traceId = () => hex(16);
const spanId = () => hex(8);

const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({
      key,
      value:
        typeof v === 'number'
          ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
          : typeof v === 'boolean'
            ? { boolValue: v }
            : { stringValue: String(v) },
    }));

// The five required resource attributes, matching the live service exactly --
// seeded history must be indistinguishable from real traffic or lab 05's
// attribute check fails on historical spans.
function resource(service, extra = {}) {
  return {
    attributes: attrs({
      'service.name': service,
      'service.version': extra.version || 'v2.4.1',
      'deployment.environment': 'production',
      'cloud.region': 'europe-west2',
      team: 'meme-sre',
      'telemetry.sdk.language': 'nodejs',
      ...extra.attributes,
    }),
  };
}

// STATUS_CODE_UNSET = 0, OK = 1, ERROR = 2
function span({ service, name, startMs, durationMs, error = false, version, attributes = {} }) {
  const tid = traceId();
  const root = spanId();
  const child = spanId();

  const mk = (id, parent, spanName, svcOffset, svcDur, isErr) => ({
    traceId: tid,
    spanId: id,
    parentSpanId: parent,
    name: spanName,
    kind: parent ? 3 /* CLIENT */ : 2 /* SERVER */,
    startTimeUnixNano: nano(startMs + svcOffset),
    endTimeUnixNano: nano(startMs + svcOffset + svcDur),
    attributes: attrs({
      'http.route': name.startsWith('POST') ? '/generate' : '/templates',
      'http.request.method': name.split(' ')[0],
      'http.response.status_code': isErr ? 503 : 202,
      source: 'user',
      ...attributes,
    }),
    status: { code: isErr ? 2 : 1 },
  });

  return {
    resourceSpans: [{
      resource: resource(service, { version }),
      scopeSpans: [{
        scope: { name: service },
        spans: [
          mk(root, undefined, name, 0, durationMs, error),
          // A child hop, so seeded traces have a shape rather than being bare.
          mk(child, root, 'GET /templates', 20, Math.max(10, durationMs * 0.15), false),
        ],
      }],
    }],
  };
}

function gauge({ service, metrics, timeMs, attributes = {} }) {
  return {
    resourceMetrics: [{
      resource: resource(service),
      scopeMetrics: [{
        scope: { name: 'seeder' },
        metrics: Object.entries(metrics).map(([name, value]) => ({
          name,
          unit: '1',
          gauge: {
            dataPoints: [{
              timeUnixNano: nano(timeMs),
              startTimeUnixNano: nano(timeMs),
              asDouble: value,
              attributes: attrs(attributes),
            }],
          },
        })),
      }],
    }],
  };
}

function logRecord({ service, timeMs, level, message, attributes = {} }) {
  const sev = { INFO: 9, WARN: 13, ERROR: 17 }[level] || 9;
  return {
    resourceLogs: [{
      resource: resource(service),
      scopeLogs: [{
        scope: { name: service },
        logRecords: [{
          timeUnixNano: nano(timeMs),
          observedTimeUnixNano: nano(timeMs),
          severityNumber: sev,
          severityText: level,
          body: { stringValue: message },
          attributes: attrs(attributes),
          traceId: attributes.trace_id || undefined,
        }],
      }],
    }],
  };
}

async function send(kind, payload) {
  const path = { traces: '/v1/traces', metrics: '/v1/metrics', logs: '/v1/logs' }[kind];
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: text.slice(0, 300) };
}

module.exports = { send, span, gauge, logRecord, traceId, spanId, ENDPOINT };
