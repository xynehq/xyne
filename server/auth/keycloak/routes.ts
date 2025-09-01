import { Hono } from "hono"
import keycloakApi from "./api"
import { getKeycloakConfig } from "./config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

const app = new Hono()

// Mount the API routes
app.route("/", keycloakApi)

// Health check endpoint
app.get("/health", async (c) => {
  try {
    const config = getKeycloakConfig()
    const healthUrl = `${config.baseUrl}/realms/${config.defaultRealm}`

    const response = await fetch(healthUrl)

    if (response.ok) {
      return c.json({
        status: "healthy",
        keycloak: "connected",
        realm: config.defaultRealm,
        timestamp: new Date().toISOString(),
      })
    } else {
      return c.json(
        {
          status: "unhealthy",
          keycloak: "disconnected",
          error: "Could not reach Keycloak server",
        },
        503,
      )
    }
  } catch (error) {
    Logger.error("Keycloak health check failed:", error)
    return c.json(
      {
        status: "unhealthy",
        keycloak: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      503,
    )
  }
})

// Get Keycloak configuration (public info only)
app.get("/config", async (c) => {
  try {
    const config = getKeycloakConfig()

    return c.json({
      baseUrl: config.baseUrl,
      realm: config.defaultRealm,
      clientId: config.clientId,
      loginUrl: `${config.baseUrl}/realms/${config.defaultRealm}/protocol/openid-connect/auth`,
      // Don't expose sensitive config like clientSecret
    })
  } catch (error) {
    Logger.error("Failed to get Keycloak config:", error)
    return c.json({ error: "Configuration error" }, 500)
  }
})

export default app