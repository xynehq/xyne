import type { Context, MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { googleAuth } from "@hono/oauth-providers/google"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { issueSessionForGoogle } from "../lib/userUpsert"
import { setSessionCookies } from "../lib/cookies"

const Logger = getLogger(Subsystem.Auth).child({ module: "backendv2/google" })

const clientId = process.env["GOOGLE_CLIENT_ID"]
const clientSecret = process.env["GOOGLE_CLIENT_SECRET"]
// Use the exact value already registered in the GCP console (xyne's value).
const REDIRECT_URI = process.env["GOOGLE_REDIRECT_URI"] ?? ""
const UI_BASE_URL =
  process.env["BACKENDV2_UI_BASE_URL"] ?? "http://localhost:5176"

if (!clientId || !clientSecret || !REDIRECT_URI) {
  Logger.warn(
    "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI missing — Google login will 503",
  )
}

export const googleAuthMiddleware: MiddlewareHandler = (c, next) => {
  if (!clientId || !clientSecret || !REDIRECT_URI) {
    throw new HTTPException(503, { message: "Google OAuth not configured" })
  }
  return googleAuth({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    client_id: clientId,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    client_secret: clientSecret,
    scope: ["openid", "email", "profile"],
    // eslint-disable-next-line @typescript-eslint/naming-convention
    redirect_uri: REDIRECT_URI,
    // hono/oauth-providers uses a wider Context type than ours; passthrough.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
  })(c as any, next)
}

export const googleCallback = async (c: Context): Promise<Response> => {
  type GoogleUser = {
    email?: string
    // eslint-disable-next-line @typescript-eslint/naming-convention
    verified_email?: boolean
    name?: string
    // eslint-disable-next-line @typescript-eslint/naming-convention
    given_name?: string
    // eslint-disable-next-line @typescript-eslint/naming-convention
    family_name?: string
    picture?: string
    hd?: string
  }
  const googleUser = c.get("user-google") as GoogleUser | undefined

  const email = googleUser?.email
  if (!email) {
    throw new HTTPException(400, { message: "Missing email from Google" })
  }
  if (!googleUser?.verified_email) {
    throw new HTTPException(403, { message: "Email not verified by Google" })
  }
  const domain = googleUser.hd ?? (email.split("@")[1] ?? "")
  if (!domain) {
    throw new HTTPException(400, { message: "Missing email domain" })
  }
  const name =
    googleUser.name ?? googleUser.given_name ?? googleUser.family_name ?? ""
  const photoLink = googleUser.picture ?? ""

  try {
    const { accessToken, refreshToken } = await issueSessionForGoogle({
      email,
      name,
      photoLink,
      domain,
    })
    setSessionCookies(c, accessToken, refreshToken)
    Logger.info({ email }, "google login ok")
    return c.redirect(UI_BASE_URL + "/")
  } catch (err) {
    Logger.error({ err }, "google login failed")
    const message = err instanceof Error ? err.message : "Login failed"
    return c.redirect(
      `${UI_BASE_URL}/signin?error=${encodeURIComponent(message)}`,
    )
  }
}
