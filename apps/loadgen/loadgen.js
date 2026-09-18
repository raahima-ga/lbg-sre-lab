// Traffic generator.
//
// Four distinct traffic classes, each tagged with an x-source header that
// meme-generator turns into a `source` span attribute. Lab 06 part 4 has
// learners exclude three of the four from the SLI and prove the number moves --
// which only works if all four are really present in the data.
//
//   user       real customer traffic          IN the SLI
//   synthetic  Dynatrace-style probe          excluded
//   batch      nightly reconciliation job     excluded
//   probe      kubelet health/readiness       excluded
//
// Volume (BUILD.md D-01): 90,000 req/hr on /generate, 18,000 on /templates.
// 90,000/hr is 25 rps, which is what makes a 5-minute burn-rate window
// statistically meaningful -- at the originally specified 2,000/hr a single
// error swings burn rate to 1.2x and the alerting the course teaches is noise.
//
// Override RPS locally if your laptop objects; the trade-off is that burn-rate
// windows get noisier, exactly as the build document predicts.

const TARGET = process.env.TARGET || 'http://meme-generator:8080';
const GENERATE_RPS = Number(process.env.GENERATE_RPS || 25);
const TEMPLATES_RPS = Number(process.env.TEMPLATES_RPS || 5);
const PEAK_MULTIPLIER = Number(process.env.PEAK_MULTIPLIER || 1.5);
const ENABLE_PEAK = process.env.ENABLE_PEAK !== 'false';

const TEMPLATE_IDS = ['classic', 'drake', 'brain', 'doge'];
const TEXTS = ['ship it', 'works on my machine', 'it was DNS', 'error budget go brrr'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Peak window: weekday mornings 09:00-10:30, 1.5x baseline (RQ-29).
function multiplier() {
  if (!ENABLE_PEAK) return 1;
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return 1;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 9 * 60 && mins < 10 * 60 + 30 ? PEAK_MULTIPLIER : 1;
}

const counters = { user: 0, synthetic: 0, batch: 0, probe: 0, errors: 0 };

async function hit(path, { method = 'GET', body, source }) {
  try {
    const res = await fetch(`${TARGET}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-source': source },
      body: body ? JSON.stringify(body) : undefined,
    });
    counters[source] = (counters[source] || 0) + 1;
    if (res.status >= 500) counters.errors += 1;
    return res.status;
  } catch (err) {
    counters.errors += 1;
    return 0;
  }
}

// A rate-driven loop. Recomputes its interval each tick so the peak window
// takes effect without a restart.
function drive(name, baseRps, fn) {
  const tick = () => {
    const rps = baseRps * multiplier();
    if (rps > 0) fn();
    setTimeout(tick, Math.max(5, 1000 / Math.max(rps, 0.001)));
  };
  tick();
}

// 1. Real user traffic -- the CUJ, and the only class inside the SLI.
drive('generate', GENERATE_RPS, () =>
  hit('/generate', {
    method: 'POST',
    source: 'user',
    body: { template_id: pick(TEMPLATE_IDS), text: pick(TEXTS) },
  })
);

// 2. Real user traffic -- browse templates.
drive('templates', TEMPLATES_RPS, () => hit('/templates', { source: 'user' }));

// 3. Synthetic probe. Steady, low volume, always the same request -- this is
//    what a Dynatrace HTTP monitor looks like from the service's side.
setInterval(() => hit('/generate', {
  method: 'POST', source: 'synthetic', body: { template_id: 'classic', text: 'synthetic check' },
}), 60_000);

// 4. Kubelet-style probes. High volume, trivially cheap -- the traffic that
//    drags an unweighted global p95 down and hides a real latency problem.
setInterval(() => { hit('/health', { source: 'probe' }); hit('/readyz', { source: 'probe' }); }, 10_000);

// 5. Batch reconciliation. Bursty, not customer-initiated. Counting these in
//    the SLI is lab 06's SLO-C anti-pattern.
setInterval(async () => {
  for (let i = 0; i < 40; i++) {
    hit('/generate', { method: 'POST', source: 'batch', body: { template_id: 'classic', text: 'reconcile' } });
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log('batch reconciliation run complete (40 requests, source=batch)');
}, 900_000);

setInterval(() => {
  const { user, synthetic, batch, probe, errors } = counters;
  const total = user + synthetic + batch + probe;
  const pct = total ? ((errors / total) * 100).toFixed(3) : '0.000';
  console.log(
    `[loadgen] x${multiplier()} user=${user} synthetic=${synthetic} batch=${batch} probe=${probe} 5xx=${errors} (${pct}%)`
  );
}, 30_000);

console.log(`loadgen -> ${TARGET} at ${GENERATE_RPS} rps /generate, ${TEMPLATES_RPS} rps /templates`);
