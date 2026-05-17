import { Hono, type Context, type Next } from "hono"
import { getCookie } from "hono/cookie"
import { logger as honoLogger } from "hono/logger"
import { HTTPException } from "hono/http-exception"

import { db } from "@/db/client"
import {
  getPublicUserAndWorkspaceByEmail,
  getUserAndWorkspaceByEmail,
  saveRefreshTokenToDB,
} from "@/db/user"
import { getUserAccessibleAgents } from "@/db/userAgentPermission"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getAvailableModels } from "@/ai/fetchModels"

import keycloakRouter from "./auth/keycloak"
import { googleAuthMiddleware, googleCallback } from "./auth/google"
import chatRouter from "./agent/routes/chat"
import kbRouter from "./routes/knowledgeBase"
import { initApiServerQueue } from "@/queue/api-server-queue"
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
// Alias — the GCP HTTPS LB in front of Caddy probes /health and only marks
// the backend healthy on 2xx. v1 exposed /health/postgres for this; v2
// answers the bare /health path so the LB sees OK without any LB-side
// config change.
app.get("/health", (c) => c.json({ ok: true, service: "backendv2" }))

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
app.route("/v2/kb", kbRouter)

app.get("/v2/me", (c) => {
  const p = c.get("jwtPayload")
  return c.json({
    email: p.sub,
    role: p.role,
    workspaceId: p.workspaceId,
    tokenType: p.tokenType,
  })
})

// Lightweight projection of the v1 `agents` table for the composer's agent
// picker. Returns the same set v1 exposes (owned, explicitly shared, public)
// trimmed to fields the UI actually uses. Heavy fields like `appIntegrations`
// and `docIds` stay server-side — the scope is resolved at sendMessage time.
app.get("/v2/agents", async (c) => {
  const p = c.get("jwtPayload")
  try {
    const { user, workspace } = await getUserAndWorkspaceByEmail(
      db,
      p.workspaceId,
      p.sub,
    )
    const agents = await getUserAccessibleAgents(db, user.id, workspace.id)
    return c.json({
      agents: agents.map((a) => ({
        externalId: a.externalId,
        name: a.name,
        description: a.description ?? "",
        model: a.model,
        isPublic: a.isPublic,
        isRagOn: a.isRagOn ?? true,
        allowWebSearch: a.allowWebSearch ?? false,
      })),
    })
  } catch (err) {
    Logger.error({ err, email: p.sub }, "/v2/agents failed")
    throw new HTTPException(500, { message: "Could not fetch agents" })
  }
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

// ── Static SPA (ui2 build output) ─────────────────────────────────────────
// In prod we serve ui2's built assets directly from this process so we ship
// a single container with single port (same shape as v1's xyne deploy).
// The path is relative to the server's cwd (the `server/` directory at
// runtime), and the Docker image copies ui2/dist there as `server/ui2-dist`.
// In dev, vite serves ui2 itself on :5176 and proxies /v2/* + /v1/auth/* here,
// so these static handlers are no-ops because no /assets/* lands on :3000.
const SPA_DIST = process.env["UI2_DIST_DIR"] ?? "./ui2-dist"
// Hono's serveStatic from hono/bun doesn't accept absolute `path` cleanly in
// every release; we serve assets via Bun.file directly. Same shape, simpler
// resolution — and we can return useful content-types without an extra dep.
const mime = (p: string): string => {
  if (p.endsWith(".html")) return "text/html; charset=utf-8"
  if (p.endsWith(".js") || p.endsWith(".mjs"))
    return "application/javascript; charset=utf-8"
  if (p.endsWith(".css")) return "text/css; charset=utf-8"
  if (p.endsWith(".svg")) return "image/svg+xml"
  if (p.endsWith(".png")) return "image/png"
  if (p.endsWith(".ico")) return "image/x-icon"
  if (p.endsWith(".json")) return "application/json"
  if (p.endsWith(".woff2")) return "font/woff2"
  if (p.endsWith(".woff")) return "font/woff"
  return "application/octet-stream"
}

const serveSpaFile = async (
  c: Context,
  filePath: string,
): Promise<Response> => {
  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return c.notFound()
  }
  return new Response(file, {
    headers: { "Content-Type": mime(filePath) },
  })
}

app.get("/assets/*", async (c) => {
  // Strip leading slash so it's relative to SPA_DIST. Path is URL-decoded by
  // hono; reject any '..' to avoid escaping the dist root.
  const rel = c.req.path.replace(/^\//, "")
  if (rel.includes("..")) {
    return c.notFound()
  }
  return serveSpaFile(c, `${SPA_DIST}/${rel.replace(/^assets\//, "assets/")}`)
})
app.get("/favicon.ico", (c) => serveSpaFile(c, `${SPA_DIST}/favicon.ico`))
app.get("/favicon.svg", (c) => serveSpaFile(c, `${SPA_DIST}/favicon.svg`))
// pdf.js worker — shipped via ui2/public/ so it lands at the dist root with
// a stable name (no content hash). The PDF viewer points workerSrc here.
app.get("/pdf.worker.mjs", (c) =>
  serveSpaFile(c, `${SPA_DIST}/pdf.worker.mjs`),
)
// TanStack file-based router uses client-side routing — any unknown GET that
// isn't an API/auth path falls through to index.html so the SPA can take over.
app.get("*", (c) => serveSpaFile(c, `${SPA_DIST}/index.html`))

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status)
  }
  Logger.error({ err }, "unhandled error")
  return c.json({ error: "internal_error" }, 500)
})

Logger.info(`backendv2 listening on port ${PORT}`)

initApiServerQueue().catch((err) => {
  Logger.error({ err }, "Failed to init pg-boss queue for backendv2")
})

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 240,
}
