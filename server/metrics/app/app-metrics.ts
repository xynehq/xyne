import metricRegister from "@/metrics/sharedRegistry";
import { Counter, Histogram, Summary } from "prom-client";

export const appRequest = new Counter({
    name: "app_request_count",
    help: "Number of request sent to server",
    labelNames: ["app_endpoint","app_request_process_status"]
})
metricRegister.registerMetric(appRequest)

export const appResponse = new Counter({
    name: "app_response_count",
    help:"Number of response sent",
    labelNames: ["app_endpoint", "app_response_status"]
})

metricRegister.registerMetric(appResponse)


export const requestResponseLatency = new Summary({
  name: "app_request_response_duration_seconds",
  help: "Observed request durations in seconds",
  labelNames: ["app_endpoint", "app_response_status"]
})

metricRegister.registerMetric(requestResponseLatency)
