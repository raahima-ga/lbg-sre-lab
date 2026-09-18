// Discovers how far back this tenant actually accepts OTLP.
//
// WHY THIS EXISTS. The build document originally specified "seed 30 days of
// backdated OTLP". That is almost certainly not achievable: Dynatrace enforces
// an ingest window and silently drops data stamped outside it. Rejected data
// does not fail loudly -- the collector returns 200 and the points never
// appear -- so an unverified assumption here produces labs that dead-end on
// the morning of a session.
//
// Rather than hard-code a guess, probe it. Send one marker point per candidate
// offset, then read back which markers actually landed.
//
// Read-back requires a Grail query, which needs an API token with
// storage:buckets:read. Without one, the probe still reports what was ACCEPTED
// at the ingest boundary, which is the first thing that breaks.

const { send, gauge, span, logRecord } = require('./otlp');

const OFFSETS_MINUTES = [0, 5, 15, 30, 55, 90, 180, 360, 720, 1440, 4320, 10080, 43200];

async function probe() {
  const now = Date.now();
  const results = [];

  for (const mins of OFFSETS_MINUTES) {
    const t = now - mins * 60_000;
    const marker = `probe_${mins}m`;

    const m = await send('metrics', gauge({
      service: 'seeder-probe',
      timeMs: t,
      metrics: { 'lab.seed.probe': mins },
      attributes: { marker, offset_minutes: mins },
    }));

    const s = await send('traces', span({
      service: 'seeder-probe',
      name: 'POST /generate',
      startMs: t,
      durationMs: 400,
      attributes: { marker, offset_minutes: mins },
    }));

    const l = await send('logs', logRecord({
      service: 'seeder-probe',
      timeMs: t,
      level: 'INFO',
      message: `backdate probe ${mins}m`,
      attributes: { marker, offset_minutes: mins },
    }));

    results.push({
      offset_minutes: mins,
      human: mins === 0 ? 'now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${(mins / 60).toFixed(1)}h ago` : `${(mins / 1440).toFixed(1)}d ago`,
      metrics: m.status, traces: s.status, logs: l.status,
      accepted_at_ingest: m.ok && s.ok && l.ok,
      note: m.ok ? '' : m.body,
    });
  }

  console.log('\nBackdate probe -- ACCEPTED AT INGEST (not yet confirmed queryable)\n');
  console.log('  offset      metrics traces logs   accepted');
  for (const r of results) {
    console.log(
      `  ${r.human.padEnd(11)} ${String(r.metrics).padEnd(7)} ${String(r.traces).padEnd(6)} ` +
      `${String(r.logs).padEnd(6)} ${r.accepted_at_ingest ? 'yes' : 'NO'}  ${r.note}`
    );
  }

  console.log(`
IMPORTANT: a 2xx at the collector only means the payload was well formed. The
collector forwards asynchronously, so Dynatrace may still drop backdated points
without surfacing an error here.

To confirm what is actually QUERYABLE, run this DQL in a Dynatrace notebook
about two minutes after the probe:

  timeseries v = avg(lab.seed.probe), by: { marker }, from: -35d
  | fields marker, v

Every marker that appears is an offset this tenant genuinely accepts. The
largest one is the real ceiling for seeding -- design the timeline inside it,
and get the rest of the history by running the environment continuously.
`);

  return results;
}

module.exports = { probe, OFFSETS_MINUTES };
