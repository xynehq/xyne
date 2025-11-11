import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger } from "hono/logger"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { initExecutionEngineQueue } from "./execution-engine-queue"

const Logger = getLogger(Subsystem.ExecutionEngine)

// Create Hono app for execution engine
const executionEngineApp = new Hono()

// Middleware
executionEngineApp.use("*", cors())
executionEngineApp.use("*", logger())

// Health check endpoint
executionEngineApp.get("/health", (c) => {
  return c.json({ 
    status: "healthy", 
    service: "execution-engine",
    timestamp: new Date().toISOString()
  })
})

// No trigger routes - handled by main server via message queue

// Error handling middleware
executionEngineApp.onError((err, c) => {
  Logger.error(err, "Execution engine server error")
  return c.json({
    error: "Internal server error",
    message: err.message
  }, 500)
})

// 404 handler
executionEngineApp.notFound((c) => {
  return c.json({
    error: "Not found",
    path: c.req.path
  }, 404)
})

const PORT = process.env.EXECUTION_ENGINE_PORT || 3010

const errorHandler = (error: Error) => {
  Logger.error(error, "Execution engine server error")
  return new Response(`<pre>${error}\n${error.stack}</pre>`, {
    headers: {
      "Content-Type": "text/html",
    },
  })
}

async function startExecutionEngineServer() {
  try {
    Logger.info("🚀 Starting Execution Engine Server...")
    Logger.info("Initializing Execution Engine...")
    
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
    
    // Start Bun server with same configuration as main server
    const server = Bun.serve({
      fetch: executionEngineApp.fetch,
      port: Number(PORT),
      idleTimeout: 180,
      development: true,
      error: errorHandler,
    })
    
    Logger.info(`✅ Execution Engine Server started on port ${PORT}`)
    Logger.info(`📊 Health check available at http://localhost:${PORT}/health`)
    Logger.info(`📡 Manual triggers handled by main server via message queue`)
    
    return server
  } catch (error) {
    Logger.error(error, "❌ Failed to start Execution Engine Server")
    process.exit(1)
  }
}

// Start server if this file is run directly
if (import.meta.main) {
  startExecutionEngineServer()
}

export { executionEngineApp, startExecutionEngineServer }