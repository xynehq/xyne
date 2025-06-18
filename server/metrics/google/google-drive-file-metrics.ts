import { Counter, Histogram } from "prom-client"
import metricRegister from "@/metrics/sharedRegistry"

// Defines a method that will collect the metrics of total number of files
export const totalIngestedFiles = new Counter({
  name: "google_drive_ingested_total",
  help: "Total number of ingested files",
  labelNames: ["mime_type", "status", "email", "file_type"],
})
metricRegister.registerMetric(totalIngestedFiles) // register this metric function in the registry

// Collects metrics for errors in file ingestion
export const ingestionErrorsTotal = new Counter({
  name: "google_drive_ingestion_errors_total",
  help: "Total number of ingestion errors",
  labelNames: [
    "error_type",
    "mime_type",
    "email",
    "file_type",
    "status",
  ] as const,
})
metricRegister.registerMetric(ingestionErrorsTotal)

//Collects metics for the blocked files
export const blockedFilesTotal = new Counter({
  name: "google_drive_blocked_files_total",
  help: "Number of files blocked during ingestion",
  labelNames: ["email", "mime_type", "blocked_type", "file_type", "status"],
})
metricRegister.registerMetric(blockedFilesTotal)

// Collects metrics for the duration of extraction of a file's content
export const extractionDuration = new Histogram({
  name: "google_drive_content_extraction_duration_seconds",
  help: "Duration of contents extracted per file",
  labelNames: ["mime_type", "email", "file_type"] as const,
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
})
metricRegister.registerMetric(extractionDuration)

// Collects metrics for size of content-extracted files [ Ranges from - 10KB to 1GB]
export const contentFileSize = new Histogram({
  name: "google_drive_content_file_size_bytes",
  help: "Size of content-extracted files in bytes",

  labelNames: ["mime_type", "email", "file_type"] as const,
  buckets: [
    10 * 1024, // 10KB
    100 * 1024, // 100KB
    1 * 1024 * 1024, // 1MB
    5 * 1024 * 1024, // 5MB
    10 * 1024 * 1024, // 10MB
    50 * 1024 * 1024, // 50MB
    100 * 1024 * 1024, // 100MB
    200 * 1024 * 1024, // 200MB
    500 * 1024 * 1024, // 500MB
    1024 * 1024 * 1024, // 1GB
  ],
})
metricRegister.registerMetric(contentFileSize)

// Collect the errors during file extraction
export const fileExtractionErrorsTotal = new Counter({
  name: "google_drive_file_extraction_errors_total",
  help: "Total number of extraction errors",
  labelNames: ["error_type", "mime_type", "email", "file_type"] as const,
})
metricRegister.registerMetric(fileExtractionErrorsTotal)

// Collect the total number of extracted files
export const totalExtractedFiles = new Counter({
  name: "google_drive_files_extracted_total",
  help: "Total number of extracted files",
  labelNames: ["mime_type", "status", "email", "file_type"],
})
metricRegister.registerMetric(totalExtractedFiles)

// Collects the metrics for the total time required for extracting a specific type of file
export const totalDurationForFileExtraction = new Histogram({
  name: "google_drive_total_extraction_duration_seconds",
  help: "Duration of the total extraction in seconds per type of file",
  labelNames: ["file_type", "mime_type", "email"] as const,
  buckets: [25, 50, 75, 100, 125, 150, 175, 200],
})
metricRegister.registerMetric(totalDurationForFileExtraction)

export const totalDriveFilesToBeIngested = new Counter({
  name: "total_files_to_be_inserted",
  help: "Total number of drive files to be inserted",
  labelNames: ["email", "file_type", "status"],
})

metricRegister.registerMetric(totalDriveFilesToBeIngested)
