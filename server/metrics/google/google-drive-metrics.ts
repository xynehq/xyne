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

// Collect metrics of ingestion duration
export const ingestionDuration = new Histogram({
  name: "google_drive_ingestion_duration_seconds",
  help: "Duration of ingestion per file",
  labelNames: ["mime_type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
})
register.registerMetric(ingestionDuration)

// Collect metrics for errors in file ingestion
export const ingestionErrorsTotal = new Counter({
  name: "google_drive_ingestion_errors_total",
  help: "Total number of ingestion errors",
  labelNames: ["file_id", "error_type", "mime_type"] as const,
})
register.registerMetric(ingestionErrorsTotal)

export const blockedFilesTotal = new Counter({
  name: "blocked_files_total",
  help: "Number of files blocked during ingestion",
  labelNames: ["app", "email"],
})
register.registerMetric(blockedFilesTotal)