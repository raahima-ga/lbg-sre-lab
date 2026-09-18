// Scenario runner.
//
// One declarative file per lab drives every failure the environment produces.
// Nothing equivalent existed in the predecessor app, and eight labs need
// behaviour only this can provide (BUILD.md sec 9):
//
//   - repeatable injection across cohorts
//   - instructor control without kubectl
//   - randomised targets, so lab 09's learner cannot guess the affected hop
//   - AUTOMATIC stop conditions that abort on a live SLO breach -- lab 09
//     part 1 step 3 is unrunnable without this
//
// Step verbs: inject, reset, wait, assert, randomise.
// `deploy` is recognised but is a no-op locally; it becomes a Cloud Deploy call
// in phase 3.

const TARGETS = {
  'meme-generator':   { base: process.env.MEME_GENERATOR_URL   || 'http://meme-generator:8080',   fault: '/_fault',        reset: '/_fault/reset' },
  'template-store':   { base: process.env.TEMPLATE_STORE_URL   || 'http://template-store:8081',   fault: '/_fault',        reset: '/_fault' },
  'caption-renderer': { base: process.env.CAPTION_RENDERER_URL || 'http://caption-renderer:8082', fault: '/_admin/fault',  reset: '/_admin/fault/reset' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDuration(v) {
  if (typeof v === 'number') return v * 1000;
  const m = String(v).match(/^(\d+)(ms|s|m|h)$/);
  if (!m) throw new Error(`bad duration: ${v}`);
  const n = Number(m[1]);
  return { ms: n, s: n * 1000, m: n * 60000, h: n * 3600000 }[m[2]];
}

async function post(target, path, body) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown target: ${target}`);
  const res = await fetch(`${t.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${target}${path} -> ${res.status}`);
  return res.json().catch(() => ({}));
}

async function stats(windowSeconds = 300) {
  const t = TARGETS['meme-generator'];
  const res = await fetch(`${t.base}/_stats?window=${windowSeconds}`);
  return res.json();
}

// Translate a scenario `inject` step into the target's own fault vocabulary.
function faultPayload(step) {
  const p = {};
  if (step.kind === 'error')   p[step.target === 'meme-generator' ? 'ownErrorRate' : 'errorRate'] = step.rate;
  if (step.kind === 'latency') p.addedLatencyMs = parseDuration(step.delay) ;
  if (step.kind === 'capacity') p.poolSize = step.pool_size;
  if (step.version) p.faultVersion = step.version;
  return p;
}

class Run {
  constructor(scenario, log) {
    this.scenario = scenario;
    this.log = log;
    this.state = 'pending';
    this.startedAt = null;
    this.aborted = false;
    this.abortReason = null;
    this.chosenTarget = null;
    this.assertions = [];
  }

  async resetAll() {
    for (const name of Object.keys(TARGETS)) {
      try { await post(name, TARGETS[name].reset, {}); } catch (e) { this.log(`reset ${name} failed: ${e.message}`); }
    }
  }

  // Poll the live SLI and abort the moment a stop condition trips. This is the
  // difference between a stop condition and an intention.
  //
  // Two vocabularies, because a service can fail two different ways and an
  // availability-only guard misses half of them:
  //
  //   burn_rate_above   availability. Errors against the allowed error rate.
  //   slow_rate_above   latency. Share of requests breaching the latency SLO.
  //
  // A pure latency fault produces almost no errors -- burn rate barely moves
  // while nearly every request breaches the latency objective. Lab 09's own
  // example abort condition is "p95 latency exceeds 2x SLO target", so a guard
  // that only watched burn rate could not enforce the condition the lab asks
  // learners to write.
  startGuard() {
    const conds = this.scenario.stop_conditions || [];
    if (!conds.length) return;
    this.guard = setInterval(async () => {
      if (this.state !== 'running') return;
      try {
        const s = await stats(60);
        if (s.requests < 20) return;           // too small a sample to act on
        const slowRate = s.requests ? s.slow_requests / s.requests : 0;

        for (const c of conds) {
          let reason = null;

          if (c.burn_rate_above !== undefined && s.burn_rate > c.burn_rate_above) {
            reason =
              `burn_rate ${s.burn_rate.toFixed(1)}x exceeded ${c.burn_rate_above}x ` +
              `(${s.errors}/${s.requests} errors over 60s)`;
          }

          if (c.slow_rate_above !== undefined && slowRate > c.slow_rate_above) {
            reason =
              `slow_rate ${(slowRate * 100).toFixed(1)}% exceeded ${(c.slow_rate_above * 100).toFixed(0)}% ` +
              `(${s.slow_requests}/${s.requests} over the ${s.slo_latency_ms || 1500}ms objective, 60s)`;
          }

          if (reason) {
            this.abortReason = `stop condition: ${reason}`;
            this.log(`ABORT -- ${this.abortReason}`);
            this.aborted = true;
            this.state = 'aborting';
            return;
          }
        }
      } catch (e) { /* stats unavailable; do not abort on a polling failure */ }
    }, 5000);
  }

  stopGuard() { if (this.guard) clearInterval(this.guard); }

  async execute() {
    this.state = 'running';
    this.startedAt = new Date().toISOString();
    this.log(`scenario "${this.scenario.name}" starting`);
    await this.resetAll();
    this.startGuard();

    try {
      for (const step of this.scenario.steps || []) {
        if (this.aborted) break;
        const verb = Object.keys(step)[0];
        const body = step[verb];

        if (verb === 'randomise') {
          // Lab 09: "learners do not know in advance which hop is affected."
          this.chosenTarget = body.targets[Math.floor(Math.random() * body.targets.length)];
          this.log(`randomised target -> ${this.chosenTarget} (withheld from learners)`);
        } else if (verb === 'inject') {
          const target = body.target === '$RANDOM' ? this.chosenTarget : body.target;
          const payload = faultPayload({ ...body, target });
          await post(target, TARGETS[target].fault, payload);
          this.log(`inject ${body.kind} -> ${target} ${JSON.stringify(payload)}`);
        } else if (verb === 'wait') {
          const ms = parseDuration(body);
          this.log(`wait ${body}`);
          const until = Date.now() + ms;
          while (Date.now() < until && !this.aborted) await sleep(1000);
        } else if (verb === 'assert') {
          const s = await stats(body.window_seconds || 300);
          const ok =
            (body.availability_below === undefined || s.availability * 100 < body.availability_below) &&
            (body.burn_rate_above  === undefined || s.burn_rate > body.burn_rate_above);
          this.assertions.push({ expected: body, observed: s, pass: ok });
          this.log(`assert ${ok ? 'PASS' : 'FAIL'} -- availability ${(s.availability * 100).toFixed(2)}%, burn ${s.burn_rate.toFixed(2)}x`);
        } else if (verb === 'reset') {
          await this.resetAll();
          this.log('reset all faults');
        } else if (verb === 'deploy') {
          this.log(`deploy (no-op locally; Cloud Deploy in phase 3): ${JSON.stringify(body)}`);
        } else {
          this.log(`unknown step verb "${verb}" -- skipped`);
        }
      }
    } catch (e) {
      this.log(`error: ${e.message}`);
      this.state = 'failed';
    } finally {
      this.stopGuard();
      if (this.aborted) { await this.resetAll(); this.state = 'aborted'; this.log('faults cleared after abort'); }
      else if (this.state === 'running') this.state = 'complete';
      this.log(`scenario "${this.scenario.name}" ${this.state}`);
    }
  }
}

module.exports = { Run, stats, TARGETS };
