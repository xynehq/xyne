import { Counter, Histogram } from "prom-client"
import metricRegister from "@/metrics/sharedRegistry.ts"

// Collects metrics for other entities of google not involving content extraction
export const metadataFiles = new Counter({
  name: "google_entity_metadata",
  help: "Metadata_for_other_entities",
  labelNames: ["file_type", "mime_type", "status", "email"],
})
metricRegister.registerMetric(metadataFiles)

// Collects metrics of ingestion duration
export const ingestionDuration = new Histogram({
  name: "google_entity_ingestion_duration_seconds",
  help: "Duration of ingestion per file",
  labelNames: ["file_type", "mime_type", "email"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
})
metricRegister.registerMetric(ingestionDuration)
