// OpenTelemetry bootstrap for template-store.
//
// ============================ DELIBERATELY WRONG ============================
// This service is the target of lab 05 part 2: "find the badly instrumented
// service". It IS traced -- spans flow and it appears in Dynatrace Services --
// but it sets NO resource attributes beyond service.name:
//
//   no team                    -> alert routing silently misses it
//   no service.version         -> a regression cannot be tied to a release
//   no cloud.region            -> geo-specific incidents cannot be localised
//   no deployment.environment  -> staging noise mixes into production
//
// See docker-compose.yml: its environment sets OTEL_SERVICE_NAME only, with no
// OTEL_RESOURCE_ATTRIBUTES. There is also no log pipeline and no metrics
// exporter here -- compare against apps/meme-generator/tracing.js.
//
// DO NOT "FIX" THIS. Adding the attributes removes lab 05 part 2 entirely.
// ============================================================================
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://collector:4318';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
  instrumentations: [getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-fs': { enabled: false },
  })],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
