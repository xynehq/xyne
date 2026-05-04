import { HTTPException } from "hono/http-exception"

export const buildSyncServerProxyHeaders = ({
  token,
  authorization,
  accessTokenCookieName,
}: {
  token?: string | null
  authorization?: string | null
  accessTokenCookieName: string
}): HeadersInit => {
  if (!token && !authorization) {
    throw new HTTPException(401, { message: "No authentication token" })
  }

  return {
    "Content-Type": "application/json",
    ...(token ? { Cookie: `${accessTokenCookieName}=${token}` } : {}),
    ...(authorization ? { Authorization: authorization } : {}),
  }
}
