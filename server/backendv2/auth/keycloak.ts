import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getCookie } from "hono/cookie"
import config from "@/config"
import { deleteCookieByEnv, setCookieByEnv } from "@/utils"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  buildKeycloakAuthorizationUrl,
  createKeycloakLoginAttempt,
  exchangeKeycloakAuthorizationCode,
  getKeycloakAttemptCookieNames,
  getKeycloakWebConfig,
  verifyKeycloakIdToken,
} from "@/auth/keycloak"
import { issueSessionForKeycloak } from "../lib/userUpsert"
import { setSessionCookies } from "../lib/cookies"

const Logger = getLogger(Subsystem.Auth).child({
  module: "backendv2/keycloak",
})

// Match xyne's redirect URI exactly so the Keycloak `xyne-web` client doesn't
// need a new entry. The path /v1/auth/keycloak/callback was already used by
// xyne; backendv2 now owns it.
const REDIRECT_URI = new URL(
  "/v1/auth/keycloak/callback",
  config.host,
).toString()

// Same-origin in prod (backendv2 also serves the SPA). Env override is only
// needed when the SPA lives on a different origin (vite dev :5176).
const UI_BASE_URL = process.env["BACKENDV2_UI_BASE_URL"] ?? ""

const router = new Hono()

const redirectWithError = (c: Context, code: string): Response =>
  c.redirect(`${UI_BASE_URL}/signin?error=${encodeURIComponent(code)}`)

router.get("/start", async (c) => {
  const cfg = getKeycloakWebConfig()
  if (!cfg) {
    return redirectWithError(c, "keycloak_unavailable")
  }
  try {
    const attempt = createKeycloakLoginAttempt()
    const cookies = getKeycloakAttemptCookieNames(attempt.attemptId)
    const authUrl = await buildKeycloakAuthorizationUrl(
      cfg,
      REDIRECT_URI,
      attempt,
    )

    const opts = {
      secure: true,
      path: "/",
      httpOnly: true,
      maxAge: 60 * 10,
    }
    setCookieByEnv(c, cookies.state, attempt.attemptId, opts)
    setCookieByEnv(c, cookies.nonce, attempt.nonce, opts)
    setCookieByEnv(c, cookies.codeVerifier, attempt.codeVerifier, opts)

    return c.redirect(authUrl)
  } catch (err) {
    Logger.error({ err }, "failed to initiate Keycloak login")
    return redirectWithError(c, "keycloak_unavailable")
  }
})

router.get("/callback", async (c) => {
  const cfg = getKeycloakWebConfig()
  if (!cfg) {
    return redirectWithError(c, "keycloak_unavailable")
  }

  const state = c.req.query("state")
  const code = c.req.query("code")
  const error = c.req.query("error")

  const cookieOpts = { secure: true, path: "/", httpOnly: true } as const

  const clearAttemptCookies = (attemptId: string): void => {
    const names = getKeycloakAttemptCookieNames(attemptId)
    deleteCookieByEnv(c, names.state, cookieOpts)
    deleteCookieByEnv(c, names.nonce, cookieOpts)
    deleteCookieByEnv(c, names.codeVerifier, cookieOpts)
  }

  if (error) {
    if (state) {
      clearAttemptCookies(state)
    }
    return redirectWithError(c, error)
  }
  if (!state || !code) {
    return redirectWithError(c, "keycloak_failed")
  }

  const names = getKeycloakAttemptCookieNames(state)
  const storedState = getCookie(c, names.state)
  const storedNonce = getCookie(c, names.nonce)
  const storedCodeVerifier = getCookie(c, names.codeVerifier)
  clearAttemptCookies(state)

  if (storedState !== state || !storedNonce || !storedCodeVerifier) {
    return redirectWithError(c, "keycloak_failed")
  }

  try {
    const tokenResponse = await exchangeKeycloakAuthorizationCode(
      cfg,
      code,
      storedCodeVerifier,
      REDIRECT_URI,
    )
    const idToken = tokenResponse.id_token
    if (!idToken) {
      throw new HTTPException(401, {
        message: "Keycloak did not return an ID token",
      })
    }
    const payload = await verifyKeycloakIdToken(cfg, idToken, storedNonce)

    const email = payload.email.trim().toLowerCase()
    if (!email) {
      throw new HTTPException(400, {
        message: "Keycloak token did not include a usable email claim",
      })
    }
    const name =
      (typeof payload.name === "string" && payload.name) ||
      (typeof payload.preferred_username === "string" &&
        payload.preferred_username) ||
      email

    const { accessToken, refreshToken } = await issueSessionForKeycloak({
      email,
      name,
      workspaceExternalId: cfg.workspaceExternalId,
    })
    setSessionCookies(c, accessToken, refreshToken)
    Logger.info({ email }, "keycloak login ok")
    return c.redirect(UI_BASE_URL + "/")
  } catch (err) {
    Logger.error({ err }, "keycloak callback failed")
    return redirectWithError(c, "keycloak_failed")
  }
})

export default router
