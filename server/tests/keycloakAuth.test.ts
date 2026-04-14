import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  buildKeycloakAuthorizationUrl,
  buildKeycloakLogoutUrl,
  createKeycloakLoginAttempt,
  exchangeKeycloakAuthorizationCode,
  getAuthProvidersConfig,
  getExpectedKeycloakIssuer,
  getKeycloakAttemptCookieNames,
  getKeycloakWebConfig,
} from "@/auth/keycloak"
import { HTTPException } from "hono/http-exception"

const originalEnv = { ...process.env }

const testKeycloakConfig = {
  publicBaseUrl: "http://localhost:8082",
  internalBaseUrl: "http://localhost:8082",
  realm: "xyne-test",
  clientId: "xyne-web",
  clientSecret: "secret",
  workspaceExternalId: "workspace-123",
  logoutRedirectUrl: "/auth",
}

const createAbortingFetch = () =>
  (async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const abort = () => {
        const error = new Error("Aborted")
        error.name = "AbortError"
        reject(error)
      }
      if (init?.signal?.aborted) {
        abort()
        return
      }
      init?.signal?.addEventListener("abort", abort, { once: true })
    })) as typeof fetch

const expectHttpExceptionStatus = async (
  promise: Promise<unknown>,
  status: HTTPException["status"],
) => {
  try {
    await promise
    throw new Error("Expected HTTPException")
  } catch (error) {
    expect(error).toBeInstanceOf(HTTPException)
    expect((error as HTTPException).status).toBe(status)
  }
}

describe("Keycloak auth helpers", () => {
  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.KEYCLOAK_WEB_ENABLED
    delete process.env.KEYCLOAK_PUBLIC_BASE_URL
    delete process.env.KEYCLOAK_INTERNAL_BASE_URL
    delete process.env.KEYCLOAK_REALM
    delete process.env.KEYCLOAK_CLIENT_ID
    delete process.env.KEYCLOAK_CLIENT_SECRET
    delete process.env.KEYCLOAK_WORKSPACE_EXTERNAL_ID
    delete process.env.KEYCLOAK_HTTP_TIMEOUT_MS
    delete process.env.GOOGLE_WEB_LOGIN_ENABLED
    delete process.env.GOOGLE_CLIENT_ID
    delete process.env.GOOGLE_CLIENT_SECRET
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test("attempt cookie names are provider-namespaced and attempt-scoped", () => {
    const names = getKeycloakAttemptCookieNames("abc123")

    expect(names.state).toBe("keycloak-web-abc123-state")
    expect(names.nonce).toBe("keycloak-web-abc123-nonce")
    expect(names.codeVerifier).toBe("keycloak-web-abc123-code-verifier")
  })

  test("provider availability requires the expected env vars", () => {
    expect(getAuthProvidersConfig()).toEqual({
      googleWebEnabled: false,
      keycloakWebEnabled: false,
    })

    process.env.GOOGLE_CLIENT_ID = "google-client"
    process.env.GOOGLE_CLIENT_SECRET = "google-secret"
    process.env.KEYCLOAK_WEB_ENABLED = "true"
    process.env.KEYCLOAK_PUBLIC_BASE_URL = "http://localhost:8082"
    process.env.KEYCLOAK_REALM = "xyne"
    process.env.KEYCLOAK_CLIENT_ID = "xyne-web"
    process.env.KEYCLOAK_CLIENT_SECRET = "secret"
    process.env.KEYCLOAK_WORKSPACE_EXTERNAL_ID = "workspace-123"

    expect(getAuthProvidersConfig()).toEqual({
      googleWebEnabled: true,
      keycloakWebEnabled: true,
    })
  })

  test("keycloak config defaults internal url to public url", () => {
    process.env.KEYCLOAK_WEB_ENABLED = "true"
    process.env.KEYCLOAK_PUBLIC_BASE_URL = "http://localhost:8082/"
    process.env.KEYCLOAK_REALM = "xyne"
    process.env.KEYCLOAK_CLIENT_ID = "xyne-web"
    process.env.KEYCLOAK_CLIENT_SECRET = "secret"
    process.env.KEYCLOAK_WORKSPACE_EXTERNAL_ID = "workspace-123"

    const config = getKeycloakWebConfig()

    expect(config).not.toBeNull()
    expect(config?.publicBaseUrl).toBe("http://localhost:8082")
    expect(config?.internalBaseUrl).toBe("http://localhost:8082")
    expect(getExpectedKeycloakIssuer(config!)).toBe(
      "http://localhost:8082/realms/xyne",
    )
  })

  test("login attempt includes PKCE values", () => {
    const attempt = createKeycloakLoginAttempt()

    expect(attempt.attemptId.length).toBeGreaterThan(0)
    expect(attempt.nonce.length).toBeGreaterThan(0)
    expect(attempt.codeVerifier.length).toBeGreaterThan(0)
    expect(attempt.codeChallenge.length).toBeGreaterThan(0)
  })

  test("logout url includes id token hint when present", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          end_session_endpoint:
            "http://localhost:8082/realms/xyne-logout/protocol/openid-connect/logout",
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    try {
      const logoutUrl = await buildKeycloakLogoutUrl(
        {
          publicBaseUrl: "http://localhost:8082",
          internalBaseUrl: "http://localhost:8082",
          realm: "xyne-logout",
          clientId: "xyne-web",
          clientSecret: "secret",
          workspaceExternalId: "workspace-123",
          logoutRedirectUrl: "/auth",
        },
        "http://localhost:5173/auth",
        "id-token",
      )

      const url = new URL(logoutUrl)
      expect(url.searchParams.get("client_id")).toBe("xyne-web")
      expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
        "http://localhost:5173/auth",
      )
      expect(url.searchParams.get("state")).toBeNull()
      expect(url.searchParams.get("id_token_hint")).toBe("id-token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("discovery fetch timeout surfaces 504", async () => {
    const originalFetch = globalThis.fetch
    process.env.KEYCLOAK_HTTP_TIMEOUT_MS = "1"
    globalThis.fetch = createAbortingFetch()

    try {
      await expectHttpExceptionStatus(
        buildKeycloakAuthorizationUrl(
          testKeycloakConfig,
          "http://localhost:3000/v1/auth/keycloak/callback",
          createKeycloakLoginAttempt(),
        ),
        504,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("token exchange timeout surfaces 504", async () => {
    const originalFetch = globalThis.fetch
    process.env.KEYCLOAK_HTTP_TIMEOUT_MS = "1"
    globalThis.fetch = createAbortingFetch()

    try {
      await expectHttpExceptionStatus(
        exchangeKeycloakAuthorizationCode(
          testKeycloakConfig,
          "code",
          "code-verifier",
          "http://localhost:3000/v1/auth/keycloak/callback",
        ),
        504,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("discovery failure clears cached promise for retry", async () => {
    const originalFetch = globalThis.fetch
    const retryConfig = {
      ...testKeycloakConfig,
      realm: "xyne-cache-retry",
    }
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response("unavailable", { status: 503 })
      }
      return new Response(
        JSON.stringify({
          authorization_endpoint:
            "http://localhost:8082/realms/xyne-cache-retry/protocol/openid-connect/auth",
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    try {
      await expectHttpExceptionStatus(
        buildKeycloakAuthorizationUrl(
          retryConfig,
          "http://localhost:3000/v1/auth/keycloak/callback",
          createKeycloakLoginAttempt(),
        ),
        502,
      )

      const authUrl = await buildKeycloakAuthorizationUrl(
        retryConfig,
        "http://localhost:3000/v1/auth/keycloak/callback",
        createKeycloakLoginAttempt(),
      )

      expect(calls).toBe(2)
      expect(new URL(authUrl).pathname).toBe(
        "/realms/xyne-cache-retry/protocol/openid-connect/auth",
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
