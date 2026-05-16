import { Hono, type Context, type Next } from "hono"
import { getCookie } from "hono/cookie"
import { logger as honoLogger } from "hono/logger"
import { HTTPException } from "hono/http-exception"

import { db } from "@/db/client"
import { getPublicUserAndWorkspaceByEmail, saveRefreshTokenToDB } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getAvailableModels } from "@/ai/fetchModels"

import keycloakRouter from "./auth/keycloak"
import { googleAuthMiddleware, googleCallback } from "./auth/google"
import chatRouter from "./agent/routes/chat"
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
} from "./lib/cookies"
import {
  type JwtPayload,
  generateAccessToken,
  generateRefreshToken,
  verifyAccess,
  verifyRefresh,
} from "./lib/tokens"

type Variables = { jwtPayload: JwtPayload }

const Logger = getLogger(Subsystem.Api).child({ module: "backendv2" })

// Default to the port the existing Google client / Keycloak client have
// registered as the callback host. Override via env if you change provider config.
const PORT = Number(process.env["BACKENDV2_PORT"] ?? 3000)

const app = new Hono<{ Variables: Variables }>()
app.use("*", honoLogger())

const tryRefresh = async (c: Context): Promise<JwtPayload | null> => {
  const refreshToken = getCookie(c, REFRESH_COOKIE)
  if (!refreshToken) {
    return null
  }
  let decoded: JwtPayload
  try {
    decoded = await verifyRefresh(refreshToken)
  } catch (err) {
    Logger.warn({ err }, "refresh: invalid signature")
    return null
  }
  const email = decoded.sub
  const workspaceId = decoded.workspaceId
  if (!email || !workspaceId) {
    return null
  }
  const uw = await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)
  const existingUser = uw?.user
  const existingWorkspace = uw?.workspace
  if (!existingUser || !existingWorkspace) {
    Logger.warn({ email }, "refresh: user/workspace not found")
    return null
  }
  if (existingUser.refreshToken !== refreshToken) {
    Logger.warn({ email }, "refresh: token mismatch with DB")
    return null
  }
  const newAccess = await generateAccessToken(
    existingUser.email,
    existingUser.role,
    existingUser.workspaceExternalId,
    decoded.authProvider,
  )
  const newRefresh = await generateRefreshToken(
    existingUser.email,
    existingUser.role,
    existingUser.workspaceExternalId,
    decoded.authProvider,
  )
  await saveRefreshTokenToDB(db, existingUser.email, newRefresh)
  setSessionCookies(c, newAccess, newRefresh)

  return {
    sub: existingUser.email,
    role: existingUser.role,
    workspaceId: existingUser.workspaceExternalId,
    tokenType: "access",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...(decoded.authProvider ? { authProvider: decoded.authProvider } : {}),
  }
}

const AuthMiddleware = async (c: Context, next: Next): Promise<void> => {
  const access = getCookie(c, ACCESS_COOKIE)
  if (access) {
    try {
      const decoded = await verifyAccess(access)
      c.set("jwtPayload", decoded)
      await next()
      return
    } catch (err) {
      Logger.debug({ err }, "access invalid; trying refresh")
    }
  }
  const refreshed = await tryRefresh(c)
  if (!refreshed) {
    clearSessionCookies(c)
    throw new HTTPException(401, { message: "Unauthorized" })
  }
  c.set("jwtPayload", refreshed)
  await next()
}

// ── Public routes ─────────────────────────────────────────────────────────
app.get("/v2/health", (c) => c.json({ ok: true, service: "backendv2" }))

app.post("/v2/refresh-token", async (c) => {
  const refreshed = await tryRefresh(c)
  if (!refreshed) {
    clearSessionCookies(c)
    throw new HTTPException(401, { message: "Refresh failed" })
  }
  return c.json({ msg: "Tokens refreshed", email: refreshed.sub })
})

app.post("/v2/logout", (c) => {
  clearSessionCookies(c)
  return c.json({ ok: true })
})

// ── OAuth (paths match the URIs already registered in GCP / Keycloak) ─────
// Google: single endpoint — googleAuth() initiates if no `code`, completes if present.
app.get("/v1/auth/callback", googleAuthMiddleware, googleCallback)
// Convenience for ui2's "Continue with Google" button.
app.get("/v1/auth/google/start", (c) => c.redirect("/v1/auth/callback"))

// Keycloak: /start initiates the flow, /callback completes it.
app.route("/v1/auth/keycloak", keycloakRouter)

// ── Protected routes ──────────────────────────────────────────────────────
app.use("/v2/*", AuthMiddleware)

app.route("/v2/chat", chatRouter)

app.get("/v2/me", (c) => {
  const p = c.get("jwtPayload")
  return c.json({
    email: p.sub,
    role: p.role,
    workspaceId: p.workspaceId,
    tokenType: p.tokenType,
  })
})

// Catalog of LLMs available to the composer's model picker. Same shape and
// source as xyne's /api/v1/chat/models.
app.get("/v2/models", async (c) => {
  try {
    const models = await getAvailableModels({
      AwsAccessKey: config.AwsAccessKey,
      AwsSecretKey: config.AwsSecretKey,
      OpenAIKey: config.OpenAIKey,
      OllamaModel: config.OllamaModel,
      TogetherAIModel: config.TogetherAIModel,
      TogetherApiKey: config.TogetherApiKey,
      FireworksAIModel: config.FireworksAIModel,
      FireworksApiKey: config.FireworksApiKey,
      GeminiAIModel: config.GeminiAIModel,
      GeminiApiKey: config.GeminiApiKey,
      VertexAIModel: config.VertexAIModel,
      VertexProjectId: config.VertexProjectId,
      VertexRegion: config.VertexRegion,
      LiteLLMApiKey: config.LiteLLMApiKey,
      LiteLLMBaseUrl: config.LiteLLMBaseUrl,
    })
    // Mirror xyne — strip actualName / provider before returning.
    const filtered = models.map((m) => ({
      labelName: m.labelName,
      reasoning: m.reasoning,
      websearch: m.websearch,
      deepResearch: m.deepResearch,
      description: m.description,
    }))
    return c.json({ models: filtered })
  } catch (err) {
    Logger.error({ err }, "/v2/models failed")
    throw new HTTPException(500, { message: "Could not fetch models" })
  }
})

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  Logger.error({ err }, "unhandled error")
  return c.json({ error: "internal_error" }, 500)
})

Logger.info(`backendv2 listening on port ${PORT}`)

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 240,
}
