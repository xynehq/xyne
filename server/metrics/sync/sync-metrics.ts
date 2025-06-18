import metricRegister from "@/metrics/sharedRegistry"
import { Counter, Histogram } from "prom-client"

export const syncJobDuration = new Histogram({
  name: "sync_job_duration_in_seconds",
  help: "Time taken for the sync job to complete",
  labelNames: ["sync_job_name", "sync_job_auth_type"],
  buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
})

metricRegister.registerMetric(syncJobDuration)

export const syncJobSuccess = new Counter({
  name: "sync_job_success",
  help: "Number of successful sync jobs",
  labelNames: ["sync_job_name", "sync_job_auth_type"],
})

metricRegister.registerMetric(syncJobSuccess)

export const internalSyncJobSuccess = new Counter({
  name: "sync_job_internal_success",
  help: "Count of successful sync jobs inside a global sync job",
  labelNames: [
    "sync_job_internal_name",
    "sync_job_entity",
    "sync_job_auth_type",
    "sync_job_name",
  ],
})

metricRegister.registerMetric(internalSyncJobSuccess)

export const syncJobError = new Counter({
  name: "sync_job_error",
  help: "Number of failed sync jobs",
  labelNames: ["sync_job_name", "sync_job_error_type", "sync_job_auth_type"],
})

metricRegister.registerMetric(syncJobError)

export const internalSyncJobError = new Counter({
  name: "sync_job_internal_error",
  help: "Count of error sync jobs inside a global sync job",
  labelNames: [
    "sync_job_internal_name",
    "sync_job_entity",
    "sync_internal_job_error_type",
    "sync_job_auth_type",
    "sync_job_name",
  ],
})

metricRegister.registerMetric(internalSyncJobError)
