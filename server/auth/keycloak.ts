import crypto from "node:crypto"
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose"
import { HTTPException } from "hono/http-exception"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Auth)

export type InternalAuthProvider = "google" | "keycloak"

export interface AuthProvidersConfig {
  googleWebEnabled: boolean
  keycloakWebEnabled: boolean
}

export interface KeycloakWebConfig {
  publicBaseUrl: string
  internalBaseUrl: string
  realm: string
  clientId: string
  clientSecret: string
  workspaceExternalId: string
  logoutRedirectUrl: string
}

export interface KeycloakLoginAttempt {
  attemptId: string
  nonce: string
  codeVerifier: string
  codeChallenge: string
}

interface KeycloakDiscoveryDocument {
  issuer?: string
  authorization_endpoint?: string
  end_session_endpoint?: string
}

const metadataCache = new Map<string, Promise<KeycloakDiscoveryDocument>>()
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "")

const buildRealmUrl = (baseUrl: string, realm: string) =>
  `${trimTrailingSlash(baseUrl)}/realms/${realm}`

const getMetadataCacheKey = (config: KeycloakWebConfig) =>
  `${config.internalBaseUrl}|${config.realm}`

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing required Keycloak environment variable: ${name}`)
  }
  return value
}

function getBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]
  if (value === undefined) return defaultValue
  return value === "true"
}

export function isGoogleWebLoginEnabled(): boolean {
  return (
    getBooleanEnv("GOOGLE_WEB_LOGIN_ENABLED", true) &&
    Boolean(process.env.GOOGLE_CLIENT_ID?.trim()) &&
    Boolean(process.env.GOOGLE_CLIENT_SECRET?.trim())
  )
}

export function isKeycloakWebLoginEnabled(): boolean {
  return (
    getBooleanEnv("KEYCLOAK_WEB_ENABLED", false) &&
    Boolean(process.env.KEYCLOAK_PUBLIC_BASE_URL?.trim()) &&
    Boolean(
      (process.env.KEYCLOAK_INTERNAL_BASE_URL ||
        process.env.KEYCLOAK_PUBLIC_BASE_URL)?.trim(),
    ) &&
    Boolean(process.env.KEYCLOAK_REALM?.trim()) &&
    Boolean(process.env.KEYCLOAK_CLIENT_ID?.trim()) &&
    Boolean(process.env.KEYCLOAK_CLIENT_SECRET?.trim()) &&
    Boolean(process.env.KEYCLOAK_WORKSPACE_EXTERNAL_ID?.trim())
  )
}

export function getAuthProvidersConfig(): AuthProvidersConfig {
  return {
    googleWebEnabled: isGoogleWebLoginEnabled(),
    keycloakWebEnabled: isKeycloakWebLoginEnabled(),
  }
}

export function getKeycloakWebConfig(): KeycloakWebConfig | null {
  if (!isKeycloakWebLoginEnabled()) {
    return null
  }

  return {
    publicBaseUrl: trimTrailingSlash(getRequiredEnv("KEYCLOAK_PUBLIC_BASE_URL")),
    internalBaseUrl: trimTrailingSlash(
      (
        process.env.KEYCLOAK_INTERNAL_BASE_URL ||
        process.env.KEYCLOAK_PUBLIC_BASE_URL
      )!.trim(),
    ),
    realm: getRequiredEnv("KEYCLOAK_REALM"),
    clientId: getRequiredEnv("KEYCLOAK_CLIENT_ID"),
    clientSecret: getRequiredEnv("KEYCLOAK_CLIENT_SECRET"),
    workspaceExternalId: getRequiredEnv("KEYCLOAK_WORKSPACE_EXTERNAL_ID"),
    logoutRedirectUrl: (
      process.env.KEYCLOAK_LOGOUT_REDIRECT_URL || "/auth"
    ).trim(),
  }
}

export function getKeycloakAttemptCookieNames(attemptId: string) {
  return {
    state: `keycloak-web-${attemptId}-state`,
    nonce: `keycloak-web-${attemptId}-nonce`,
    codeVerifier: `keycloak-web-${attemptId}-code-verifier`,
  }
}

export function createKeycloakLoginAttempt(): KeycloakLoginAttempt {
  const codeVerifier = crypto.randomBytes(32).toString("base64url")
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url")

  return {
    attemptId: crypto.randomUUID(),
    nonce: crypto.randomBytes(32).toString("base64url"),
    codeVerifier,
    codeChallenge,
  }
}

async function fetchKeycloakDiscoveryDocument(
  config: KeycloakWebConfig,
): Promise<KeycloakDiscoveryDocument> {
  const cacheKey = getMetadataCacheKey(config)
  const existing = metadataCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const promise = (async () => {
    const discoveryUrl = `${buildRealmUrl(config.internalBaseUrl, config.realm)}/.well-known/openid-configuration`
    const response = await fetch(discoveryUrl)
    if (!response.ok) {
      Logger.error(
        { status: response.status, discoveryUrl },
        "Failed to fetch Keycloak discovery document",
      )
      throw new HTTPException(502, {
        message: "Unable to reach Keycloak discovery endpoint",
      })
    }

    return (await response.json()) as KeycloakDiscoveryDocument
  })()

  metadataCache.set(cacheKey, promise)

  try {
    return await promise
  } catch (error) {
    metadataCache.delete(cacheKey)
    throw error
  }
}

function getOrCreateInternalJwks(config: KeycloakWebConfig) {
  const jwksUrl = `${buildRealmUrl(config.internalBaseUrl, config.realm)}/protocol/openid-connect/certs`
  let jwks = jwksCache.get(jwksUrl)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl))
    jwksCache.set(jwksUrl, jwks)
  }
  return jwks
}

export function getExpectedKeycloakIssuer(config: KeycloakWebConfig): string {
  return buildRealmUrl(config.publicBaseUrl, config.realm)
}

export async function buildKeycloakAuthorizationUrl(
  config: KeycloakWebConfig,
  redirectUri: string,
  attempt: KeycloakLoginAttempt,
): Promise<string> {
  const discovery = await fetchKeycloakDiscoveryDocument(config)
  const authorizationEndpoint =
    discovery.authorization_endpoint ||
    `${buildRealmUrl(config.publicBaseUrl, config.realm)}/protocol/openid-connect/auth`

  const url = new URL(authorizationEndpoint)
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("scope", "openid email profile")
  url.searchParams.set("state", attempt.attemptId)
  url.searchParams.set("nonce", attempt.nonce)
  url.searchParams.set("code_challenge", attempt.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

export async function exchangeKeycloakAuthorizationCode(
  config: KeycloakWebConfig,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{
  access_token: string
  id_token: string
  refresh_token?: string
  expires_in?: number
}> {
  const tokenEndpoint = `${buildRealmUrl(config.internalBaseUrl, config.realm)}/protocol/openid-connect/token`

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  })

  if (!response.ok) {
    const details = await response.text()
    Logger.error(
      { status: response.status, details },
      "Keycloak token exchange failed",
    )
    throw new HTTPException(401, {
      message: "Keycloak token exchange failed",
    })
  }

  return (await response.json()) as {
    access_token: string
    id_token: string
    refresh_token?: string
    expires_in?: number
  }
}

export async function verifyKeycloakIdToken(
  config: KeycloakWebConfig,
  idToken: string,
  expectedNonce: string,
): Promise<JWTPayload & { email: string }> {
  const jwks = getOrCreateInternalJwks(config)
  const expectedIssuer = getExpectedKeycloakIssuer(config)

  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: expectedIssuer,
      audience: config.clientId,
    })

    if (payload.nonce !== expectedNonce) {
      throw new HTTPException(401, { message: "Invalid Keycloak nonce" })
    }

    if (typeof payload.email !== "string" || payload.email.length === 0) {
      throw new HTTPException(400, {
        message: "Keycloak token did not include an email claim",
      })
    }

    return payload as JWTPayload & { email: string }
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }

    Logger.error(error, "Keycloak ID token verification failed")
    throw new HTTPException(401, {
      message: "Invalid Keycloak identity token",
    })
  }
}

export async function buildKeycloakLogoutUrl(
  config: KeycloakWebConfig,
  postLogoutRedirectUri: string,
  state: string,
  idTokenHint?: string,
): Promise<string> {
  const discovery = await fetchKeycloakDiscoveryDocument(config)
  const endSessionEndpoint =
    discovery.end_session_endpoint ||
    `${buildRealmUrl(config.publicBaseUrl, config.realm)}/protocol/openid-connect/logout`

  const url = new URL(endSessionEndpoint)
  url.searchParams.set("client_id", config.clientId)
  url.searchParams.set("post_logout_redirect_uri", postLogoutRedirectUri)
  url.searchParams.set("state", state)
  if (idTokenHint) {
    url.searchParams.set("id_token_hint", idTokenHint)
  }
  return url.toString()
}
