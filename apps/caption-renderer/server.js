// caption-renderer -- the legacy-style dependency.
//
// ======================== DELIBERATELY UNINSTRUMENTED ========================
// This service emits NO telemetry whatsoever:
//
//   no OpenTelemetry SDK   -- look at package.json: express, nothing else
//   no OneAgent            -- in GCP it runs on a GCE MIG outside the cluster,
//                             with no agent and no Ops Agent log sink
//   no metrics endpoint
//   no structured logs     -- stdout only, and in GCP nothing collects it
//
// Consequence: in Dynatrace this service has no server span, no service entity
// and no logs. The ONLY evidence about it anywhere in the system is the client
// span on meme-generator.
//
// That asymmetry is the point. It is the stand-in for Lloyds' on-prem and
// mainframe estate, and four separate teaching goals depend on it:
//
//   week 2   FMEA detectability scoring of a genuine black box
//   week 2   part C, the hybrid GCP + on-prem observability gap
//   lab 05   "where traces break" at an instrumentation boundary
//   week 5   the legacy-dependency chaos target
//
// Because it sits outside the cluster, Chaos Mesh cannot reach it. Faults are
// injected through the admin endpoint below instead.
//
// DO NOT INSTRUMENT THIS SERVICE.
// =============================================================================
const express = require('express');

const app = express();
app.use(express.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- capacity model -----------------------------------------------------------
// A fixed connection pool, sized so that baseline load is comfortable and ~3x
// load exhausts it. This is the capacity failure mode week 2 asks learners to
// mitigate with an HPA, and its acceptance criterion is a load test at 3x.
//
//   baseline 25 rps x ~0.3s render  = ~7.5 concurrent
//   3x load  75 rps x ~0.3s render  = ~22.5 concurrent  -> at the limit
//
// When the pool is full this returns 503 immediately rather than queueing. A
// queue would show up as latency; exhaustion shows up as errors. Both are real
// failure modes, and this one is the one week 2's incident case study mirrors
// (connection pool limit not raised after a demand surge).
let poolSize = Number(process.env.POOL_SIZE || 24);
let inFlight = 0;
let rejected = 0;

// --- injectable faults --------------------------------------------------------
let addedLatencyMs = Number(process.env.ADDED_LATENCY_MS || 0);
let errorRate = Number(process.env.ERROR_RATE || 0.0024); // see meme-generator/faults.js

app.get('/health', (req, res) => res.sendStatus(200));

// Admin surface. The scenario controller drives this for week 5's latency
// injection, since Istio and Chaos Mesh cannot reach an off-cluster VM.
app.get('/_admin/fault', (req, res) =>
  res.json({ poolSize, inFlight, rejected, addedLatencyMs, errorRate })
);
app.post('/_admin/fault', (req, res) => {
  const b = req.body || {};
  if (b.poolSize !== undefined) poolSize = Number(b.poolSize);
  if (b.addedLatencyMs !== undefined) addedLatencyMs = Number(b.addedLatencyMs);
  if (b.errorRate !== undefined) errorRate = Number(b.errorRate);
  console.log(`fault config: pool=${poolSize} latency=${addedLatencyMs} error=${errorRate}`);
  res.json({ poolSize, addedLatencyMs, errorRate });
});
app.post('/_admin/fault/reset', (req, res) => {
  poolSize = Number(process.env.POOL_SIZE || 24);
  addedLatencyMs = 0;
  errorRate = 0.0024;
  rejected = 0;
  console.log('fault config reset');
  res.json({ poolSize, addedLatencyMs, errorRate });
});

app.post('/render', async (req, res) => {
  if (inFlight >= poolSize) {
    rejected += 1;
    // Unstructured, and in GCP nobody is collecting it. A learner cannot find
    // this line -- they can only infer it from the caller's client span.
    console.log(`render rejected: pool exhausted ${inFlight}/${poolSize}`);
    return res.sendStatus(503);
  }

  inFlight += 1;
  try {
    await sleep(200 + Math.random() * 200 + addedLatencyMs);

    if (Math.random() < errorRate) {
      console.log(`render failed ${req.body?.meme_id || '?'}`);
      return res.sendStatus(503);
    }

    console.log(`render ok ${req.body?.meme_id || '?'} ${inFlight}/${poolSize}`);
    return res.status(200).json({ url: `https://memes.lab.internal/${req.body?.meme_id}.png` });
  } finally {
    inFlight -= 1;
  }
});

app.listen(8082, () => console.log(`caption-renderer listening on 8082 (pool=${poolSize})`));
