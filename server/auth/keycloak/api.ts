import { Hono } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { getKeycloakConfig } from "./config"
import { getClientResolver } from "./client-resolver"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

// OAuth callback schema
const oauthCallbackSchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

const app = new Hono()

// Enable CORS for frontend requests
app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000"],
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
)

// Handle Keycloak OAuth callback via GET (browser redirect)
app.get("/callback", zValidator("query", oauthCallbackSchema), async (c) => {
  const { code, state, error, error_description } = c.req.valid("query")
  const keycloakConfig = getKeycloakConfig()

  if (error) {
    Logger.error("Keycloak OAuth error:", error, error_description)
    return c.redirect(
      `/auth?error=${encodeURIComponent(error_description || error)}`,
    )
  }

  if (!code) {
    Logger.error("No authorization code received from Keycloak")
    return c.redirect("/auth?error=No authorization code received")
  }

  try {
    // Resolve client for authorization code flow
    const clientResolver = getClientResolver(keycloakConfig)
    const client = await clientResolver.resolveClient('authorization-code')

    // Exchange authorization code for tokens
    const tokenUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/token`

    const baseParams = {
      grant_type: "authorization_code",
      code: code,
      redirect_uri: `${c.req.header("host")}/api/keycloak/callback`,
    }

    const body = clientResolver.buildTokenParams(client, baseParams)

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body,
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      Logger.error("Token exchange failed:", errorText)
      return c.redirect("/auth?error=Token exchange failed")
    }

    const tokens = await tokenResponse.json()

    // Store token in cookie (or localStorage via client-side)
    c.header(
      "Set-Cookie",
      `xyne-auth-token=${tokens.access_token}; Path=/; HttpOnly=false; SameSite=Strict`,
    )

    Logger.info("Keycloak authentication successful")
    return c.redirect("/home")
  } catch (error) {
    Logger.error("Keycloak OAuth callback error:", error)
    return c.redirect("/auth?error=Authentication failed")
  }
})

// Handle Keycloak OAuth callback via POST (frontend AJAX call)
app.post("/callback", async (c) => {
  try {
    const { code, state, expectedEmail } = await c.req.json()
    const keycloakConfig = getKeycloakConfig()

    if (!code) {
      Logger.error("No authorization code provided")
      return c.json({ error: "Authorization code is required" }, 400)
    }

    Logger.info("Exchanging authorization code for tokens")

    // Resolve client for authorization code flow
    const clientResolver = getClientResolver(keycloakConfig)
    const client = await clientResolver.resolveClient('authorization-code')

    // Exchange authorization code for tokens
    const tokenUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/token`

    const baseParams = {
      grant_type: "authorization_code",
      code: code,
      redirect_uri: "http://localhost:5173/auth", // Fixed redirect URI
    }

    const body = clientResolver.buildTokenParams(client, baseParams)

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    })

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text()
      Logger.error("Token exchange failed:", errorText)
      return c.json(
        {
          error: "Failed to exchange authorization code",
          details: errorText,
        },
        400,
      )
    }

    const tokens = await tokenResponse.json()

    if (!tokens.access_token) {
      Logger.error("No access token in response:", tokens)
      return c.json({ error: "No access token received" }, 400)
    }

    // Validate email match if expectedEmail was provided
    if (expectedEmail) {
      try {
        // Decode the JWT to get the actual email
        const payload = JSON.parse(
          Buffer.from(tokens.access_token.split(".")[1], "base64").toString(),
        )
        const actualEmail = payload.email || payload.preferred_username

        if (
          actualEmail &&
          actualEmail.toLowerCase() !== expectedEmail.toLowerCase()
        ) {
          Logger.warn(
            `Email mismatch: expected ${expectedEmail}, got ${actualEmail}`,
          )
          return c.json(
            {
              error: "Email mismatch",
              message: `SSO authentication failed. You entered "${expectedEmail}" but your Keycloak account is "${actualEmail}". Please enter the correct email address that matches your SSO account.`,
            },
            400,
          )
        }

        Logger.info(`Email validation passed: ${actualEmail}`)
      } catch (emailValidationError) {
        Logger.error("Email validation error:", emailValidationError)
        // Continue without email validation if decoding fails
      }
    }

    Logger.info("Token exchange successful")

    // Set cookies for the browser (similar to email/password flow)
    const accessCookie = `access-token=${tokens.access_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=${tokens.expires_in || 3600}`
    const refreshCookie = tokens.refresh_token 
      ? `refresh-token=${tokens.refresh_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=1800`
      : null

    // Set multiple cookies properly - use an array to set multiple cookies
    const cookies = [accessCookie]
    if (refreshCookie) {
      cookies.push(refreshCookie)
    }
    
    // Set all cookies using multiple header calls
    cookies.forEach(cookie => {
      c.res.headers.append("Set-Cookie", cookie)
    })

    // Return the access token to the frontend
    return c.json({
      access_token: tokens.access_token,
      token_type: tokens.token_type || "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      success: true,
    })
  } catch (error) {
    Logger.error("Keycloak OAuth callback error:", error)
    return c.json(
      {
        error: "Authentication failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    )
  }
})

// Refresh token endpoint
app.post("/refresh", async (c) => {
  const keycloakConfig = getKeycloakConfig()
  const refreshToken = c.req.header("x-refresh-token")

  if (!refreshToken) {
    return c.json({ error: "No refresh token provided" }, 400)
  }

  try {
    // Resolve client for token refresh
    const clientResolver = getClientResolver(keycloakConfig)
    const client = await clientResolver.resolveClient('token-refresh')

    const tokenUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/token`

    const baseParams = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }

    const body = clientResolver.buildTokenParams(client, baseParams)

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body,
    })

    if (!response.ok) {
      const errorText = await response.text()
      Logger.error("Token refresh failed:", errorText)
      return c.json({ error: "Token refresh failed" }, 401)
    }

    const tokens = await response.json()
    return c.json({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
    })
  } catch (error) {
    Logger.error("Token refresh error:", error)
    return c.json({ error: "Token refresh failed" }, 500)
  }
})

// Email/Password login endpoint
app.post("/login", async (c) => {
  try {
    const { email, password } = await c.req.json()
    const keycloakConfig = getKeycloakConfig()

    if (!email || !password) {
      Logger.error("Email and password are required")
      return c.json({ error: "Email and password are required" }, 400)
    }

    Logger.info("Attempting password grant for user:", email)

    // Use client resolver with automatic fallback
    const clientResolver = getClientResolver(keycloakConfig)
    const tokenUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/token`

    const baseParams = {
      grant_type: "password",
      username: email,
      password: password,
      scope: "openid email profile",
    }

    const response = await clientResolver.performTokenRequest(tokenUrl, 'password-grant', baseParams)

    if (!response.ok) {
      const errorText = await response.text()
      Logger.error("Password grant failed:", errorText)
      
      let errorMessage = "Invalid email or password"
      try {
        const errorData = JSON.parse(errorText)
        if (errorData.error_description) {
          errorMessage = errorData.error_description
        }
      } catch (e) {
        // Use default error message
      }
      
      return c.json({ error: errorMessage }, 401)
    }

    const tokens = await response.json()

    if (!tokens.access_token) {
      Logger.error("No access token in response:", tokens)
      return c.json({ error: "Authentication failed" }, 401)
    }

    Logger.info("Password grant successful for user:", email)

    // Set cookies for the browser (similar to Google OAuth flow)
    const accessCookie = `access-token=${tokens.access_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=${tokens.expires_in || 3600}`
    const refreshCookie = tokens.refresh_token 
      ? `refresh-token=${tokens.refresh_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=1800`
      : null

    // Set multiple cookies properly - use an array to set multiple cookies
    const cookies = [accessCookie]
    if (refreshCookie) {
      cookies.push(refreshCookie)
    }
    
    // Set all cookies using multiple header calls
    cookies.forEach(cookie => {
      c.res.headers.append("Set-Cookie", cookie)
    })

    // Also return the tokens to the frontend
    return c.json({
      access_token: tokens.access_token,
      token_type: tokens.token_type || "Bearer",
      expires_in: tokens.expires_in,
      refresh_token: tokens.refresh_token,
      scope: tokens.scope,
      success: true,
    })
  } catch (error) {
    Logger.error("Email/password login error:", error)
    return c.json(
      {
        error: "Authentication failed",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    )
  }
})

// Logout endpoint
app.post("/logout", async (c) => {
  const keycloakConfig = getKeycloakConfig()
  const refreshToken = c.req.header("x-refresh-token")

  try {
    if (refreshToken) {
      // Resolve client for logout operation
      const clientResolver = getClientResolver(keycloakConfig)
      const client = await clientResolver.resolveClient('admin-api')

      // Revoke token in Keycloak
      const logoutUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/logout`

      const baseParams = {
        refresh_token: refreshToken,
      }

      const body = clientResolver.buildTokenParams(client, baseParams)

      await fetch(logoutUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body,
      })
    }

    // Clear cookies
    c.header(
      "Set-Cookie",
      "xyne-auth-token=; Path=/; HttpOnly=false; SameSite=Strict; Max-Age=0",
    )
    c.header(
      "Set-Cookie",
      "xyne-refresh-token=; Path=/; HttpOnly=false; SameSite=Strict; Max-Age=0",
    )

    return c.json({ success: true })
  } catch (error) {
    Logger.error("Logout error:", error)
    return c.json({ error: "Logout failed" }, 500)
  }
})

export default app