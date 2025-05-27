import metricRegister from "@/metrics/sharedRegistry";
import { Counter, Histogram } from "prom-client";

export const appRequest = new Counter({
    name: "app_request_count",
    help: "Number of request sent to server",
    labelNames: ["app_endpoint", "app_request_time","app_request_process_status"]
})
metricRegister.registerMetric(appRequest)

export const appResponse = new Counter({
    name: "app_response_count",
    help:"Number of response sent",
    labelNames: ["app_endpoint", "app_response_time", "app_response_status"]
})

metricRegister.registerMetric(appResponse)

export const requestResponseLatency = new Histogram({
  name: "app_request_response_latency",
  help: "Duration between request and response",
  labelNames: ["app_endpoint", "app_response_status"],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 20, 25] // in seconds
})

metricRegister.registerMetric(requestResponseLatency)