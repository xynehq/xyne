/**
 * Auth Middleware
 * 
 * JWT validation and user context extraction
 * Uses hono/jwt for consistency with existing auth
 */

import type { Context, Next } from "hono"
import { verify } from "hono/jwt"
import config from "@/config"

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!

export async function authMiddleware(c: Context, next: Next) {
  // Skip auth for health checks
  if (c.req.path === "/health") {
    await next()
    return
  }

  const authHeader = c.req.header("Authorization")
  
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Unauthorized" }, 401)
  }

  const token = authHeader.substring(7)

  try {
    const payload = await verify(token, accessTokenSecret)
    
    // Store JWT payload in context
    c.set("jwtPayload", {
      sub: payload.sub as string,
      userId: payload.userId as number,
      workspaceId: payload.workspaceId as number,
      workspaceNumericId: payload.workspaceNumericId as number,
      email: payload.sub as string,
      timeZone: (payload.timeZone as string) || "UTC",
    })

    await next()
  } catch (error) {
    return c.json({ error: "Invalid token" }, 401)
  }
}
