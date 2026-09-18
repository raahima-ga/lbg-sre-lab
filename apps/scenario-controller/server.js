// Scenario controller HTTP surface.
//
//   GET  /scenarios              list available scenarios
//   POST /scenarios/:name/run    start one (async)
//   GET  /status                 current run state, log, assertions
//   POST /abort                  stop the run and clear all faults
//   GET  /stats                  proxy the live SLI window
//   POST /stop-conditions        register a learner-authored stop condition
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { Run, stats } = require('./runner');

const app = express();
app.use(express.json());

const DIR = process.env.SCENARIO_DIR || '/scenarios';
let current = null;
let logLines = [];
const log = (m) => {
  const line = `${new Date().toISOString()} ${m}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  console.log(line);
};

const load = (name) =>
  yaml.load(fs.readFileSync(path.join(DIR, `${name}.yaml`), 'utf8'));

app.get('/health', (req, res) => res.sendStatus(200));

app.get('/scenarios', (req, res) => {
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.yaml')) : [];
  res.json(files.map((f) => {
    const s = yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8'));
    return { name: f.replace(/\.yaml$/, ''), description: s.description || null, lab: s.lab || null };
  }));
});

app.post('/scenarios/:name/run', (req, res) => {
  if (current && current.state === 'running') {
    return res.status(409).json({ error: 'a scenario is already running', name: current.scenario.name });
  }
  let scenario;
  try { scenario = load(req.params.name); }
  catch (e) { return res.status(404).json({ error: `no such scenario: ${req.params.name}` }); }

  logLines = [];
  current = new Run(scenario, log);
  current.execute();                       // deliberately not awaited
  res.status(202).json({ started: scenario.name, lab: scenario.lab || null });
});

app.get('/status', (req, res) => {
  if (!current) return res.json({ state: 'idle' });
  res.json({
    scenario: current.scenario.name,
    lab: current.scenario.lab || null,
    state: current.state,
    started_at: current.startedAt,
    aborted: current.aborted,
    abort_reason: current.abortReason,
    // Withheld on purpose while running: lab 09 requires the learner not to
    // know which hop was hit.
    chosen_target: current.state === 'running' ? '(withheld)' : current.chosenTarget,
    assertions: current.assertions,
    log: logLines.slice(-60),
  });
});

app.post('/abort', async (req, res) => {
  if (!current || current.state !== 'running') return res.status(409).json({ error: 'nothing running' });
  current.aborted = true;
  current.abortReason = 'manual abort';
  res.json({ aborting: current.scenario.name });
});

app.get('/stats', async (req, res) => res.json(await stats(Number(req.query.window) || 300)));

// Learner-authored stop conditions (lab 09 part 1 step 3). Registered against
// the running scenario so the guard enforces them without a human watching.
app.post('/stop-conditions', (req, res) => {
  if (!current) return res.status(409).json({ error: 'no scenario to attach to' });
  current.scenario.stop_conditions = current.scenario.stop_conditions || [];
  current.scenario.stop_conditions.push(req.body);
  log(`stop condition registered: ${JSON.stringify(req.body)}`);
  res.status(201).json({ stop_conditions: current.scenario.stop_conditions });
});

app.listen(8090, () => log(`scenario-controller listening on 8090, scenarios from ${DIR}`));
