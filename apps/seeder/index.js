// Seeder CLI.
//
//   probe                          discover the tenant's backdate ceiling
//   backfill [hours] [stepMinsAgo] fill the accepted window
//   manifest                       print the timeline manifest
//
// Run inside the compose network so OTLP_ENDPOINT resolves:
//   docker compose run --rm seeder probe
//   docker compose run --rm seeder backfill 1 45
const { probe } = require('./probe');
const { backfill, readManifest, MANIFEST } = require('./timeline');
const { ENDPOINT } = require('./otlp');

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  console.log(`seeder -> ${ENDPOINT}`);

  if (cmd === 'probe') {
    await probe();
  } else if (cmd === 'backfill') {
    await backfill({
      hours: Number(args[0] || 1),
      stepAtMinutesAgo: Number(args[1] || 45),
    });
  } else if (cmd === 'manifest') {
    const m = readManifest();
    console.log(m ? JSON.stringify(m, null, 2) : `no manifest at ${MANIFEST}`);
  } else {
    console.log(`
usage:
  probe                            discover how far back this tenant accepts OTLP
  backfill [hours] [stepMinsAgo]   fill the accepted window (default 1h, step 45m ago)
  manifest                         print placed events and their timestamps

Run probe FIRST. Backfilling beyond the ceiling fails silently: the collector
returns 200 and the data never appears.
`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
