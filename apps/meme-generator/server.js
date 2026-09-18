// meme-generator -- the SLI-bearing reference service.
//
// CUJ: "generate a meme".
//   SLI  % of POST /generate completing < 1500ms with a non-5xx status
//   SLO  99.5% over a 30-day rolling window
//
// Request path in production:
//   GCP LB -> Istio ingress -> meme-generator -> template-store   (in mesh, mTLS)
//                                             -> caption-renderer (off cluster, plain HTTP)
//
// caption-renderer emits NO telemetry of its own. The only evidence this system
// has about it is the client span created here. That asymmetry is deliberate --
// it is the stand-in for Lloyds' on-prem and mainframe estate.
const express = require('express');
const { trace, context, SpanStatusCode } = require('@opentelemetry/api');
const { log } = require('./log');
const faults = require('./faults');

const app = express();
app.use(express.json());

const TEMPLATE_STORE = process.env.TEMPLATE_STORE_URL || 'http://template-store:8081';
const CAPTION_RENDERER = process.env.CAPTION_RENDERER_URL || 'http://caption-renderer:8082';
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 2000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const memeId = () => `MEME-${Math.floor(1000 + Math.random() * 9000)}`;

// Tag every request with its traffic source so the SLI can exclude non-user
// traffic. Lab 06 part 4 has learners prove the exclusion moves the number,
// which only works if the attribute is really on the span.
app.use((req, res, next) => {
  const span = trace.getSpan(context.active());
  if (span) {
    span.setAttribute('source', req.get('x-source') || 'user');
    span.setAttribute('http.route', req.path);
  }
  next();
});

// --- probes: traced, but never part of the SLI ---
app.get('/health', (req, res) => res.sendStatus(200));
app.get('/readyz', (req, res) => res.sendStatus(200));

// --- admin: fault control ---
app.get('/_fault', (req, res) => res.json(faults.get()));
app.post('/_fault', (req, res) => res.json(faults.set(req.body || {})));
app.post('/_fault/reset', (req, res) => res.json(faults.reset()));

// --- CUJ 2: browse templates ---
app.get('/templates', async (req, res) => {
  try {
    const r = await fetch(`${TEMPLATE_STORE}/templates`, {
      headers: { 'x-source': req.get('x-source') || 'user' },
    });
    if (!r.ok) throw new Error(`template-store ${r.status}`);
    return res.status(200).json(await r.json());
  } catch (err) {
    log('ERROR', 'Template list unavailable', { error: String(err) });
    return res.status(503).json({ status: 'unavailable' });
  }
});

// --- CUJ 1: generate a meme ---
app.post('/generate', async (req, res) => {
  const id = memeId();
  const span = trace.getSpan(context.active());
  if (span) span.setAttribute('meme.id', id);

  // Own processing time, plus whatever the scenario has injected.
  await sleep(40 + Math.random() * 80 + faults.plannedDelayMs());

  // Injected local failure -- the 40% of baseline failures that are NOT the
  // dependency's fault. 5xx, never 4xx: a 4xx on a server span leaves the OTel
  // span status UNSET, so Dynatrace would read the failure rate as ~0%.
  if (faults.shouldFailLocally()) {
    if (span) span.setStatus({ code: SpanStatusCode.ERROR, message: 'internal render failure' });
    log('ERROR', 'Meme generation failed', { meme_id: id, cause: 'internal' });
    return res.status(503).json({ meme_id: id, status: 'failed' });
  }

  // Hop 3: template-store, in mesh.
  let template;
  try {
    const r = await fetch(`${TEMPLATE_STORE}/templates/${req.body?.template_id || 'classic'}`, {
      headers: { 'x-source': req.get('x-source') || 'user' },
    });
    if (!r.ok) throw new Error(`template-store ${r.status}`);
    template = await r.json();
  } catch (err) {
    if (span) span.setStatus({ code: SpanStatusCode.ERROR, message: 'template-store unavailable' });
    log('ERROR', 'Meme generation failed', { meme_id: id, cause: 'template-store', error: String(err) });
    return res.status(503).json({ meme_id: id, status: 'failed' });
  }

  // Hop 4: caption-renderer, off cluster. No server span will exist for this.
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), RENDER_TIMEOUT_MS);
    const r = await fetch(`${CAPTION_RENDERER}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ meme_id: id, template: template.id, text: req.body?.text || 'hello' }),
      signal: ac.signal,
    }).finally(() => clearTimeout(timer));

    if (!r.ok) throw new Error(`caption-renderer ${r.status}`);
  } catch (err) {
    // The majority failure cause by design (RQ-30). Note how little we can say
    // about WHY -- there is no server span and no log from that service.
    if (span) span.setStatus({ code: SpanStatusCode.ERROR, message: 'caption-renderer unavailable' });
    log('ERROR', 'Meme generation failed', { meme_id: id, cause: 'caption-renderer', error: String(err) });
    return res.status(503).json({ meme_id: id, status: 'failed' });
  }

  log('INFO', 'Meme generated', { meme_id: id, template: template.id });
  return res.status(202).json({ meme_id: id, status: 'generated', template: template.id });
});

app.listen(8080, () =>
  log('INFO', 'meme-generator listening on 8080', { service_version: faults.currentVersion() })
);
