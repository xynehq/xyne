import client from "prom-client"

// Create a new prometheus registry to collect metrics
export const register = new client.Registry()

// Register every metric coming from this file as a google drive metric using the default label
register.setDefaultLabels({
  app: "google-drive-ingestion",
})

// Collecting all the default metrics suggested by prometheus (cpu, memory, threads, etc)
client.collectDefaultMetrics({ register })

// Defines a method that will collect the metrics of total number of files 
export const totalIngestedFiles = new client.Counter({
  name: "google_drive_ingested_total",
  help: "Total number of ingested files",
  labelNames: ["file_type", "status"],
})
register.registerMetric(totalIngestedFiles) // register this metric function in the registry

// Collect metrics of ingestion duration
export const ingestionDuration = new client.Histogram({
  name: "google_drive_ingestion_duration_seconds",
  help: "Duration of ingestion per file",
  labelNames: ["file_type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
})
register.registerMetric(ingestionDuration)

// Collect metrics for errors in file ingestion
export const ingestionErrorsTotal = new client.Counter({
  name: "google_drive_ingestion_errors_total",
  help: "Total number of ingestion errors",
  labelNames: ["error_type", "file_type"] as const,
})
register.registerMetric(ingestionErrorsTotal)
