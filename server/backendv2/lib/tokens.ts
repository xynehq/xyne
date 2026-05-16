import { sign, verify } from "hono/jwt"
import config from "@/config"
import type { InternalAuthProvider } from "@/auth/keycloak"

const accessTokenSecret = process.env["ACCESS_TOKEN_SECRET"]
const refreshTokenSecret = process.env["REFRESH_TOKEN_SECRET"]

if (!accessTokenSecret || !refreshTokenSecret) {
  throw new Error(
    "ACCESS_TOKEN_SECRET and REFRESH_TOKEN_SECRET must be set (shared env with xyne)",
  )
}

const accessSecret: string = accessTokenSecret
const refreshSecret: string = refreshTokenSecret

export type JwtPayload = {
  sub: string
  role: string
  workspaceId: string
  tokenType: "access" | "refresh"
  authProvider?: InternalAuthProvider
  exp: number
}

export const generateAccessToken = async (
  email: string,
  role: string,
  workspaceExternalId: string,
  authProvider?: InternalAuthProvider,
): Promise<string> =>
  sign(
    {
      sub: email,
      role,
      workspaceId: workspaceExternalId,
      tokenType: "access",
      exp: Math.floor(Date.now() / 1000) + config.AccessTokenTTL,
      ...(authProvider ? { authProvider } : {}),
    },
    accessSecret,
  )

export const generateRefreshToken = async (
  email: string,
  role: string,
  workspaceExternalId: string,
  authProvider?: InternalAuthProvider,
): Promise<string> =>
  sign(
    {
      sub: email,
      role,
      workspaceId: workspaceExternalId,
      tokenType: "refresh",
      exp: Math.floor(Date.now() / 1000) + config.RefreshTokenTTL,
      ...(authProvider ? { authProvider } : {}),
    },
    refreshSecret,
  )

export const verifyAccess = async (token: string): Promise<JwtPayload> =>
  (await verify(token, accessSecret)) as JwtPayload

export const verifyRefresh = async (token: string): Promise<JwtPayload> =>
  (await verify(token, refreshSecret)) as JwtPayload
