import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
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
})
