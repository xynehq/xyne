// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono"
import config from "@/config"
import { db } from "@/db/client"
import {
  createUserApiKey,
  getPublicUserAndWorkspaceByEmail,
  getUserByEmail,
} from "@/db/user"
import { type PublicUserWorkspace } from "@/db/schema"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { HTTPException } from "hono/http-exception"

const { JwtPayloadKey, agentWhiteList } = config

const Logger = getLogger(Subsystem.Server)

export const GetUserWorkspaceInfo = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const userAndWorkspace: PublicUserWorkspace =
    await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)
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
      data: apiKeys,
    })
  } catch (error) {
    Logger.error(error, "Error fetching agent API keys")
    return c.json(
      {
        success: false,
        message: getErrorMessage(error),
      },
      500,
    )
  }
}
