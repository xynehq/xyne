// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono"
import config from "@/config"
import { db } from "@/db/client"
import {
  createUserApiKey,
  getPublicUserAndWorkspaceByEmail,
  updateUserTimezone,
  getUserByEmail,
} from "@/db/user"
import { type PublicUserWorkspace, apiKeys } from "@/db/schema"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { HTTPException } from "hono/http-exception"
import { eq, and } from "drizzle-orm"

const { JwtPayloadKey, agentWhiteList } = config

const Logger = getLogger(Subsystem.Server)

export const GetUserWorkspaceInfo = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub

  // Check for timezone in query parameters
  const timeZone = c.req.query("timeZone")

  const userAndWorkspace: PublicUserWorkspace =
    await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)

  if (userAndWorkspace.user && userAndWorkspace.workspace) {
    // Update user timezone if provided
    if (timeZone) {
      try {
        await updateUserTimezone(db, email, timeZone)
      } catch (error) {
        console.warn("Failed to update user timezone:", error)
      }
    }
  }
  return c.json({
    ...userAndWorkspace,
    agentWhiteList: true,
  })
}

export const GenerateUserApiKey = async (c: Context) => {
  try {
    const payload = c.get("jwtPayload")
    const email = payload.sub as string
    const workspaceId = payload.workspaceId as string
    const user = await getUserByEmail(db, email)
    if (!user || user.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const body = await c.req.json()
    const apiKeys = await createUserApiKey({
      db,
      userId: user[0].externalId,
      workspaceId: workspaceId,
      name: body.name,
      scope: body.permissions,
    })
    if (!apiKeys.success) {
      Logger.error(
        `Failed to create API key for user ${email} in workspace ${workspaceId}\nError: ${apiKeys.error}`,
      )
      throw new HTTPException(500, {
        message: apiKeys.error || "Failed to create API key",
      })
    }
    Logger.info(`API key created for user ${email} in workspace ${workspaceId}`)
    return c.json({
      success: true,
      apiKey: apiKeys.apiKey,
    })
  } catch (error) {
    Logger.error(error, "Error generating API key")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const GetUserApiKeys = async (c: Context) => {
  try {
    const payload = c.get("jwtPayload")
    const email = payload.sub as string
    const workspaceId = payload.workspaceId as string
    const user = await getUserByEmail(db, email)

    if (!user || user.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }

    const userApiKeys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        config: apiKeys.config,
        createdAt: apiKeys.createdAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.userId, user[0].externalId),
          eq(apiKeys.workspaceId, workspaceId),
        ),
      )
      .orderBy(apiKeys.createdAt)

    const formattedKeys = userApiKeys.map((key) => {
      const config = (key.config as any) || {}
      const displayKey = `${key?.keyPrefix}${"*".repeat(28)}`
      return {
        id: key.id.toString(),
        name: key.name,
        key: displayKey,
        scopes: config.scopes || [],
        agents: config.agents || [],
        createdAt: key.createdAt.toISOString(),
      }
    })

    return c.json({
      success: true,
      keys: formattedKeys,
    })
  } catch (error) {
    Logger.error(error, "Error fetching user API keys")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}

export const DeleteUserApiKey = async (c: Context) => {
  try {
    const payload = c.get("jwtPayload")
    const email = payload.sub as string
    const workspaceId = payload.workspaceId as string
    const keyId = c.req.param("keyId")

    const user = await getUserByEmail(db, email)
    if (!user || user.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }

    // Delete the API key (ensure it belongs to the user)
    const deletedKey = await db
      .delete(apiKeys)
      .where(
        and(
          eq(apiKeys.id, parseInt(keyId)),
          eq(apiKeys.userId, user[0].externalId),
          eq(apiKeys.workspaceId, workspaceId),
        ),
      )
      .returning()

    if (!deletedKey || deletedKey.length === 0) {
      throw new HTTPException(404, { message: "API key not found" })
    }

    Logger.info(
      `API key ${keyId} deleted for user ${email} in workspace ${workspaceId}`,
    )
    return c.json({
      success: true,
      message: "API key deleted successfully",
    })
  } catch (error) {
    Logger.error(error, "Error deleting API key")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}
