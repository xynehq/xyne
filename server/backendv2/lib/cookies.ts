import type { Context } from "hono"
import config from "@/config"
import { deleteCookieByEnv, setCookieByEnv } from "@/utils"

// Use the same cookie names xyne uses so the session is interoperable across
// both products (DB and Vespa are shared; cookies follow that contract).
export const ACCESS_COOKIE = config.AccessTokenCookie // "access-token"
export const REFRESH_COOKIE = "refresh-token"

const baseOpts = {
  secure: true,
  path: "/",
  httpOnly: true,
  maxAge: config.RefreshTokenTTL,
} as const

export const setSessionCookies = (
  c: Context,
  accessToken: string,
  refreshToken: string,
): void => {
  setCookieByEnv(c, ACCESS_COOKIE, accessToken, baseOpts)
  setCookieByEnv(c, REFRESH_COOKIE, refreshToken, baseOpts)
}

export const clearSessionCookies = (c: Context): void => {
  deleteCookieByEnv(c, ACCESS_COOKIE, baseOpts)
  deleteCookieByEnv(c, REFRESH_COOKIE, baseOpts)
}
