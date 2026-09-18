// OpenTelemetry bootstrap for meme-generator. Loaded via --require before server.js.
//
// This service is the SLI-bearing service: its spans must carry all five
// resource attributes (lab 05 step 3 verifies them), and its logs must carry a
// trace_id that matches the trace (lab 05 step 4).
//
// Resource attributes come from OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME so
// that the deployment manifest is the single source of truth -- see
// docker-compose.yml locally, and the kustomize overlay in Kubernetes.
//
// Sampling is deliberately 100% HERE. The "always keep errors and slow
// requests, keep a fraction of healthy ones" policy taught in lesson 05 is a
// TAIL sampling decision and cannot be made at the SDK: at span-start we do not
// yet know the status or the duration. It is applied in the collector instead
// (collector/otel-collector-config.yaml). Head-sampling at 10% here would throw
// away 90% of errors.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { AlwaysOnSampler } = require('@opentelemetry/sdk-trace-base');

const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://collector:4318';

const sdk = new NodeSDK({
  sampler: new AlwaysOnSampler(),
  traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
    exportIntervalMillis: 15000,
  }),
  logRecordProcessors: [
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: `${base}/v1/logs` })),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // Health and readiness probes are excluded from the SLI (lab 06 part 4).
      // They are still traced -- learners need to SEE them in order to filter
      // them out -- but they must never become the parent of a real trace.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

sdk.start();

const shutdown = () => sdk.shutdown().finally(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
