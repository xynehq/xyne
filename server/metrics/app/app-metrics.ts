import metricRegister from "@/metrics/sharedRegistry"
import { Counter, Summary } from "prom-client"

export const appRequest = new Counter({
  name: "app_request_count",
  help: "Number of request sent to server",
  labelNames: [
    "app_endpoint",
    "app_request_process_status",
    "email",
    "offset",
    "agent_id",
  ],
})
metricRegister.registerMetric(appRequest)

export const appResponse = new Counter({
  name: "app_response_count",
  help: "Number of response sent",
  labelNames: ["app_endpoint", "app_response_status", "email"],
})

metricRegister.registerMetric(appResponse)

export const requestResponseLatency = new Summary({
  name: "app_request_response_duration_seconds",
  help: "Observed request durations in seconds",
  labelNames: ["app_endpoint", "app_response_status", "email"],
})

metricRegister.registerMetric(requestResponseLatency)

export const likeDislikeCount = new Counter({
  name: "like_dislike_count",
  help: "Count of Number of Like and Dislikes",
  labelNames: ["email", "feedback"],
})

metricRegister.registerMetric(likeDislikeCount)
