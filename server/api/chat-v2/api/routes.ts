/**
 * Chat V2 API Routes
 * 
 * Hono route definitions for new chat architecture
 */

import { Hono } from "hono"
import { chatHandler } from "./handlers/chat.handler"
import { streamHandler } from "./handlers/streaming.handler"
import { authMiddleware } from "./middleware/auth"
import { validationMiddleware } from "./middleware/validation"
import { featureFlagMiddleware } from "./middleware/feature-flag"

const app = new Hono()

// Apply global middleware
app.use("*", authMiddleware)
app.use("*", featureFlagMiddleware)

// Main chat endpoint
app.post("/api/chat-v2/message",
  validationMiddleware,
  chatHandler
)

// Stream test endpoint (for debugging)
app.get("/api/chat-v2/stream-test", streamHandler)

export default app
