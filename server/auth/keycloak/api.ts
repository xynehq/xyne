import { Hono } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { getKeycloakConfig } from "./config"
import { getClientResolver } from "./client-resolver"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { UserRole } from "@/shared/types"
import { db } from "@/db/client"
import { 
  getUserByEmail, 
  createUser, 
  getPublicUserAndWorkspaceByEmail
} from "@/db/user"
import { createWorkspace, getWorkspaceByDomain } from "@/db/workspace"

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

// WebAuthn/Passkey endpoints

// Check if user has passkey and initiate authentication/registration
app.post("/webauthn-login", async (c) => {
  try {
    const { email } = await c.req.json()
    
    if (!email) {
      Logger.error("Email is required for passkey authentication")
      return c.json({ error: "Email is required" }, 400)
    }

    Logger.info("Checking passkey availability for user:", email)
    
    // Check if user has passkey (using in-memory store for demo)
    // In real implementation, you would check Keycloak user attributes or external DB
    const userPasskeys = (global as any).userPasskeys || new Set()
    const hasPasskey = userPasskeys.has(email)
    
    // Generate a challenge (in real implementation, store this temporarily)
    const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')
    
    return c.json({
      hasPasskey,
      challenge,
      email
    })
  } catch (error) {
    Logger.error("WebAuthn login initiation error:", error)
    return c.json({ error: "Failed to initiate passkey authentication" }, 500)
  }
})

// Register a new passkey for the user
app.post("/webauthn-register", async (c) => {
  try {
    const { email, credential } = await c.req.json()
    
    if (!email || !credential) {
      Logger.error("Email and credential are required for passkey registration")
      return c.json({ error: "Email and credential are required" }, 400)
    }

    Logger.info("Registering passkey for user:", email)
    
    // TODO: Implement actual credential verification and storage
    // This would involve:
    // 1. Verifying the attestation
    // 2. Storing the credential in Keycloak user attributes or external DB
    
    Logger.info("Passkey registration successful (simulated)")
    
    const keycloakConfig = getKeycloakConfig()
    
    try {
      // Step 1: Check if user exists in Keycloak, create if not
      const adminTokenResponse = await fetch(`${keycloakConfig.baseUrl}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'admin',
        }),
      })
      
      if (!adminTokenResponse.ok) {
        throw new Error('Failed to get admin token')
      }
      
      const adminTokens = await adminTokenResponse.json()
      const adminToken = adminTokens.access_token
      
      // Check if user exists
      const userCheckResponse = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.defaultRealm}/users?email=${encodeURIComponent(email)}`, {
        headers: {
          'Authorization': `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
      })
      
      let userId = null
      
      if (userCheckResponse.ok) {
        const users = await userCheckResponse.json()
        if (users.length > 0) {
          userId = users[0].id
          Logger.info("User already exists in Keycloak:", email)
          
          // Ensure existing user profile is complete
          const [localPart, domain] = email.split('@')
          const updateUserResponse = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.defaultRealm}/users/${userId}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              id: userId,
              username: email,
              email: email,
              firstName: localPart,
              lastName: domain.replace(/[^a-zA-Z0-9.\-]/g, ''),
              enabled: true,
              emailVerified: true,
            }),
          })
          
          if (!updateUserResponse.ok) {
            Logger.warn("Failed to update existing user profile, continuing anyway")
          } else {
            Logger.info("Updated existing user profile to ensure completeness")
          }
        }
      }
      
      // Create user if doesn't exist
      if (!userId) {
        Logger.info("Creating new user in Keycloak:", email)
        
        const [localPart, domain] = email.split('@')
        const createUserResponse = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.defaultRealm}/users`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: email,
            email: email,
            firstName: localPart,
            lastName: domain.replace(/[^a-zA-Z0-9.\-]/g, ''), // Remove invalid characters
            enabled: true,
            emailVerified: true,
          }),
        })
        
        if (createUserResponse.ok || createUserResponse.status === 201) {
          // Get the created user's ID
          const createdUserResponse = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.defaultRealm}/users?email=${encodeURIComponent(email)}`, {
            headers: {
              'Authorization': `Bearer ${adminToken}`,
              'Content-Type': 'application/json',
            },
          })
          
          if (createdUserResponse.ok) {
            const users = await createdUserResponse.json()
            if (users.length > 0) {
              userId = users[0].id
              Logger.info("User created successfully:", email)
            }
          }
        } else {
          throw new Error('Failed to create user in Keycloak')
        }
      }
      
      // Step 2: Create user in Xyne database if needed
      if (userId) {
        Logger.info("Creating user in Xyne database:", email)
        
        // Extract domain from email for workspace lookup
        const domain = email.split('@')[1]
        const [localPart] = email.split('@')
        
        // Check if user already exists in Xyne database
        const existingXyneUser = await getUserByEmail(db, email)
        
        let xyneUser = null
        if (existingXyneUser && existingXyneUser.length > 0) {
          Logger.info("User already exists in Xyne database:", email)
          xyneUser = existingXyneUser[0]
        } else {
          // Check if workspace exists for this domain
          const existingWorkspace = await getWorkspaceByDomain(domain)
          
          if (existingWorkspace && existingWorkspace.length > 0) {
            Logger.info("Workspace found, creating user in existing workspace")
            const workspace = existingWorkspace[0]
            const [createdUser] = await createUser(
              db,
              workspace.id,
              email,
              localPart,
              "", // photoLink - empty for now
              UserRole.User,
              workspace.externalId,
            )
            xyneUser = createdUser
          } else {
            Logger.info("Creating new workspace and user")
            // Create workspace and user in transaction
            xyneUser = await db.transaction(async (trx) => {
              const [workspace] = await createWorkspace(trx, email, domain)
              const [user] = await createUser(
                trx,
                workspace.id,
                email,
                localPart,
                "", // photoLink - empty for now
                UserRole.SuperAdmin, // First user in workspace becomes SuperAdmin
                workspace.externalId,
              )
              return user
            })
          }
        }
        
        Logger.info("Xyne database user setup completed:", xyneUser.email)
        
        // Step 3: Generate access token for the user
        const clientResolver = getClientResolver(keycloakConfig)
        
        // Since this is a new user registration, we need to set a temporary password first
        // Then use password grant to get a proper user token
        
        // Set a temporary password for the user
        const tempPassword = crypto.randomUUID() // Generate a random temporary password
        const setPasswordResponse = await fetch(`${keycloakConfig.baseUrl}/admin/realms/${keycloakConfig.defaultRealm}/users/${userId}/reset-password`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'password',
            value: tempPassword,
            temporary: false,
          }),
        })
        
        if (!setPasswordResponse.ok) {
          throw new Error('Failed to set temporary password for user')
        }
        
        // Now use password grant to get a user token
        const tokenUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/token`
        const baseParams = {
          grant_type: "password",
          username: email,
          password: tempPassword,
          scope: "openid email profile",
        }
        
        const response = await clientResolver.performTokenRequest(tokenUrl, 'password-grant', baseParams)
        
        if (response.ok) {
          const tokens = await response.json()
          
          Logger.info("Created tokens for passkey registration")
          
          // Set cookies similar to other login methods
          const accessCookie = `access-token=${tokens.access_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=${tokens.expires_in || 3600}`
          const refreshCookie = tokens.refresh_token 
            ? `refresh-token=${tokens.refresh_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=1800`
            : null
          
          c.res.headers.append("Set-Cookie", accessCookie)
          if (refreshCookie) {
            c.res.headers.append("Set-Cookie", refreshCookie)
          }
          
          // Mark that this user now has a passkey (store in memory for demo)
          ;(global as any).userPasskeys = (global as any).userPasskeys || new Set()
          ;(global as any).userPasskeys.add(email)
          
          // Store the user info for later use
          ;(global as any).passkeyUsers = (global as any).passkeyUsers || new Map()
          ;(global as any).passkeyUsers.set(email, { userId, credential, email, password: tempPassword })
          
          return c.json({
            success: true,
            message: "Passkey registered successfully",
            access_token: tokens.access_token,
            token_type: tokens.token_type || "Bearer",
            expires_in: tokens.expires_in,
            refresh_token: tokens.refresh_token,
            scope: tokens.scope,
          })
        } else {
          throw new Error('Failed to generate tokens')
        }
      } else {
        throw new Error('Failed to create or find user')
      }
    } catch (error) {
      Logger.error("Passkey registration error:", error)
      return c.json({ error: "Failed to complete passkey registration: " + (error instanceof Error ? error.message : 'Unknown error') }, 500)
    }
  } catch (error) {
    Logger.error("WebAuthn registration error:", error)
    return c.json({ error: "Failed to register passkey" }, 500)
  }
})

// Verify passkey authentication
app.post("/webauthn-verify", async (c) => {
  try {
    const { email, credential } = await c.req.json()
    
    if (!email || !credential) {
      Logger.error("Email and credential are required for passkey verification")
      return c.json({ error: "Email and credential are required" }, 400)
    }

    Logger.info("Verifying passkey for user:", email)
    
    // Check if user has passkey registered
    const userPasskeys = (global as any).userPasskeys || new Set()
    if (!userPasskeys.has(email)) {
      Logger.error("No passkey found for user:", email)
      return c.json({ error: "No passkey found for this user" }, 400)
    }
    
    // TODO: Implement actual credential verification
    // This would involve:
    // 1. Retrieving stored credential from Keycloak user attributes or external DB
    // 2. Verifying the assertion signature
    
    Logger.info("Passkey authentication successful (simulated)")
    
    const keycloakConfig = getKeycloakConfig()
    
    try {
      // Check if user exists in Xyne database
      const existingXyneUser = await getUserByEmail(db, email)
      
      if (!existingXyneUser || existingXyneUser.length === 0) {
        throw new Error("User not found in Xyne database")
      }
      
      const xyneUser = existingXyneUser[0]
      Logger.info("Found user in Xyne database:", xyneUser.email)
      
      const clientResolver = getClientResolver(keycloakConfig)
      const tokenUrl = `${keycloakConfig.baseUrl}/realms/${keycloakConfig.defaultRealm}/protocol/openid-connect/token`
      
      // Get stored user info from memory for the temporary password
      // In production, this should be replaced with proper passkey credential verification
      const passkeyUsers = (global as any).passkeyUsers || new Map()
      const userInfo = passkeyUsers.get(email)
      
      if (!userInfo) {
        throw new Error("User not found in passkey registry")
      }
      
      const storedPassword = userInfo.password || 'demo123' // Use stored password or default
      
      // Use password grant to get a proper user token
      const baseParams = {
        grant_type: "password",
        username: email,
        password: storedPassword,
        scope: "openid email profile",
      }
      
      const response = await clientResolver.performTokenRequest(tokenUrl, 'password-grant', baseParams)
      
      if (response.ok) {
        const tokens = await response.json()
        
        Logger.info("Created tokens for passkey authentication")
        
        // Set cookies similar to other login methods
        const accessCookie = `access-token=${tokens.access_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=${tokens.expires_in || 3600}`
        const refreshCookie = tokens.refresh_token 
          ? `refresh-token=${tokens.refresh_token}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=1800`
          : null
        
        c.res.headers.append("Set-Cookie", accessCookie)
        if (refreshCookie) {
          c.res.headers.append("Set-Cookie", refreshCookie)
        }
        
        return c.json({
          success: true,
          message: "Passkey authentication successful",
          access_token: tokens.access_token,
          token_type: tokens.token_type || "Bearer",
          expires_in: tokens.expires_in,
          refresh_token: tokens.refresh_token,
          scope: tokens.scope,
        })
      } else {
        throw new Error("Failed to generate authentication tokens")
      }
    } catch (error) {
      Logger.error("Passkey authentication error:", error)
      return c.json({ error: "Failed to complete passkey authentication: " + (error instanceof Error ? error.message : 'Unknown error') }, 500)
    }
  } catch (error) {
    Logger.error("WebAuthn verification error:", error)
    return c.json({ error: "Failed to verify passkey" }, 500)
  }
})

// Feature toggles endpoint for authentication options
app.get("/features", async (c) => {
  try {
    const features = {
      googleLoginEnabled: process.env.IS_KEYCLOAK_GOOGLE_LOGIN_ENABLED === 'true',
      microsoftLoginEnabled: process.env.IS_KEYCLOAK_MICROSOFT_LOGIN_ENABLED === 'true',
      linkedinLoginEnabled: process.env.IS_KEYCLOAK_LINKEDIN_LOGIN_ENABLED === 'true',
      emailPasswordLoginEnabled: process.env.IS_KEYCLOAK_EMAIL_PASSWORD_LOGIN_ENABLED === 'true',
      passkeyLoginEnabled: process.env.IS_KEYCLOAK_PASSKEY_LOGIN_ENABLED === 'true',
      ssoLoginEnabled: process.env.IS_KEYCLOAK_SSO_LOGIN_ENABLED === 'true',
    }
    
    Logger.info("Returning feature toggles:", features)
    return c.json(features)
  } catch (error) {
    Logger.error("Feature toggles error:", error)
    return c.json({ error: "Failed to get feature toggles" }, 500)
  }
})

export default app