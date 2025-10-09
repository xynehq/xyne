import { z } from "zod"
import config from "@/config"
import { db } from "@/db/client"
import { getUsersByWorkspace } from "@/db/user"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"

const { JwtPayloadKey } = config

// Schema for user search
export const searchUsersSchema = z.object({
  q: z.string().min(1, "Search query is required"),
})

// Search users in workspace
export const SearchWorkspaceUsersApi = async (c: Context) => {
  try {
    const { workspaceId } = c.get(JwtPayloadKey)
    const query = c.req.query()
    const { q } = searchUsersSchema.parse(query)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get users scoped to the current workspace
    // TODO: Move search filtering to database query level for better performance
    // instead of fetching all workspace users and filtering in memory
    const users = await getUsersByWorkspace(db, workspaceId)

    // Filter users based on search query (name or email)
    const filteredUsers = users.filter(
      (user) =>
        user.name.toLowerCase().includes(q.toLowerCase()) ||
        user.email.toLowerCase().includes(q.toLowerCase()),
    )

    // Return public user data with externalId as id for frontend consistency
    const publicUsers = filteredUsers.map((user) => ({
      id: user.externalId, // Map externalId to id for frontend
      name: user.name,
      email: user.email,
      photoLink: user.photoLink,
    }))

    return c.json({ users: publicUsers })
  } catch (error) {
    console.error("Error searching users:", error)
    throw new HTTPException(500, { message: "Failed to search users" })
  }
}
