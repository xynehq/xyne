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
import {
  getExpectedKeycloakIssuer,
  getKeycloakWebConfig,
} from "@/auth/keycloak"

const Logger = getLogger(Subsystem.Server).child({ module: "health" })

const keycloakRequiredEnvKeys = [
  "KEYCLOAK_PUBLIC_BASE_URL",
  "KEYCLOAK_REALM",
  "KEYCLOAK_CLIENT_ID",
  "KEYCLOAK_CLIENT_SECRET",
  "KEYCLOAK_WORKSPACE_EXTERNAL_ID",
] as const

const isKeycloakExplicitlyEnabled = () =>
  process.env.KEYCLOAK_WEB_ENABLED?.trim() === "true"

const getMissingKeycloakEnvKeys = () =>
  keycloakRequiredEnvKeys.filter((key) => !process.env[key]?.trim())

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

// Internal helper function to check health of a Vespa container
async function checkVespaContainerHealth(
  port: number,
  containerName: "feed" | "query",
): Promise<HealthStatusResponse> {
  const startTime = Date.now()

  try {
    const vespaUrl =
      process.env.NODE_ENV === "production"
        ? `http://${config.vespaBaseHost}:${port}`
        : `http://localhost:${port}`

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
        let vespaDetails: Record<string, any> = {
          endpoint,
          container: containerName,
          port,
        }
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
                container: containerName,
                port,
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
              vespaDetails = {
                endpoint,
                container: containerName,
                port,
                ...data,
              }
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
              container: containerName,
              port,
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
            container: containerName,
            port,
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
        error: `All Vespa ${containerName} container endpoints failed. Last error: ${lastError}`,
        container: containerName,
        port,
      },
    }
  } catch (error) {
    Logger.error(error, `Vespa ${containerName} container health check failed`)
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.vespa,
      responseTime: Date.now() - startTime,
      details: {
        error:
          error instanceof Error
            ? error.message
            : `Vespa ${containerName} container connection failed`,
        container: containerName,
        port,
      },
    }
  }
}

// Backward compatibility wrapper - checks both feed and query containers
// Returns unhealthy if either container is unhealthy
export async function checkVespaHealth(): Promise<HealthStatusResponse> {
  const startTime = Date.now()
  const vespaRequired =
    process.env.VESPA_REQUIRED?.toLowerCase() === "true" ||
    process.env.VESPA_REQUIRED === "1"

  try {
    const [feedHealth, queryHealth] = await Promise.all([
      checkVespaContainerHealth(config.vespaFeedPort, "feed"),
      checkVespaContainerHealth(config.vespaQueryPort, "query"),
    ])

    // Determine combined status
    let combinedStatus: HealthStatusType
    if (
      feedHealth.status === HealthStatusType.Unhealthy ||
      queryHealth.status === HealthStatusType.Unhealthy
    ) {
      combinedStatus = vespaRequired
        ? HealthStatusType.Unhealthy
        : HealthStatusType.Degraded
    } else if (
      feedHealth.status === HealthStatusType.Degraded ||
      queryHealth.status === HealthStatusType.Degraded
    ) {
      combinedStatus = HealthStatusType.Degraded
    } else {
      combinedStatus = HealthStatusType.Healthy
    }

    const responseTime = Date.now() - startTime

    return {
      status: combinedStatus,
      serviceName: ServiceName.vespa,
      responseTime,
      details: {
        optional: !vespaRequired,
        message:
          !vespaRequired && combinedStatus === HealthStatusType.Degraded
            ? "Vespa is unavailable but optional; app remains healthy for deployment"
            : undefined,
        feedContainer: {
          status: feedHealth.status,
          responseTime: feedHealth.responseTime,
          ...feedHealth.details,
        },
        queryContainer: {
          status: queryHealth.status,
          responseTime: queryHealth.responseTime,
          ...queryHealth.details,
        },
      },
    }
  } catch (error) {
    Logger.error(error, "Vespa health check failed")
    return {
      status: vespaRequired
        ? HealthStatusType.Unhealthy
        : HealthStatusType.Degraded,
      serviceName: ServiceName.vespa,
      responseTime: Date.now() - startTime,
      details: {
        optional: !vespaRequired,
        message: vespaRequired
          ? "Vespa health check failed"
          : "Vespa health check failed, but Vespa is optional",
        error:
          error instanceof Error ? error.message : "Vespa health check failed",
      },
    }
  }
}

export async function checkPaddleOCRHealth(): Promise<HealthStatusResponse> {
  const start = Date.now()

  const baseURL = config.paddleStatusEndpoint!
  try {
    const response = await fetch(`${baseURL}`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    })

    const responseTime = Date.now() - start

    if (!response.ok) {
      return {
        status: HealthStatusType.Unhealthy,
        serviceName: ServiceName.paddleOCR,
        responseTime,
        details: {
          message: `PaddleOCR service Unhealthy ${response.status}`,
          responseTimeThreshold: "5000ms",
        },
      }
    }
    return {
      status: HealthStatusType.Healthy,
      serviceName: ServiceName.paddleOCR,
      responseTime,
      details: {
        message: "PaddleOCR service is healthy",
      },
    }
  } catch (error) {
    Logger.error(error, "PaddleOCR health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.paddleOCR,
      responseTime: Date.now() - start,
      details: {
        message: "Failed to connect to PaddleOCR service",
        error:
          error instanceof Error
            ? (error as Error).message
            : "Unknown PaddleOCR Service Error",
      },
    }
  }
}

const getOCRProviderServiceKey = (provider: string) =>
  provider === "paddle"
    ? "paddleOCR"
    : `ocr_${provider.replace(/[^a-z0-9]+/g, "_")}`

const getUnsupportedOCRProviderHealth = (
  provider: string,
): HealthStatusResponse => ({
  status: HealthStatusType.Unhealthy,
  serviceName: `OCR provider: ${provider}`,
  details: {
    message: `Unsupported OCR provider '${provider}'`,
  },
})

const checkOCRProviderHealth = async (
  provider: string,
): Promise<HealthStatusResponse> => {
  switch (provider) {
    case "paddle":
      return checkPaddleOCRHealth()
    default:
      return getUnsupportedOCRProviderHealth(provider)
  }
}

export const checkConfiguredOCRProvidersHealth = async (
  providers = config.ocrProviders,
): Promise<Record<string, HealthStatusResponse>> => {
  const providerHealthEntries = await Promise.all(
    providers.map(
      async (provider) =>
        [
          getOCRProviderServiceKey(provider),
          await checkOCRProviderHealth(provider),
        ] as const,
    ),
  )

  return Object.fromEntries(providerHealthEntries) as Record<
    string,
    HealthStatusResponse
  >
}

export async function checkDoclingHealth(): Promise<HealthStatusResponse> {
  const start = Date.now()

  const baseURL = config.doclingServiceUrl || "http://localhost:8000"
  try {
    const response = await fetch(`${baseURL}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    })

    const responseTime = Date.now() - start

    if (!response.ok) {
      return {
        status: HealthStatusType.Unhealthy,
        serviceName: ServiceName.docling,
        responseTime,
        details: {
          message: `Docling service Unhealthy ${response.status}`,
          responseTimeThreshold: "5000ms",
        },
      }
    }

    const data = await response.json().catch(() => ({}))
    return {
      status: HealthStatusType.Healthy,
      serviceName: ServiceName.docling,
      responseTime,
      details: {
        message: "Docling service is healthy",
        modelsLoaded: data.models_loaded || false,
      },
    }
  } catch (error) {
    Logger.error(error, "Docling health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.docling,
      responseTime: Date.now() - start,
      details: {
        message: "Failed to connect to Docling service",
        error:
          error instanceof Error
            ? (error as Error).message
            : "Unknown Docling Service Error",
      },
    }
  }
}

export async function checkKeycloakHealth(): Promise<HealthStatusResponse> {
  const start = Date.now()

  if (!isKeycloakExplicitlyEnabled()) {
    return {
      status: HealthStatusType.Healthy,
      serviceName: ServiceName.keycloak,
      responseTime: Date.now() - start,
      details: {
        message: "Keycloak web login is not configured; health check skipped",
        skipped: true,
      },
    }
  }

  const missingEnvKeys = getMissingKeycloakEnvKeys()
  if (missingEnvKeys.length > 0) {
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.keycloak,
      responseTime: Date.now() - start,
      details: {
        message:
          "Keycloak web login is enabled but configuration is incomplete",
        missingEnvKeys,
      },
    }
  }

  const keycloakConfig = getKeycloakWebConfig()
  if (!keycloakConfig) {
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.keycloak,
      responseTime: Date.now() - start,
      details: {
        message: "Keycloak web login is enabled but configuration is invalid",
      },
    }
  }

  const discoveryUrl = `${keycloakConfig.internalBaseUrl}/realms/${keycloakConfig.realm}/.well-known/openid-configuration`
  const expectedIssuer = getExpectedKeycloakIssuer(keycloakConfig)

  try {
    const response = await fetch(discoveryUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    })
    const responseTime = Date.now() - start

    if (!response.ok) {
      return {
        status: HealthStatusType.Unhealthy,
        serviceName: ServiceName.keycloak,
        responseTime,
        details: {
          message: `Keycloak discovery endpoint returned ${response.status}`,
          discoveryUrl,
        },
      }
    }

    let discovery: { issuer?: unknown }
    try {
      discovery = (await response.json()) as { issuer?: unknown }
    } catch (error) {
      return {
        status: HealthStatusType.Unhealthy,
        serviceName: ServiceName.keycloak,
        responseTime,
        details: {
          message: "Keycloak discovery response was not valid JSON",
          discoveryUrl,
          error: error instanceof Error ? error.message : "Invalid JSON",
        },
      }
    }

    if (discovery.issuer !== expectedIssuer) {
      return {
        status: HealthStatusType.Unhealthy,
        serviceName: ServiceName.keycloak,
        responseTime,
        details: {
          message: "Keycloak issuer did not match expected public issuer",
          discoveryUrl,
          issuer: discovery.issuer,
          expectedIssuer,
        },
      }
    }

    return {
      status: HealthStatusType.Healthy,
      serviceName: ServiceName.keycloak,
      responseTime,
      details: {
        message: "Keycloak discovery endpoint is healthy",
        issuer: discovery.issuer,
      },
    }
  } catch (error) {
    Logger.error(error, "Keycloak health check failed")
    return {
      status: HealthStatusType.Unhealthy,
      serviceName: ServiceName.keycloak,
      responseTime: Date.now() - start,
      details: {
        message: "Failed to connect to Keycloak discovery endpoint",
        discoveryUrl,
        error:
          error instanceof Error
            ? (error as Error).message
            : "Unknown Keycloak Error",
      },
    }
  }
}

const buildSystemHealthResponse = (
  services: ServiceHealthCheck,
): OverallSystemHealthResponse => {
  const serviceStatuses = Object.values(services).filter(
    (service): service is HealthStatusResponse => Boolean(service),
  )
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

const checkConfiguredSystemHealth = async (
  logMessage: string,
): Promise<OverallSystemHealthResponse> => {
  Logger.info(logMessage)
  const keycloakEnabled = isKeycloakExplicitlyEnabled()
  const doclingEnabled = config.doclingEnabled

  // Run core health checks
  const [postgresHealth, vespaHealth, ocrProviderHealth] = await Promise.all([
    checkPostgresHealth(),
    checkVespaHealth(),
    checkConfiguredOCRProvidersHealth(),
  ])

  // Build services object
  const services: ServiceHealthCheck = {
    postgres: postgresHealth,
    vespa: vespaHealth,
    ...ocrProviderHealth,
  }

  // Conditionally check optional services
  if (doclingEnabled) {
    services.docling = await checkDoclingHealth()
  }

  if (keycloakEnabled) {
    services.keycloak = await checkKeycloakHealth()
  }

  return buildSystemHealthResponse(services)
}

// Check Overall System Health
export const checkOverallSystemHealth =
  async (): Promise<OverallSystemHealthResponse> =>
    checkConfiguredSystemHealth("Starting overall system health check...")

// Check app readiness for container orchestration
export const checkSystemReadiness =
  async (): Promise<OverallSystemHealthResponse> =>
    checkConfiguredSystemHealth("Starting system readiness check...")
