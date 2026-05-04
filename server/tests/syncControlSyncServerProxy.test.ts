import { describe, expect, test } from "bun:test"
import { buildSyncServerProxyHeaders } from "@/api/syncServerProxy"
import { HTTPException } from "hono/http-exception"

describe("sync-server proxy credentials", () => {
  test("forwards browser access-token cookies", () => {
    expect(
      buildSyncServerProxyHeaders({
        token: "cookie-token",
        authorization: null,
        accessTokenCookieName: "access-token",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      Cookie: "access-token=cookie-token",
    })
  })

  test("forwards bearer tokens for curl and scripts", () => {
    expect(
      buildSyncServerProxyHeaders({
        token: null,
        authorization: "Bearer api-token",
        accessTokenCookieName: "access-token",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer api-token",
    })
  })

  test("preserves both cookie and authorization credentials when both exist", () => {
    expect(
      buildSyncServerProxyHeaders({
        token: "cookie-token",
        authorization: "Bearer api-token",
        accessTokenCookieName: "access-token",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      Cookie: "access-token=cookie-token",
      Authorization: "Bearer api-token",
    })
  })

  test("rejects proxy calls with no credentials", () => {
    expect(() =>
      buildSyncServerProxyHeaders({
        token: null,
        authorization: null,
        accessTokenCookieName: "access-token",
      }),
    ).toThrow(HTTPException)
  })
})
