import { z } from "zod"
import config from "@/config"
import { db } from "@/db/client"
import { getUsersByWorkspace, getAllActiveUsers } from "@/db/user"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"

const { JwtPayloadKey } = config

// Schema for user search
export const searchUsersSchema = z.object({
  q: z.string().min(1, "Search query is required")
})

// Search users in workspace
export const SearchWorkspaceUsersApi = async (c: Context) => {
  try {
    const query = c.req.query()
    const { q } = searchUsersSchema.parse(query)
    
    // Get all active users (no workspace restriction for now)
    const users = await getAllActiveUsers(db)
    
    // Filter users based on search query (name or email)
    const filteredUsers = users.filter(user => 
      user.name.toLowerCase().includes(q.toLowerCase()) ||
      user.email.toLowerCase().includes(q.toLowerCase())
    )
    
    // Return public user data with externalId as id for frontend consistency
    const publicUsers = filteredUsers.map(user => ({
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
