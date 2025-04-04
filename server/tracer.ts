// Set environment variables
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf"
process.env.OTEL_SERVICE_NAME = "tracer"

// Import OpenTelemetry components
import { NodeSDK } from "@opentelemetry/sdk-node"
import { Subsystem } from "./types"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import {
  trace,
  DiagConsoleLogger,
  diag,
  DiagLogLevel,
  type Tracer,
} from "@opentelemetry/api"
import { getLogger } from "./logger"
import { defaultResource } from "@opentelemetry/resources"
const Logger = getLogger(Subsystem.Tracer)

// Enable debug logging
// diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

// Create the exporter
const exporter = new OTLPTraceExporter({
  url: "http://localhost:4318/v1/traces",
  timeoutMillis: 15000, // 15 seconds timeout
})

// Create the processor
const processor = new BatchSpanProcessor(exporter, {
  maxExportBatchSize: 5, // Export each span immediately (for testing)
  scheduledDelayMillis: 500, // Frequent checks
})

// Create the SDK
const sdk = new NodeSDK({
  spanProcessor: processor,
  instrumentations: [],
})

export const init = () => {
  try {
    Logger.info("Initializing OpenTelemetry SDK")
    sdk.start()
  } catch (error) {
    console.error("Error starting SDK:", error)
  }
}
