import { collectDefaultMetrics, Registry } from "prom-client"

const metricRegister = new Registry()

metricRegister.setDefaultLabels({
  service: "xyne-metrics",
})

collectDefaultMetrics({ register: metricRegister })

export default metricRegister
