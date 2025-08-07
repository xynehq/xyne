/**
 * JAF Agent Routes Configuration
 * Provides gradual migration path from manual agent to JAF
 */

import { Hono } from "hono"
import { MessageWithToolsApi } from "./agents" // Original implementation
import { MessageWithToolsJAF } from "./agents-jaf" // Complete JAF implementation
import type { Context } from "hono"
import config from "@/config"

const app = new Hono()

/**
 * Main chat endpoint - Complete 1:1 JAF implementation
 */
app.post("/messages", async (c: Context) => {
  return MessageWithToolsJAF(c)
})

/**
 * Explicit JAF endpoint for testing
 */
app.post("/messages-jaf", MessageWithToolsJAF)

/**
 * Explicit legacy endpoint
 */
app.post("/messages-legacy", MessageWithToolsApi)

/**
 * A/B testing endpoint
 */
app.post("/messages-ab", async (c: Context) => {
  const variant = c.req.query("variant")

  if (variant === "jaf") {
    return MessageWithToolsJAF(c)
  } else if (variant === "legacy") {
    return MessageWithToolsApi(c)
  } else {
    // Default to JAF implementation
    return MessageWithToolsJAF(c)
  }
})

/**
 * Performance comparison endpoint (for monitoring)
 */
app.post("/messages-compare", async (c: Context) => {
  const startLegacy = Date.now()
  let legacyError = null

  try {
    // Clone request for legacy API
    const clonedRequest = c.req.raw.clone()
    const clonedContext = Object.create(c)
    clonedContext.req = { ...c.req, raw: clonedRequest }
    await MessageWithToolsApi(clonedContext)
  } catch (error) {
    legacyError = error
  }

  const legacyTime = Date.now() - startLegacy

  const startJAF = Date.now()
  let jafError = null

  try {
    await MessageWithToolsJAF(c)
  } catch (error) {
    jafError = error
  }

  const jafTime = Date.now() - startJAF

  // Log performance metrics
  console.log("Performance Comparison:", {
    legacy: { time: legacyTime, error: (legacyError as any)?.message },
    jaf: { time: jafTime, error: (jafError as any)?.message },
    improvement: (((legacyTime - jafTime) / legacyTime) * 100).toFixed(2) + "%",
  })

  // Return JAF response if successful, otherwise legacy
  if (!jafError) {
    return c.json({ implementation: "jaf", time: jafTime })
  } else if (!legacyError) {
    return c.json({ implementation: "legacy", time: legacyTime })
  } else {
    throw jafError || legacyError
  }
})

export default app
