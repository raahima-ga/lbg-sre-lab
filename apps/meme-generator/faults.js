// Deliberate, controllable failure behaviour.
//
// Every lab scenario drives this module. Defaults are calibrated so that an
// UNTOUCHED environment sits just inside its SLO -- which is the state lab 05
// and lab 07's baseline steps depend on.
//
// Calibration (see BUILD.md sec 2.3 and sec 4.4):
//
//   SLO                     99.5% availability  -> 0.5% allowed error rate
//   Baseline failure rate   0.4%                -> burn rate 0.8x, inside budget
//   Of those failures, 60%  originate at caption-renderer (RQ-30)
//
//   caption-renderer share  0.4% * 0.60 = 0.24%  <- set on caption-renderer
//   own share               0.4% * 0.40 = 0.16%  <- set here
//
// The 60/40 split is not cosmetic: week 1 lab part B asks learners to model
// "fix caption-renderer entirely" and "caption-renderer failures double", and
// those answers only work if the dependency really is the majority cause.

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const state = {
  // Share of requests this service fails on its own (not via a dependency).
  ownErrorRate: num(process.env.OWN_ERROR_RATE, 0.0016),

  // Flat latency added to every request. Scenarios use this for broad slowdowns.
  addedLatencyMs: num(process.env.ADDED_LATENCY_MS, 0),

  // The "hot request" tail: a fraction of requests get a large extra delay.
  // This is what puts p95 near the 1500ms SLO without breaching it at rest.
  slowFraction: num(process.env.SLOW_FRACTION, 0.10),
  slowExtraMinMs: num(process.env.SLOW_EXTRA_MIN_MS, 600),
  slowExtraMaxMs: num(process.env.SLOW_EXTRA_MAX_MS, 1200),

  // Version-scoped faults. Lab 07 needs v2.4.2 to carry BOTH elevated errors
  // and the slow tail while v2.4.1 stays healthy, so faults can be pinned to a
  // single service.version rather than applied service-wide.
  faultVersion: process.env.FAULT_VERSION || null,
};

// Resolved from OTEL_RESOURCE_ATTRIBUTES so faults can target one version.
function currentVersion() {
  const attrs = process.env.OTEL_RESOURCE_ATTRIBUTES || '';
  const m = attrs.match(/service\.version=([^,]+)/);
  return m ? m[1] : 'unknown';
}

// A fault applies if it is untargeted, or targeted at the version we are.
function faultsApply() {
  return !state.faultVersion || state.faultVersion === currentVersion();
}

function get() {
  return { ...state, resolvedVersion: currentVersion(), active: faultsApply() };
}

// Admin surface. In Kubernetes the scenario-controller patches a ConfigMap and
// this is re-read; locally, scenarios POST to /_fault directly.
function set(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in state)) continue;
    state[k] = k === 'faultVersion' ? (v || null) : Number(v);
  }
  return get();
}

function reset() {
  return set({
    ownErrorRate: 0.0016,
    addedLatencyMs: 0,
    slowFraction: 0.10,
    slowExtraMinMs: 600,
    slowExtraMaxMs: 1200,
    faultVersion: null,
  });
}

// --- decisions taken per request ---

function shouldFailLocally() {
  return faultsApply() && Math.random() < state.ownErrorRate;
}

function plannedDelayMs() {
  if (!faultsApply()) return 0;
  const isSlow = Math.random() < state.slowFraction;
  const tail = isSlow
    ? state.slowExtraMinMs + Math.random() * (state.slowExtraMaxMs - state.slowExtraMinMs)
    : 0;
  return state.addedLatencyMs + tail;
}

module.exports = { get, set, reset, shouldFailLocally, plannedDelayMs, currentVersion };
