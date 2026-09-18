// Backfill + timeline manifest.
//
// HOW HISTORY ACTUALLY GETS THERE. Three mechanisms, in order of how much
// history they can produce:
//
//   1. CONTINUOUS RUNNING  -- the primary mechanism, and the only one that
//      yields days or weeks. The environment persists for the cohort's six
//      weeks (BUILD.md sec 11.1), so history accrues in real time. This is why
//      "labs tear down after each session" had to be amended: a torn-down
//      environment has no past, and lab 05 step 6 and lab 07 part 4 both read
//      one.
//
//   2. BACKFILL (this module) -- fills the tenant's accepted backdate window,
//      typically around an hour. Enough to make a freshly provisioned
//      environment non-empty for a first session; not enough for "last 24
//      hours". Run `probe` first to learn the real ceiling.
//
//   3. THE COURSE ITSELF -- weeks 3 to 5 generate real Problems via the
//      scenarios, and those become lab 12's 7-day MTTR sample. Dynatrace
//      Problems cannot be synthesised, so this is the ONLY way lab 12 part 3
//      gets a population to measure. It also means lab 12 needs weeks 3-5 to
//      have actually run.
//
// The manifest records every placed event so an instructor can tell learners
// which timeframe to select, and so lab 05 step 6's "step at rollout" has a
// real timestamp instead of a hope.

const fs = require('fs');
const { send, span, gauge, logRecord } = require('./otlp');

const MANIFEST = process.env.MANIFEST_PATH || '/state/timeline.json';

const SLO_LATENCY_MS = 1500;
const BASELINE_ERROR_RATE = 0.004;   // burn rate 0.8x against a 99.5% SLO
const DEPENDENCY_SHARE = 0.60;       // RQ-30

// Latency profile matching the live service: mostly quick, 10% hot tail.
function sampleDuration() {
  const base = 300 + Math.random() * 300;
  return Math.random() < 0.10 ? base + 600 + Math.random() * 600 : base;
}

async function backfill({ hours = 1, rps = 25, stepAtMinutesAgo = 45 }) {
  const now = Date.now();
  const startMs = now - hours * 3600_000;
  const events = [];

  console.log(`backfilling ${hours}h at ${rps} rps nominal, CPU/memory step ${stepAtMinutesAgo}m ago`);
  console.log('(anything the tenant rejects as too old is dropped silently -- run `probe` first)\n');

  // --- request history -------------------------------------------------------
  // One representative span+log per second rather than per request: enough to
  // populate charts and the Services list without shipping 90k spans/hour of
  // synthetic data into a lab tenant.
  let sent = 0, errors = 0;
  for (let t = startMs; t < now; t += 1000) {
    const isError = Math.random() < BASELINE_ERROR_RATE;
    const cause = isError && Math.random() < DEPENDENCY_SHARE ? 'caption-renderer' : 'internal';
    const dur = isError ? 120 + Math.random() * 200 : sampleDuration();

    await send('traces', span({
      service: 'meme-generator',
      name: 'POST /generate',
      startMs: t,
      durationMs: dur,
      error: isError,
      attributes: { seeded: true, 'meme.id': `MEME-${Math.floor(1000 + Math.random() * 9000)}` },
    }));

    if (isError) {
      errors += 1;
      await send('logs', logRecord({
        service: 'meme-generator',
        timeMs: t,
        level: 'ERROR',
        message: 'Meme generation failed',
        attributes: { cause, seeded: true },
      }));
    }
    sent += 1;
    if (sent % 300 === 0) console.log(`  ${sent} seconds placed (${errors} errors)`);
  }

  // --- host metrics, with the instrumentation footprint step -----------------
  // Lab 05 step 6: "the CPU and Memory tiles show a small step at rollout --
  // the instrumentation footprint. Still climbing is a failure."
  //
  // So the step must be a STEP: a one-off rise to a new flat level, not a ramp.
  // A ramp is the failure signature the lab asks learners to distinguish.
  const stepMs = now - stepAtMinutesAgo * 60_000;
  const CPU_BEFORE = 0.21, CPU_AFTER = 0.26;     // ~5 points: an agent footprint
  const MEM_BEFORE = 0.47, MEM_AFTER = 0.52;

  for (let t = startMs; t < now; t += 15_000) {
    const after = t >= stepMs;
    await send('metrics', gauge({
      service: 'meme-generator',
      timeMs: t,
      metrics: {
        'system.cpu.utilization': (after ? CPU_AFTER : CPU_BEFORE) + (Math.random() - 0.5) * 0.02,
        'system.memory.utilization': (after ? MEM_AFTER : MEM_BEFORE) + (Math.random() - 0.5) * 0.015,
      },
      attributes: { seeded: true, instrumented: after },
    }));
  }

  events.push({
    event: 'instrumentation_rollout',
    at: new Date(stepMs).toISOString(),
    detail: `CPU ${CPU_BEFORE} -> ${CPU_AFTER}, memory ${MEM_BEFORE} -> ${MEM_AFTER}, flat after`,
    lab: '05 part 1 step 6',
  });
  events.push({
    event: 'backfill_window',
    from: new Date(startMs).toISOString(),
    to: new Date(now).toISOString(),
    detail: `${sent} request-seconds, ${errors} errors (${(errors / sent * 100).toFixed(2)}%)`,
  });

  writeManifest({ generated_at: new Date().toISOString(), events });
  console.log(`\nbackfill complete: ${sent} request-seconds, ${errors} errors`);
  console.log(`manifest -> ${MANIFEST}`);
  return events;
}

function writeManifest(data) {
  try {
    fs.mkdirSync(require('path').dirname(MANIFEST), { recursive: true });
    let existing = {};
    if (fs.existsSync(MANIFEST)) existing = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const merged = {
      ...existing,
      ...data,
      events: [...(existing.events || []), ...(data.events || [])],
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.log(`could not write manifest: ${e.message}`);
  }
}

function readManifest() {
  if (!fs.existsSync(MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

module.exports = { backfill, writeManifest, readManifest, MANIFEST };
