// template-store -- serves meme templates.
//
// Traced, but with no metadata and no structured logging. See tracing.js for
// why that is on purpose.
const express = require('express');

const app = express();
app.use(express.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TEMPLATES = [
  { id: 'classic', name: 'Classic Top/Bottom', slots: 2 },
  { id: 'drake', name: 'Drake Hotline', slots: 2 },
  { id: 'brain', name: 'Expanding Brain', slots: 4 },
  { id: 'doge', name: 'Doge', slots: 3 },
];

let errorRate = Number(process.env.ERROR_RATE || 0);
let addedLatencyMs = Number(process.env.ADDED_LATENCY_MS || 0);

app.get('/health', (req, res) => res.sendStatus(200));
app.get('/readyz', (req, res) => res.sendStatus(200));

app.get('/_fault', (req, res) => res.json({ errorRate, addedLatencyMs }));
app.post('/_fault', (req, res) => {
  if (req.body?.errorRate !== undefined) errorRate = Number(req.body.errorRate);
  if (req.body?.addedLatencyMs !== undefined) addedLatencyMs = Number(req.body.addedLatencyMs);
  res.json({ errorRate, addedLatencyMs });
});

app.get('/templates', async (req, res) => {
  await sleep(15 + Math.random() * 35 + addedLatencyMs);
  // Unstructured, uncorrelated logging -- part of what "badly instrumented"
  // means. No trace_id here, so these lines cannot be joined to a trace.
  console.log(`templates list -> ${TEMPLATES.length} items`);
  res.json(TEMPLATES);
});

app.get('/templates/:id', async (req, res) => {
  await sleep(15 + Math.random() * 35 + addedLatencyMs);
  if (Math.random() < errorRate) {
    console.log(`template lookup failed ${req.params.id}`);
    return res.sendStatus(503);
  }
  const t = TEMPLATES.find((x) => x.id === req.params.id) || TEMPLATES[0];
  console.log(`template lookup ${t.id}`);
  res.json(t);
});

app.listen(8081, () => console.log('template-store listening on 8081'));
