// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono"
import config from "@/config"
import { db } from "@/db/client"
import { getPublicUserAndWorkspaceByEmail } from "@/db/user"
import { type PublicUserWorkspace } from "@/db/schema"
const { JwtPayloadKey } = config

export const GetUserWorkspaceInfo = async (c: Context) => {
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const userAndWorkspace: PublicUserWorkspace =
    await getPublicUserAndWorkspaceByEmail(db, workspaceId, email)
  return c.json(userAndWorkspace)
}
