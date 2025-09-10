import { Hono } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { sign } from "hono/jwt"
import { db } from "@/db/client"
import { createUser, getUserByEmail, verifyUserPassword, updateUserPassword } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { validatePasswordStrength } from "@/utils/password"
import { UserRole } from "@/shared/types"

const Logger = getLogger(Subsystem.Server).child({ module: "password-auth" })
const userSecret = process.env.USER_SECRET!

// Validation schemas
const signupSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1, "Name is required"),
  workspaceId: z.string().optional(),
})

const loginSchema = z.object({
  email: z.string().email("Invalid email address"), 
  password: z.string().min(1, "Password is required"),
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string().min(8, "New password must be at least 8 characters"),
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

// Password-based user registration
app.post("/signup", zValidator("json", signupSchema), async (c) => {
  try {
    const { email, password, name, workspaceId } = c.req.valid("json")
    
    Logger.info("Password signup attempt for:", email)
    
    // Validate password strength
    const passwordValidation = validatePasswordStrength(password)
    if (!passwordValidation.isValid) {
      return c.json({
        error: "Password does not meet requirements",
        details: passwordValidation.errors,
      }, 400)
    }
    
    // Check if user already exists
    const existingUsers = await getUserByEmail(db, email)
    if (existingUsers && existingUsers.length > 0) {
      return c.json({ error: "User already exists with this email" }, 409)
    }
    
    // Get default workspace (simplified for now)
    const defaultWorkspaceId = 3 // TODO: Make this configurable
    const defaultWorkspaceExternalId = "goebza6pjn5xt2dgt5999val" // TODO: Make this configurable
    
    // Create user with hashed password
    const newUser = await createUser(
      db,
      defaultWorkspaceId,
      email,
      name,
      "", // No photo for password users initially
      UserRole.User,
      defaultWorkspaceExternalId,
      password, // Will be hashed in createUser function
    )
    
    Logger.info("Password signup successful for:", email)
    
    // Generate JWT tokens for immediate login
    const accessTokenPayload = {
      sub: email,
      role: UserRole.User,
      workspaceId: defaultWorkspaceExternalId,
      tokenType: "access",
      exp: Math.floor(Date.now() / 1000) + (5 * 60), // 5 minutes
    }
    
    const refreshTokenPayload = {
      sub: email,
      role: UserRole.User,
      workspaceId: defaultWorkspaceExternalId,
      tokenType: "refresh",
      exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
    }
    
    const accessToken = await sign(accessTokenPayload, userSecret)
    const refreshToken = await sign(refreshTokenPayload, userSecret)
    
    // Set cookies
    const accessCookie = `access-token=${accessToken}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=300`
    const refreshCookie = `refresh-token=${refreshToken}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=2592000`
    
    c.res.headers.append("Set-Cookie", accessCookie)
    c.res.headers.append("Set-Cookie", refreshCookie)
    
    return c.json({
      success: true,
      message: "Account created successfully",
      user: {
        email: newUser[0].email,
        name: newUser[0].name,
        role: newUser[0].role,
      },
    })
  } catch (error) {
    Logger.error("Password signup error:", error)
    return c.json({
      error: "Account creation failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }, 500)
  }
})

// Password-based login  
app.post("/login", zValidator("json", loginSchema), async (c) => {
  try {
    const { email, password } = c.req.valid("json")
    
    Logger.info("Password login attempt for:", email)
    
    // Verify user credentials
    const user = await verifyUserPassword(db, email, password)
    
    if (!user) {
      Logger.warn("Password login failed for:", email)
      return c.json({ error: "Invalid email or password" }, 401)
    }
    
    Logger.info("Password login successful for:", email)
    
    // Generate JWT tokens
    const accessTokenPayload = {
      sub: email,
      role: user.role,
      workspaceId: user.workspaceExternalId,
      tokenType: "access",
      exp: Math.floor(Date.now() / 1000) + (5 * 60), // 5 minutes
    }
    
    const refreshTokenPayload = {
      sub: email,
      role: user.role,
      workspaceId: user.workspaceExternalId,
      tokenType: "refresh",
      exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
    }
    
    const accessToken = await sign(accessTokenPayload, userSecret)
    const refreshToken = await sign(refreshTokenPayload, userSecret)
    
    // Set cookies
    const accessCookie = `access-token=${accessToken}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=300`
    const refreshCookie = `refresh-token=${refreshToken}; Path=/; HttpOnly=true; SameSite=Strict; Max-Age=2592000`
    
    c.res.headers.append("Set-Cookie", accessCookie)
    c.res.headers.append("Set-Cookie", refreshCookie)
    
    return c.json({
      success: true,
      message: "Login successful",
      user: {
        email: user.email,
        name: user.name,
        role: user.role,
        workspaceId: user.workspaceExternalId,
      },
    })
  } catch (error) {
    Logger.error("Password login error:", error)
    return c.json({
      error: "Login failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }, 500)
  }
})

// Change password (requires authentication)
app.post("/change-password", zValidator("json", changePasswordSchema), async (c) => {
  try {
    // TODO: Add authentication middleware to get current user
    // For now, we'll require email in the request
    const { currentPassword, newPassword } = c.req.valid("json")
    
    // This would come from auth middleware in a complete implementation
    const userEmail = c.req.header("x-user-email") // Temporary approach
    
    if (!userEmail) {
      return c.json({ error: "User email required" }, 400)
    }
    
    Logger.info("Password change attempt for:", userEmail)
    
    // Validate new password strength
    const passwordValidation = validatePasswordStrength(newPassword)
    if (!passwordValidation.isValid) {
      return c.json({
        error: "New password does not meet requirements",
        details: passwordValidation.errors,
      }, 400)
    }
    
    // Verify current password
    const user = await verifyUserPassword(db, userEmail, currentPassword)
    if (!user) {
      return c.json({ error: "Current password is incorrect" }, 401)
    }
    
    // Update password
    await updateUserPassword(db, userEmail, newPassword)
    
    Logger.info("Password changed successfully for:", userEmail)
    
    return c.json({
      success: true,
      message: "Password changed successfully",
    })
  } catch (error) {
    Logger.error("Password change error:", error)
    return c.json({
      error: "Password change failed",
      message: error instanceof Error ? error.message : "Unknown error",
    }, 500)
  }
})

export default app