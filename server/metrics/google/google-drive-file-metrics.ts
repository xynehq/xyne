import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client"

// Create a new prometheus registry to collect metrics
export const register = new Registry()

// Register every metric coming from this file as a google drive metric using the default label
register.setDefaultLabels({
  app: "google-drive-ingestion",
})

// Collecting all the default metrics suggested by prometheus (cpu, memory, threads, etc)
collectDefaultMetrics({ register })

// Defines a method that will collect the metrics of total number of files 
export const totalIngestedFiles = new Counter({
  name: "google_drive_ingested_total",
  help: "Total number of ingested files",
  labelNames: ["file_id","mime_type", "status"],
})
register.registerMetric(totalIngestedFiles) // register this metric function in the registry

// Collects metrics of ingestion duration
export const ingestionDuration = new Histogram({
  name: "google_drive_ingestion_duration_seconds",
  help: "Duration of ingestion per file",
  labelNames: ["file_id", "mime_type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
})
register.registerMetric(ingestionDuration)

// Collects metrics for errors in file ingestion
export const ingestionErrorsTotal = new Counter({
  name: "google_drive_ingestion_errors_total",
  help: "Total number of ingestion errors",
  labelNames: ["file_id", "error_type", "mime_type"] as const,
})
register.registerMetric(ingestionErrorsTotal)
//Collects metics for the blocked files
export const blockedFilesTotal = new Counter({
  name: "blocked_files_total",
  help: "Number of files blocked during ingestion",
  labelNames: ["", "app", "email"],
})
register.registerMetric(blockedFilesTotal)

// Collects metrics for the duration of extraction of a file's content
export const extractionDuration = new Histogram({
  name: "google_drive_content_extraction_duration_seconds",
  help: "Duration of contents extracted per file",
  labelNames: ["file_id_or_name", "mime_type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
})
register.registerMetric(extractionDuration)

// Collects metrics for size of content-extracted files [ Ranges from - 10KB to 1GB]
export const contentFileSize = new Histogram({
  name: "google_drive_content_file_size_bytes",
  help: "Size of content-extracted files in bytes",
  labelNames: ["file_id", "mime_type"] as const,
buckets: [
  10 * 1024,          // 10KB
  100 * 1024,         // 100KB
  1 * 1024 * 1024,    // 1MB
  5 * 1024 * 1024,    // 5MB
  10 * 1024 * 1024,   // 10MB
  50 * 1024 * 1024,   // 50MB
  100 * 1024 * 1024,  // 100MB
  200 * 1024 * 1024,  // 200MB
  500 * 1024 * 1024,  // 500MB
  1024 * 1024 * 1024, // 1GB
]
})
register.registerMetric(contentFileSize)

export const fileExtractionErrorsTotal = new Counter({
  name: "google_drive_file_extraction_errors_total",
  help: "Total number of extraction errors",
  labelNames: ["file_id_or_name", "error_type", "mime_type"] as const,
})
register.registerMetric(fileExtractionErrorsTotal)