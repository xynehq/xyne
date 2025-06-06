import metricRegister from "@/metrics/sharedRegistry"
import { Counter } from "prom-client"

// Defines a method that will collect the metrics of total number of mails
export const totalIngestedMails = new Counter({
  name: "gmail_ingested_total",
  help: "Total number of ingested mail",
  labelNames: ["mime_type", "status", "email", "account_type"],
})
metricRegister.registerMetric(totalIngestedMails) // register this metric function in the registry

export const ingestionMailErrorsTotal = new Counter({
  name: "gmail_ingestion_errors_total",
  help: "Total number of gmail ingestion errors",
  labelNames: [
    "mime_type",
    "status",
    "email",
    "account_type",
    "error_type",
  ] as const,
})
metricRegister.registerMetric(ingestionMailErrorsTotal)

export const totalAttachmentIngested = new Counter({
  name: "gmail_attachment_ingested_total",
  help: "Total number of ingested mail attachment",
  labelNames: ["mime_type", "status", "email", "account_type"],
})
metricRegister.registerMetric(totalAttachmentIngested)

export const totalAttachmentError = new Counter({
  name: "gmail_attachment_error_total",
  help: "Total number of errors ingesting mail attachment",
  labelNames: ["mime_type", "status", "email", "account_type", "error_type"],
})
metricRegister.registerMetric(totalAttachmentError)
