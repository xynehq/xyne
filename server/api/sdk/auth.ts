import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { sign } from "hono/jwt"
import { db } from "@/db/client"
import { users, workspaces, sdkConfigs } from "@/db/schema"
import { getUserByEmail } from "@/db/user"
import { createSdkConfig } from "@/db/sdkConfig"
import { createId } from "@paralleldrive/cuid2"
import { eq } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { UserRole } from "@/shared/types"
import crypto from "crypto"

const Logger = getLogger(Subsystem.Server)

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const ACCESS_TOKEN_TTL = 24 * 60 * 60 // 24 hours

/**
 * POST /api/sdk/auth/signup
 *
 * Creates a new SDK workspace, user, sdk_config, and API key.
 * No auth required (public endpoint).
 */
export const SdkSignupApi = async (c: Context) => {
  const { email, password, name, workspace_name } = c.req.valid("json" as never)

  // Check if email already exists
  const existing = await getUserByEmail(db, email as string)
  if (existing.length > 0) {
    throw new HTTPException(409, { message: "Email already registered" })
  }

  const passwordHash = await Bun.password.hash(password as string, "argon2id")

  // Transaction: create workspace + user + sdk_config
  const result = await db.transaction(async (trx) => {
    // 1. Create workspace (domain = email domain, createdBy = email)
    const emailStr = email as string
    const domain = `sdk-${emailStr.split("@")[1]}-${createId().slice(0, 6)}`
    const workspaceExternalId = createId()
    const [workspace] = await trx
      .insert(workspaces)
      .values({
        externalId: workspaceExternalId,
        createdBy: emailStr,
        domain,
        name: workspace_name as string,
      })
      .returning()

    // 2. Create user with Sdk role + passwordHash
    const userExternalId = createId()
    const [user] = await trx
      .insert(users)
      .values({
        externalId: userExternalId,
        workspaceId: workspace.id,
        email: emailStr,
        name: name as string,
        photoLink: null,
        workspaceExternalId: workspace.externalId,
        lastLogin: new Date(),
        role: UserRole.Sdk,
        passwordHash,
        refreshToken: "",
      })
      .returning()

    // 3. Create sdk_config with a random tokenSecret
    const tokenSecret = crypto.randomBytes(32).toString("hex")
    const sdkConfig = await createSdkConfig(trx, {
      workspaceId: workspace.externalId,
      tokenSecret,
    })

    return { workspace, user, sdkConfig }
  })

  // Sign JWT for the new SDK user
  const token = await sign(
    {
      sub: email as string,
      role: UserRole.Sdk,
      workspaceId: result.workspace.externalId,
      tokenType: "access",
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL,
    },
    accessTokenSecret,
  )

  return c.json({
    token,
    workspace_id: result.workspace.externalId,
    user: {
      email: result.user.email,
      name: result.user.name,
      role: result.user.role,
    },
  })
}

/**
 * POST /api/sdk/auth/login
 *
 * Authenticates an SDK user with email + password.
 * No auth required (public endpoint).
 */
export const SdkLoginApi = async (c: Context) => {
  const { email, password } = c.req.valid("json" as never)

  const userRes = await getUserByEmail(db, email as string)
  if (!userRes.length) {
    throw new HTTPException(401, { message: "Invalid email or password" })
  }

  const user = userRes[0]

  if (user.role !== UserRole.Sdk) {
    throw new HTTPException(401, { message: "Invalid email or password" })
  }

  if (!user.passwordHash) {
    throw new HTTPException(401, { message: "Invalid email or password" })
  }

  const valid = await Bun.password.verify(password as string, user.passwordHash)
  if (!valid) {
    throw new HTTPException(401, { message: "Invalid email or password" })
  }

  // Update last login
  await db
    .update(users)
    .set({ lastLogin: new Date() })
    .where(eq(users.id, user.id))

  const token = await sign(
    {
      sub: user.email,
      role: user.role,
      workspaceId: user.workspaceExternalId,
      tokenType: "access",
      exp: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL,
    },
    accessTokenSecret,
  )

  return c.json({
    token,
    workspace_id: user.workspaceExternalId,
    user: {
      email: user.email,
      name: user.name,
      role: user.role,
    },
  })
}
