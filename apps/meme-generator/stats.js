// Rolling SLI counters.
//
// The scenario controller needs a live burn rate in order to ENFORCE stop
// conditions (RQ-22, and lab 09 part 1 step 3). In GCP that number comes from
// the Dynatrace SLO API. Locally there is no tenant, so the service exposes the
// same arithmetic over its own traffic and the controller reads that instead.
// Same contract, swappable source.
//
// Only source=user traffic counts. Probes, synthetic checks and the batch job
// are excluded here for exactly the reason lab 06 part 4 teaches: they are not
// customer-initiated, and counting them lets the SLI look healthy while
// customers are failing.

const WINDOW_SECONDS = 300;
const SLO_TARGET = Number(process.env.SLO_TARGET || 0.995);
const SLO_LATENCY_MS = Number(process.env.SLO_LATENCY_MS || 1500);
const ALLOWED_ERROR_RATE = 1 - SLO_TARGET;

// One bucket per second, indexed by epoch second modulo the window.
const buckets = new Array(WINDOW_SECONDS).fill(null).map(() => ({ sec: -1, total: 0, errors: 0, slow: 0 }));

function bucket() {
  const sec = Math.floor(Date.now() / 1000);
  const b = buckets[sec % WINDOW_SECONDS];
  if (b.sec !== sec) { b.sec = sec; b.total = 0; b.errors = 0; b.slow = 0; }
  return b;
}

function record({ source, status, durationMs, sloLatencyMs = SLO_LATENCY_MS }) {
  if (source !== 'user') return;          // SLI scope
  const b = bucket();
  b.total += 1;
  if (status >= 500) b.errors += 1;
  if (durationMs > sloLatencyMs) b.slow += 1;
}

function summary(seconds = WINDOW_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const floor = now - seconds;
  let total = 0, errors = 0, slow = 0;
  for (const b of buckets) {
    if (b.sec >= floor) { total += b.total; errors += b.errors; slow += b.slow; }
  }
  const errorRate = total ? errors / total : 0;
  return {
    window_seconds: seconds,
    slo_target: SLO_TARGET,
    slo_latency_ms: SLO_LATENCY_MS,
    allowed_error_rate: ALLOWED_ERROR_RATE,
    requests: total,
    errors,
    slow_requests: slow,
    observed_error_rate: errorRate,
    availability: total ? 1 - errorRate : 1,
    // The number every burn-rate lab turns on.
    burn_rate: ALLOWED_ERROR_RATE ? errorRate / ALLOWED_ERROR_RATE : 0,
  };
}

module.exports = { record, summary };
