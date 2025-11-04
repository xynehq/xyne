 import { Hono } from "hono"
import config from "@/config"
import { getLogger, LogMiddleware } from "@/logger"
import { Subsystem } from "@/types"
import { InitialisationError } from "@/errors"
import metricRegister from "@/metrics/sharedRegistry"
import { jwt } from "hono/jwt"
import { zValidator } from "@hono/zod-validator"
import type { JwtVariables } from "hono/jwt"
import type { Context, Next } from "hono"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import { initExecutionEngineQueue } from "./execution-engine/execution-engine-queue"

const Logger = getLogger(Subsystem.ExecutionEngine)

const app = new Hono<{ Variables: JwtVariables }>()

const honoMiddlewareLogger = LogMiddleware(Subsystem.ExecutionEngine)

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const AccessTokenCookieName = config.AccessTokenCookie

// Auth middleware for internal API calls
const AuthMiddleware = jwt({
  secret: accessTokenSecret,
  cookie: AccessTokenCookieName,
})

// Middleware to check if user has admin or superAdmin role
const AdminRoleMiddleware = async (c: Context, next: Next) => {
  const { sub } = c.get("jwtPayload")
  const user = await getUserByEmail(db, sub)
  if (!user.length) {
    throw new Error(`Access denied. User with email ${sub} does not exist.`)
  }
  const userRole = user[0].role
  if (userRole !== "admin" && userRole !== "superAdmin") {
    throw new Error("Access denied. Admin privileges required.")
  }
  await next()
}

// Health check endpoint
app.get("/health", async (c) => {
  return c.json({ 
    status: "healthy", 
    service: "execution-engine",
    timestamp: new Date().toISOString() 
  })
})

// Metrics endpoint
app.get("/metrics", async (c) => {
  try {
    const metrics = await metricRegister.metrics()
    return c.text(metrics, 200, {
      "Content-Type": metricRegister.contentType,
    })
  } catch (err) {
    Logger.error(err, "Error generating metrics")
    return c.text("Error generating metrics", 500)
  }
})

// API routes will be added here
const apiRoutes = app
  .basePath("/api/v1")
  .use("*", AuthMiddleware)
  .use("*", honoMiddlewareLogger)
  // Workflow execution endpoints will be added here
  .get("/execution/status", async (c) => {
    // TODO: Implement execution status endpoint
    return c.json({ message: "Execution status endpoint - to be implemented" })
  })
  .post("/execution/start", async (c) => {
    // TODO: Implement start execution endpoint
    return c.json({ message: "Start execution endpoint - to be implemented" })
  })
  .post("/execution/stop", async (c) => {
    // TODO: Implement stop execution endpoint
    return c.json({ message: "Stop execution endpoint - to be implemented" })
  })

// Admin routes
const adminRoutes = app
  .basePath("/admin")
  .use("*", AuthMiddleware)
  .use("*", AdminRoleMiddleware)
  .use("*", honoMiddlewareLogger)
  .get("/executions", async (c) => {
    // TODO: Implement admin executions list
    return c.json({ message: "Admin executions list - to be implemented" })
  })
  .post("/executions/:executionId/cancel", async (c) => {
    // TODO: Implement admin execution cancel
    return c.json({ message: "Admin execution cancel - to be implemented" })
  })

export const init = async () => {
  Logger.info("Initializing Execution Engine...")
  
  try {
    // Initialize message queue for inter-service communication
    const { messageQueue } = await import("@/execution-engine/message-queue")
    await messageQueue.initialize()
    
    // Initialize execution engine queue and workers (exclusive to execution engine)
    await initExecutionEngineQueue()
    
    // Initialize message queue communication service
    const { communicationService } = await import("@/execution-engine/communication-service")
    await communicationService.startService()
    
    Logger.info("✅ Execution Engine initialized successfully")
    Logger.info("🔄 Queue workers are now polling for execution packets")
    Logger.info("📡 Message queue communication service started")
    
  } catch (error) {
    Logger.error(error, "Failed to initialize Execution Engine")
    throw new InitialisationError({ cause: error })
  }
}

const errorHandler = (error: Error) => {
  Logger.error(error, "Execution Engine error")
  return new Response(`<pre>${error}\n${error.stack}</pre>`, {
    headers: {
      "Content-Type": "text/html",
    },
  })
}

// Initialize the service
init().catch((error) => {
  Logger.error(error, "Failed to start Execution Engine")
  process.exit(1)
})

// Start the server
const server = Bun.serve({
  fetch: app.fetch,
  port: config.executionEnginePort,
  idleTimeout: 180,
  development: true,
  error: errorHandler,
})

Logger.info(`Execution Engine listening on port: ${config.executionEnginePort}`)

// Error handling
const errorEvents: string[] = [
  "uncaughtException",
  "unhandledRejection", 
  "rejectionHandled",
]

errorEvents.forEach((eventType: string) =>
  process.on(eventType, (error: Error) => {
    Logger.error(error, `Execution Engine caught via event: ${eventType}`)
  }),
)

export { app, apiRoutes, adminRoutes }