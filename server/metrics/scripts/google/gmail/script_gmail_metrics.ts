import metricRegister from "@/metrics/sharedRegistry"
import { Counter } from "prom-client"

// Defines a method that will collect the metrics of total number of mails
export const totalIngestedMailsScript = new Counter({
  name: "gmail_ingested_total",
  help: "Total number of ingested mail",
  labelNames: ["mime_type", "status", "email", "account_type"],
})
metricRegister.registerMetric(totalIngestedMailsScript) // register this metric function in the registry

export const ingestionMailErrorsTotalScript = new Counter({
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
metricRegister.registerMetric(ingestionMailErrorsTotalScript)

export const totalAttachmentIngestedScript = new Counter({
  name: "gmail_attachment_ingested_total",
  help: "Total number of ingested mail attachment",
  labelNames: ["mime_type", "status", "email", "account_type"],
})
metricRegister.registerMetric(totalAttachmentIngestedScript)

export const totalAttachmentErrorScript = new Counter({
  name: "gmail_attachment_error_total",
  help: "Total number of errors ingesting mail attachment",
  labelNames: ["mime_type", "status", "email", "account_type", "error_type"],
})
metricRegister.registerMetric(totalAttachmentErrorScript)

export const totalGmailToBeIngestedCountScript = new Counter({
  name: "gmail_to_be_ingested_total_count",
  help: "Total Number of Gmails to be Ingested",
  labelNames: ["status", "email", "account_type"],
})

metricRegister.registerMetric(totalGmailToBeIngestedCountScript)

export const totalSkippedMailsScript = new Counter({
  name: "gmail_skipped_from_insertion_count",
  help: "Total Number of Gmails that skipped being ingested",
  labelNames: ["status", "email", "account_type"],
})

metricRegister.registerMetric(totalSkippedMailsScript)
