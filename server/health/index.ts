import { db } from "@/db/client"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { sql } from "drizzle-orm"
import {
  HealthStatusType,
  ServiceName,
  type HealthStatusResponse,
  type OverallSystemHealthResponse,
  type ServiceHealthCheck,
} from "./type"
import config from "@/config"
import { version } from "jszip"
import { build } from "bun"

const Logger = getLogger(Subsystem.Server).child({ module: "health" })

// Check PostgreSQL Health
export const checkPostgresHealth = async (): Promise<HealthStatusResponse> => {
  const start = Date.now()
  try {
    await db.execute(sql`SELECT 1 as health_status`)
    const responseTime = Date.now() - start

    if (responseTime > 1000) {
      return {
        status: HealthStatusType.Degraded,
        serviceName: ServiceName.postgres,
        responseTime,
        details: {
          message: "PostgreSQL Database is responsding slowly",
          responseTimeThreshold: "1000ms",
        },
      }
    } else {
      return {
        status: HealthStatusType.Healthy,
        serviceName: ServiceName.postgres,
        responseTime,
        details: {
          message: "PostgreSQL Database is healthy",
        },
      }
    }
  } catch (error) {
    Logger.error(error, "PostgreSQL health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.postgres,
      responseTime: Date.now() - start,
      details: {
        message: "Failed to connect to PostgreSQL Database",
        error:
          error instanceof Error
            ? (error as Error).message
            : "Unknown Database Error",
      },
    }
  }
}

// Check Vespa Health

export async function checkVespaHealth(): Promise<HealthStatusResponse> {
  const startTime = Date.now()

  try {
    const vespaUrl =
      process.env.NODE_ENV === "production"
        ? `${config.vespaBaseHost}:${config.vespaPort}`
        : `http://localhost:${config.vespaPort}`

    // Try multiple Vespa health endpoints in order of preference
    const healthCheckEndpoints = [
      "/state/v1/health", // State API health endpoint (JSON)
      "/ApplicationStatus", // Primary Vespa application status
      "/status.html", // Alternative status page
      "/", // Root endpoint (basic connectivity)
    ]

    let lastError: string | null = null

    for (const endpoint of healthCheckEndpoints) {
      try {
        const response = await fetch(`${vespaUrl}${endpoint}`, {
          method: "GET",
          signal: AbortSignal.timeout(5000), // 5 second timeout
        })

        const responseTime = Date.now() - startTime

        if (!response.ok) {
          lastError = `${endpoint}: HTTP ${response.status}`
          continue
        }

        const contentType = response.headers.get("content-type")
        let applicationStatus = "Unknown"
        let vespaDetails: Record<string, any> = { endpoint }
        let healthStatus: HealthStatusType = HealthStatusType.Healthy

        try {
          if (contentType?.includes("application/json")) {
            const data = await response.json()

            // Parse response returned by /state/v1/health
            if (endpoint === "/state/v1/health") {
              const statusCode = data?.status?.code || data.code
              applicationStatus = statusCode || "UP"

              // Determine health based on status code
              if (statusCode === "up" || statusCode === "UP") {
                healthStatus = HealthStatusType.Healthy
                applicationStatus = "UP"
              } else if (statusCode === "down" || statusCode === "DOWN") {
                healthStatus = HealthStatusType.Unhealthy
                applicationStatus = "DOWN"
              } else if (statusCode) {
                healthStatus = HealthStatusType.Degraded
                applicationStatus = statusCode
              }

              vespaDetails = {
                endpoint,
                status: data.status,
                metrics: data.metrics || {},
                message: data.message || "",
              }
            } else {
              // Parse other JSON responses
              if (
                data.status === "up" ||
                data.state === "active" ||
                data.generation?.active
              ) {
                applicationStatus = "UP"
                healthStatus = HealthStatusType.Healthy
              } else if (data.status || data.state) {
                applicationStatus = data.status || data.state
                healthStatus = HealthStatusType.Degraded
              } else {
                applicationStatus = "JSON_RESPONSE"
                healthStatus = HealthStatusType.Healthy
              }
              vespaDetails = { endpoint, ...data }
            }
          } else {
            // Handle text/HTML responses
            const textData = await response.text()

            if (endpoint === "/ApplicationStatus") {
              if (textData.includes("<status>")) {
                const statusMatch = textData.match(
                  /<status[^>]*>([^<]+)<\/status>/i,
                )
                applicationStatus = statusMatch ? statusMatch[1] : "XML_PARSED"
              } else if (textData.includes("generation")) {
                applicationStatus = "GENERATION_ACTIVE"
              } else if (textData.toLowerCase().includes("ok")) {
                applicationStatus = "OK"
              } else {
                applicationStatus =
                  textData.trim().substring(0, 50) || "TEXT_RESPONSE"
              }
            } else if (endpoint === "/status.html") {
              if (
                textData.includes("OK") ||
                textData.includes("healthy") ||
                textData.includes("running")
              ) {
                applicationStatus = "HEALTHY"
              } else {
                applicationStatus = "HTML_RESPONSE"
              }
            } else {
              // Root endpoint
              applicationStatus =
                textData.length > 0 ? "RESPONDING" : "EMPTY_RESPONSE"
              healthStatus =
                textData.length > 0
                  ? HealthStatusType.Degraded
                  : HealthStatusType.Unhealthy
            }

            vespaDetails = {
              endpoint,
              responseType: "text",
              responseLength: textData.length,
              preview: textData.substring(0, 100),
            }
          }
        } catch (parseError) {
          applicationStatus = "PARSE_ERROR"
          healthStatus = HealthStatusType.Degraded
          vespaDetails = {
            endpoint,
            parseError:
              parseError instanceof Error
                ? parseError.message
                : "Could not parse response",
          }
        }

        return {
          status: healthStatus,
          serviceName: ServiceName.vespa,
          responseTime,
          details: {
            applicationStatus,
            endpoint,
            ...vespaDetails,
          },
        }
      } catch (endpointError) {
        lastError = `${endpoint}: ${endpointError instanceof Error ? endpointError.message : "Connection failed"}`
        continue // Try next endpoint
      }
    }

    // If all endpoints failed
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.vespa,
      responseTime: Date.now() - startTime,
      details: {
        error: `All Vespa endpoints failed. Last error: ${lastError}`,
      },
    }
  } catch (error) {
    Logger.error(error, "Vespa health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.vespa,
      responseTime: Date.now() - startTime,
      details: {
        error:
          error instanceof Error ? error.message : "Vespa connection failed",
      },
    }
  }
}

// Check Grafana Health
export const checkGrafanaHealth = async (): Promise<HealthStatusResponse> => {
  const startTime = Date.now()
  try {
    const grafanaUrl =
      process.env.NODE_ENV === "production"
        ? `${config.host}:${config.grafanaPort}`
        : `http://localhost:${config.grafanaPort}`
    const endpoint = "/api/health"
    const response = await fetch(`${grafanaUrl}${endpoint}`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    })

    const responseTime = Date.now() - startTime

    if (!response.ok) {
      Logger.error(`Grafana health check failed: HTTP ${response.status}`)
      return {
        status: HealthStatusType.Unhealthy,
        serviceName: ServiceName.grafana,
        responseTime,
        details: {
          message: `Grafana health check failed: HTTP ${response.status}`,
          endpoint,
        },
      }
    }

    const data = await response.json()

    return {
      status: HealthStatusType.Healthy,
      serviceName: ServiceName.grafana,
      responseTime,
      details: {
        message: "Grafana is healthy",
        version: data.version,
        database: data.database,
        endpoint,
      },
    }
  } catch (error) {
    Logger.error(error, "Grafana health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.grafana,
      responseTime: Date.now() - startTime,
      details: {
        message: "Failed to connect to Grafana",
        error:
          error instanceof Error
            ? (error as Error).message
            : "Unknown Grafana Error",
      },
    }
  }
}

// Check Prometheus Health
export const checkPrometheusHealth =
  async (): Promise<HealthStatusResponse> => {
    const startTime = Date.now()
    try {
      const prometheusUrl =
        process.env.NODE_ENV === "production"
          ? `${config.host}:${config.prometheusPort}`
          : `http://localhost:${config.prometheusPort}`

      const endpoint = "/-/healthy" // Prometheus health endpoint
      const response = await fetch(`${prometheusUrl}${endpoint}`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      const responseTime = Date.now() - startTime
      if (!response.ok) {
        Logger.error(`Prometheus health check failed: HTTP ${response.status}`)
        return {
          status: HealthStatusType.Unhealthy,
          serviceName: ServiceName.prometheus,
          responseTime,
          details: {
            message: `Prometheus health check failed: HTTP ${response.status} and ${response.statusText}`,
            endpoint,
          },
        }
      }
      try {
        const queryResponse = await fetch(
          `${prometheusUrl}/api/v1/query?query=up`,
          {
            method: "GET",
            signal: AbortSignal.timeout(3000),
          },
        )
        if (queryResponse.ok) {
          const queryData = await queryResponse.json()
          return {
            status: HealthStatusType.Healthy,
            serviceName: ServiceName.prometheus,
            responseTime,
            details: {
              message: "Prometheus is healthy and query engine is responsive",
              upTargets: queryData.data?.result?.length || 0,
            },
          }
        } else {
          Logger.warn(
            `Prometheus query endpoint returned non-OK: HTTP ${queryResponse.status} ${queryResponse.statusText}`,
          )
          return {
            status: HealthStatusType.Degraded,
            serviceName: ServiceName.prometheus,
            responseTime: responseTime,
            details: {
              basicHealth: "ok",
              message:
                "Prometheus is healthy but query engine is slow or unresponsive",
              status: queryResponse.status,
              statusText: queryResponse.statusText,
              endpoint: "/api/v1/query??query=up",
            },
          }
        }
      } catch (queryError) {
        return {
          status: HealthStatusType.Degraded,
          serviceName: ServiceName.prometheus,
          responseTime,
          details: {
            basicHealth: "ok",
            queryEngine: "failed",
          },
        }
      }
    } catch (error) {
      Logger.error(error, "Prometheus health check failed")
      return {
        status: HealthStatusType.Unhealthy,
        responseTime: Date.now() - startTime,
        serviceName: ServiceName.prometheus,
        details: {
          error:
            error instanceof Error
              ? error.message
              : "Prometheus connection failed",
        },
      }
    }
  }

// Check Loki Health
export const checkLokiHealth = async (): Promise<HealthStatusResponse> => {
  const startTime = Date.now()
  try {
    const lokiUrl =
      process.env.NODE_ENV === "production"
        ? `${config.host}:${config.lokiPort}`
        : `http://localhost:${config.lokiPort}`
    const buildEndpoint = "/loki/api/v1/status/buildinfo"
    const readyEndpoint = "/ready"

    // First check ready endpoint

    const readyResponse = await fetch(`${lokiUrl}${readyEndpoint}`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    })

    const responseTime = Date.now() - startTime

    if (!readyResponse.ok) {
      Logger.error(
        `Loki health check failed at endpoint ${readyEndpoint}: HTTP ${readyResponse.status}`,
      )

      const readyData = await readyResponse.json()

      // Now check build info endpoint - if ready endpoint fails we still check this to get more info

      const buildResponse = await fetch(`${lokiUrl}${buildEndpoint}`, {
        method: "GET",
        signal: AbortSignal.timeout(5000), // 5 second timeout
      })

      const buildResponseTime = Date.now() - startTime
      if (!buildResponse.ok) {
        Logger.error(
          `Loki health check failed at endpoint ${buildResponse}: HTTP ${buildResponse.status}`,
        )
        return {
          status: HealthStatusType.Unhealthy,
          serviceName: ServiceName.loki,
          responseTime: buildResponseTime,
          details: {
            message: `Loki health check failed: HTTP ${buildResponse.status} and ${buildResponse.statusText}`,
            endpoint: buildEndpoint,
          },
        }
      }

      const buildData = await buildResponse.json()

      return {
        status: HealthStatusType.Degraded,
        serviceName: ServiceName.loki,
        responseTime,
        details: {
          message: "Loki is healthy but not ready to serve requests",
          version: buildData.version,
          buildDate: buildData.buildDate,
          endpoint: buildEndpoint,
        },
      }
    }
    // If ready endpoint is OK, return healthy status
    return {
      status: HealthStatusType.Healthy,
      serviceName: ServiceName.loki,
      responseTime: Date.now() - startTime,
      details: {
        message: `Loki ready with HTTP status ${readyResponse.status}`,
        endpoint: readyEndpoint,
      },
    }
  } catch (error) {
    Logger.error(error, "Loki health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.loki,
      responseTime: Date.now() - startTime,
      details: {
        message: "Failed to connect to Loki",
        error:
          error instanceof Error
            ? (error as Error).message
            : "Unknown Loki Error",
      },
    }
  }
}

// Check Overall System Health
export const checkOverallSystemHealth =
  async (): Promise<OverallSystemHealthResponse> => {
    Logger.info("Starting overall system health check...")
    const startTime = Date.now()

    const [
      postgresHealth,
      vespaHealth,
      grafanaHealth,
      lokiHealth,
      prometheusHealth,
    ] = await Promise.all([
      checkPostgresHealth(),
      checkVespaHealth(),
      checkGrafanaHealth(),
      checkLokiHealth(),
      checkPrometheusHealth(),
    ])

    const services: ServiceHealthCheck = {
      postgres: postgresHealth,
      vespa: vespaHealth,
      grafana: grafanaHealth,
      loki: lokiHealth,
      prometheus: prometheusHealth,
    }

    const serviceStatuses = Object.values(services).filter(Boolean)
    const totalServices = serviceStatuses.length
    const healthyServices = serviceStatuses.filter(
      (s) => s.status === HealthStatusType.Healthy,
    ).length

    const degradedServices = serviceStatuses.filter(
      (s) => s.status === HealthStatusType.Degraded,
    ).length
    const unhealthyServices = serviceStatuses.filter(
      (s) => s.status === HealthStatusType.Unhealthy,
    ).length

    let overallStatus: HealthStatusType
    if (unhealthyServices > 0) {
      overallStatus = HealthStatusType.Unhealthy
    } else if (degradedServices > 0) {
      overallStatus = HealthStatusType.Degraded
    } else {
      overallStatus = HealthStatusType.Healthy
    }

    const totalTime = Date.now() - startTime

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services,
      summary: {
        totalServices,
        healthyServices,
        unhealthyServices,
        degradedServices,
        lastChecked: new Date().toISOString(),
      },
    }
  }
