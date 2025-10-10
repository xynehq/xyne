export enum HealthStatusType {
  Healthy = "healthy",
  Unhealthy = "unhealthy",
  Degraded = "degraded",
  Improved = "improved",
}

export interface HealthStatusResponse {
  status: HealthStatusType
  serviceName: string
  responseTime?: number
  details?: Record<string, any>
}

export interface ServiceHealthCheck {
  postgres: HealthStatusResponse
  vespa: HealthStatusResponse
  paddleOCR: HealthStatusResponse
}

export interface OverallSystemHealthResponse {
  status: HealthStatusType
  timestamp: string
  services: ServiceHealthCheck
  summary: {
    totalServices: number
    healthyServices: number
    unhealthyServices: number
    degradedServices: number
    lastChecked: string
  }
}

export enum ServiceName {
  postgres = "PostgreSQL",
  grafana = "Grafana",
  vespa = "Vespa",
  loki = "Loki",
  prometheus = "Prometheus",
  paddleOCR = "PaddleOCR",
}
