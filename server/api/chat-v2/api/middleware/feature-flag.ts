/**
 * Feature Flag Middleware
 * 
 * Controls access to chat-v2 based on feature flags
 * Supports gradual rollout with per-request opt-in
 */

import type { Context, Next } from "hono"
import config from "@/config"

export async function featureFlagMiddleware(c: Context, next: Next) {
  // Check global feature flag
  const v2Enabled = config.features?.chatV2 === true

  // Check request-level opt-in
  const optInHeader = c.req.header("X-Chat-V2")
  const optInQuery = c.req.query("v2")
  const requestOptIn = optInHeader === "true" || optInQuery === "true"

  // Check user-specific rollout (e.g., 10% of users)
  const userId = c.get("jwtPayload")?.userId
  const userInRollout = isUserInRollout(userId, config.features?.chatV2RolloutPercentage || 0)

  // Determine if V2 should be used
  const useV2 = v2Enabled && (requestOptIn || userInRollout)

  // Store decision in context
  c.set("useChatV2", useV2)

  if (!useV2) {
    // Fall back to legacy implementation
    return c.json(
      {
        error: "Chat V2 not enabled",
        message: "Use /api/chat/message for legacy implementation",
      },
      404
    )
  }

  await next()
}

/**
 * Determine if user is in rollout based on user ID hash
 */
function isUserInRollout(userId: number | undefined, percentage: number): boolean {
  if (!userId || percentage <= 0) return false
  if (percentage >= 100) return true

  // Simple hash of user ID
  const hash = userId * 2654435761 % 100
  return hash < percentage
}
