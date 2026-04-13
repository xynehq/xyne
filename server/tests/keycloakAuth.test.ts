import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  buildKeycloakLogoutUrl,
  createKeycloakLoginAttempt,
  getAuthProvidersConfig,
  getExpectedKeycloakIssuer,
  getKeycloakAttemptCookieNames,
  getKeycloakWebConfig,
} from "@/auth/keycloak"

const originalEnv = { ...process.env }

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
      )) as typeof fetch

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
        "logout-state",
        "id-token",
      )

      const url = new URL(logoutUrl)
      expect(url.searchParams.get("client_id")).toBe("xyne-web")
      expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
        "http://localhost:5173/auth",
      )
      expect(url.searchParams.get("state")).toBe("logout-state")
      expect(url.searchParams.get("id_token_hint")).toBe("id-token")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
