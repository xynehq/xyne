import { Hono } from "hono"
import keycloakApi from "./api"
import { getKeycloakConfig } from "./config"
import { getClientResolver } from "./client-resolver"
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
    const clientResolver = getClientResolver(config)
    
    // Get the appropriate client for authorization code flow (what frontend uses)
    const client = await clientResolver.resolveClient('authorization-code')

    return c.json({
      baseUrl: config.baseUrl,
      realm: config.defaultRealm,
      clientId: client.clientId,
      loginUrl: `${config.baseUrl}/realms/${config.defaultRealm}/protocol/openid-connect/auth`,
      // Don't expose sensitive config like clientSecret
      // Add info about whether we're using a fallback client
      usingFallback: client.priority <= 10, // Built-in clients have priority 10 or less
      clientType: client.isPublic ? 'public' : 'confidential',
      // Industry-level information
      strategy: config.clientSelectionStrategy,
      environment: config.environment,
      totalConfiguredClients: config.clients.length
    })
  } catch (error) {
    Logger.error("Failed to get Keycloak config:", error)
    return c.json({ error: "Configuration error" }, 500)
  }
})

// Industry-level client status endpoint  
app.get("/clients/status", async (c) => {
  try {
    const config = getKeycloakConfig()
    const { getClientManager } = await import("./client-manager")
    const clientManager = getClientManager(config)
    
    const status = await clientManager.getClientStatus()
    
    return c.json({
      ...status,
      configuredClients: config.clients.map(client => ({
        clientId: client.clientId,
        type: client.type,
        flows: client.flows,
        environment: client.environment,
        priority: client.priority,
        description: client.description
      })),
      builtInPreferences: config.builtInClientPreferences,
      autoDiscovery: config.autoDiscovery
    })
  } catch (error) {
    Logger.error("Failed to get client status:", error)
    return c.json({ error: "Status check failed" }, 500)
  }
})

// Test client selection for different flows
app.get("/clients/test/:flow", async (c) => {
  try {
    const flow = c.req.param('flow') as any
    const config = getKeycloakConfig()
    const { getClientManager } = await import("./client-manager")
    const clientManager = getClientManager(config)
    
    const context = {
      flowType: flow,
      environment: config.environment
    }
    
    const selectedClient = await clientManager.selectClient(context)
    
    return c.json({
      flow,
      selectedClient: {
        clientId: selectedClient.clientId,
        type: selectedClient.type,
        flows: selectedClient.flows,
        priority: selectedClient.priority,
        description: selectedClient.description
      },
      context
    })
  } catch (error) {
    Logger.error(`Failed to test client selection for flow:`, error)
    return c.json({ error: "Client selection test failed" }, 500)
  }
})

export default app