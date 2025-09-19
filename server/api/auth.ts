// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono"
import config from "@/config"
import { db } from "@/db/client"
import { getPublicUserAndWorkspaceByEmail, updateUserTimezone } from "@/db/user"
import { type PublicUserWorkspace } from "@/db/schema"

const { JwtPayloadKey, agentWhiteList } = config

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
