# LBG SRE Lab — Meme Generator environment

The reference service behind the Lloyds Banking Group SRE course (labs 05–12).
Curriculum lives in
[`Lloyds-Banking-Group-Site-Reliability-Engineering-36-Hours`](https://github.com/ga-curriculum-dev/Lloyds-Banking-Group-Site-Reliability-Engineering-36-Hours);
this repo is the environment those labs run against.

Design rationale, requirements traceability and phasing: see `BUILD.md` in the
curriculum repo (`lbg-sre-lab-BUILD.md`).

## Status

| Phase | Scope | State |
|---|---|---|
| 1 (app layer) | Services, instrumentation, fault injection, local stack | **done — verified running** |
| 0 (spikes) | OneAgent + OTel trace integrity; Davis reproducibility | not started |
| 1 (infra) | Terraform, GKE, Istio, L7 LB, Artifact Registry, GCE MIG | not started |
| 2 | Dynatrace as code — SLOs, dashboards, alerts, SRG, Workflows | not started |
| 3 | Cloud Build → Cloud Deploy, automated rollback | not started |
| 4 | Chaos Mesh, stop-condition controller | not started |
| 5 | AI Ops scenarios, per-squad provisioning | not started |

## Services

| Service | Port | Instrumentation | Role |
|---|---|---|---|
| `meme-generator` | 8080 | OTel traces + metrics + logs, **all five resource attributes**, structured JSON logs carrying `trace_id` | The SLI-bearing service. CUJ: *generate a meme* |
| `template-store` | 8081 | OTel traces only — **`service.name` alone, no other attributes**, unstructured logs | Lab 05 part 2's target: the badly instrumented service |
| `caption-renderer` | 8082 | **none at all** | The legacy-style black box. Off-cluster in GCP |
| `loadgen` | — | — | Four traffic classes: `user`, `synthetic`, `batch`, `probe` |
| `collector` | 4318 | — | Tail sampling, host metrics, single egress to Dynatrace |

## Quick start

```bash
cp .env.example .env    # paste your Dynatrace ingest token
docker compose up --build
```

Working when the logs show `Meme generated` lines with a `trace_id`, and
`[loadgen] x1 user=… 5xx=… (0.4%)` roughly every 30 seconds.

```bash
docker compose down     # stop
```

## The CUJ

```
POST /generate  ->  meme-generator  ->  template-store    (in mesh, mTLS in GKE)
                                    ->  caption-renderer  (off cluster, plain HTTP)
```

- **SLI** % of `POST /generate` completing < 1500 ms with a non-5xx status
- **SLO** 99.5% over a 30-day rolling window → 0.5% allowed error rate

Endpoints: `POST /generate`, `GET /templates`, `GET /health`, `GET /readyz`.

## Three things that are wrong on purpose

Do not "fix" these. Each one is load-bearing for a specific lab.

**1. `template-store` has no metadata.** Traced, appears in Dynatrace Services,
but carries no `team`, `service.version`, `cloud.region` or
`deployment.environment`. Lab 05 part 2 is the hunt for it; filtering the
dashboard by `team` makes it vanish.

**2. `caption-renderer` emits nothing.** No SDK, no agent, no metrics endpoint,
no collected logs. The only evidence about it anywhere is the client span on
`meme-generator`. It is the stand-in for Lloyds' on-prem and mainframe estate,
and four teaching goals depend on the asymmetry (week 2 FMEA detectability,
week 2's hybrid observability gap, lab 05's "where traces break", week 5's
legacy chaos target).

**3. Failures are calibrated, not random.**

| Quantity | Value | Why |
|---|---|---|
| Baseline failure rate | 0.4% | burn rate 0.8× — inside the 99.5% SLO, which lab 05 and lab 07 baselines require |
| Share from `caption-renderer` | **60%** | week 1's "fix the dependency entirely" / "failures double" modelling only works if it is the majority cause |
| Share from `meme-generator` | 40% | `OWN_ERROR_RATE=0.0016` |
| Slow tail | 10% of requests, +600–1200 ms | puts p95 near 1500 ms without breaching at rest |
| `caption-renderer` pool | 24 concurrent | baseline ≈ 7.5 concurrent; ~3× load exhausts it → 503s |

**All failures return 5xx, never 4xx.** A 4xx on a server span leaves the OTel
span status `UNSET`, so Dynatrace reads the service failure rate as ~0% — and
lesson 06's own DQL filters `http.status_code >= 500`. The predecessor app
returned `402` and had this bug.

## Fault injection

```bash
# read current state
curl -s localhost:8080/_fault | python3 -m json.tool

# lab 07: break v2.4.2 only, leave v2.4.1 healthy
curl -s -X POST localhost:8080/_fault -H 'content-type: application/json' \
  -d '{"ownErrorRate":0.25,"addedLatencyMs":1200,"faultVersion":"v2.4.2"}'

# week 5: latency on the legacy dependency (Istio and Chaos Mesh cannot reach
# it — it is off-cluster, so it has its own admin endpoint)
curl -s -X POST localhost:8082/_admin/fault -H 'content-type: application/json' \
  -d '{"addedLatencyMs":5000}'

# week 2 capacity: shrink the pool to force exhaustion
curl -s -X POST localhost:8082/_admin/fault -H 'content-type: application/json' \
  -d '{"poolSize":4}'

# reset everything
curl -s -X POST localhost:8080/_fault/reset
curl -s -X POST localhost:8082/_admin/fault/reset
```

`faultVersion` scopes a fault to one `service.version`. This is what lets lab 07
run a canary where failures and the slow tail both sit on `v2.4.2` while
`v2.4.1` stays clean — the distinction the lab's verdict turns on.

## Why sampling lives in the collector

Lesson 05 teaches "always keep errors and slow requests, keep a fraction of
healthy ones". That is a **tail** decision: at span-start neither the status nor
the duration is known. So services sample at 100% and the policy is applied in
`collector/otel-collector-config.yaml` — errors 100%, > 1500 ms 100%,
probabilistic 10% for the rest. Head-sampling 10% in the SDK would throw away
90% of errors.

## Verified behaviour

Checked against a running stack on 2026-09-18:

- `POST /generate` → `202` in ~450 ms, inside the 1500 ms SLO
- Structured logs carry both `trace_id` and `span_id`; `template-store` and
  `caption-renderer` log unstructured text
- Pool exhaustion: 60 concurrent renders against a pool of 24 → 20×`200`, 40×`503`
- Baseline concurrency on `caption-renderer` observed at 7–8 of 24, matching the
  25 rps × 0.3 s calculation
- Version-scoped faults: 10/10 succeed when targeted at `v2.4.2` on a `v2.4.1`
  pod; failures appear immediately when retargeted at `v2.4.1`
- Collector receives OTLP and applies the tail-sampling pipeline

## Not built yet

`frontend` (RUM), `scenario-controller` (declarative scenarios + enforced stop
conditions, needed by lab 09), the `meme-generator-canary` / `meme-worker`
decoys for lab 12's wildcard query, Kubernetes manifests, Istio config,
Terraform, and the Dynatrace-as-code layer.
