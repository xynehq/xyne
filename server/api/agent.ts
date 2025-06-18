import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { db } from "@/db/client"
import {
  insertAgent,
  getAgentsAccessibleToUser,
  updateAgentByExternalIdWithPermissionCheck,
  getAgentByExternalIdWithPermissionCheck,
  deleteAgentByExternalIdWithPermissionCheck,
  getAllAgents,
} from "@/db/agent"
import {
  syncAgentUserPermissions,
  getAgentUsers,
} from "@/db/userAgentPermission"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { getErrorMessage } from "@/utils"
import { selectPublicAgentSchema } from "@/db/schema"
import { eq } from "drizzle-orm"
import { users } from "@/db/schema"
import { UserAgentRole } from "@/shared/types"

const loggerWithChild = getLoggerWithChild(Subsystem.AgentApi)
const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.AgentApi)
// Schema for creating an agent
export const createAgentSchema = z.object({
  // Keep this for create
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().min(1, "Model is required"),
  isPublic: z.boolean().optional().default(false),
  appIntegrations: z.array(z.string()).optional().default([]),
  allowWebSearch: z.boolean().optional().default(false),
  uploadedFileNames: z.array(z.string()).optional().default([]),
  userEmails: z.array(z.string().email()).optional().default([]),
})
export type CreateAgentPayload = z.infer<typeof createAgentSchema>

// Schema for updating an agent (all fields optional)
export const updateAgentSchema = createAgentSchema.partial().extend({
  // No fields need to be explicitly required for an update,
  // but you could add specific checks if needed.
  // For example, if name could not be unset: name: z.string().min(1).optional()
  userEmails: z.array(z.string().email()).optional(),
})
export type UpdateAgentPayload = z.infer<typeof updateAgentSchema>

// Schema for listing agents (query params)
export const listAgentsSchema = z.object({
  limit: z.coerce.number().int().positive().optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
})

export const CreateAgentApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub
    const body = await c.req.json<CreateAgentPayload>()

    const validatedBody = createAgentSchema.parse(body)

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      throw new HTTPException(404, { message: "User or workspace not found" })
    }

    const agentData = {
      name: validatedBody.name,
      description: validatedBody.description,
      prompt: validatedBody.prompt,
      model: validatedBody.model,
      isPublic: validatedBody.isPublic,
      appIntegrations: validatedBody.appIntegrations,
      allowWebSearch: validatedBody.allowWebSearch,
      uploadedFileNames: validatedBody.uploadedFileNames,
    }

    // Create agent and sync user permissions in a transaction
    const newAgent = await db.transaction(async (tx) => {
      const agent = await insertAgent(
        tx,
        agentData,
        userAndWorkspace.user.id,
        userAndWorkspace.workspace.id,
      )

      // Only sync user permissions if agent is private
      if (
        !validatedBody.isPublic &&
        validatedBody.userEmails &&
        validatedBody.userEmails.length > 0
      ) {
        await syncAgentUserPermissions(
          tx,
          agent.id,
          validatedBody.userEmails,
          userAndWorkspace.workspace.id,
        )
      }

      return agent
    })

    return c.json(selectPublicAgentSchema.parse(newAgent), 201)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({email: email}).error(
      error,
      `Create Agent Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (error instanceof z.ZodError) {
      return c.json(
        { message: "Invalid input", errors: error.flatten().fieldErrors },
        400,
      )
    }
    return c.json({ message: "Could not create agent", detail: errMsg }, 500)
  }
}

export const UpdateAgentApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub
    const agentExternalId = c.req.param("agentExternalId")
    const body = await c.req.json<UpdateAgentPayload>()

    const validatedBody = updateAgentSchema.parse(body)

    if (Object.keys(validatedBody).length === 0) {
      return c.json({ message: "No fields to update" }, 400)
    }

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      return c.json({ message: "User or workspace not found" }, 404)
    }

    // Check if agent belongs to the user/workspace before updating
    const existingAgent = await getAgentByExternalIdWithPermissionCheck(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
      userAndWorkspace.user.id,
    )
    if (!existingAgent || existingAgent.userId !== userAndWorkspace.user.id) {
      return c.json({ message: "Agent not found or access denied" }, 404)
    }

    // Update agent and sync user permissions in a transaction
    const updatedAgent = await db.transaction(async (tx) => {
      const agent = await updateAgentByExternalIdWithPermissionCheck(
        tx,
        agentExternalId,
        userAndWorkspace.workspace.id,
        userAndWorkspace.user.id,
        validatedBody,
      )

      if (!agent) {
        throw new Error("Agent not found or failed to update")
      }

      // Handle user permissions based on isPublic field
      if (validatedBody.isPublic === true) {
        // If switching to public, clear all non-owner permissions
        await syncAgentUserPermissions(
          tx,
          agent.id,
          [], // Empty array clears all non-owner permissions
          userAndWorkspace.workspace.id,
        )
      } else if (
        validatedBody.isPublic === false &&
        validatedBody.userEmails !== undefined
      ) {
        // If switching to private or updating private agent, sync user permissions
        await syncAgentUserPermissions(
          tx,
          agent.id,
          validatedBody.userEmails,
          userAndWorkspace.workspace.id,
        )
      } else if (validatedBody.userEmails !== undefined) {
        // If userEmails are provided but isPublic not specified, check existing agent
        if (!existingAgent.isPublic) {
          await syncAgentUserPermissions(
            tx,
            agent.id,
            validatedBody.userEmails,
            userAndWorkspace.workspace.id,
          )
        }
      }

      return agent
    })

    return c.json(selectPublicAgentSchema.parse(updatedAgent))
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({email: email}).error(
      error,
      `Update Agent Error: ${errMsg} ${(error as Error).stack}`,
    )
    if (error instanceof z.ZodError) {
      return c.json(
        { message: "Invalid input", errors: error.flatten().fieldErrors },
        400,
      )
    }
    return c.json({ message: "Could not update agent", detail: errMsg }, 500)
  }
}

export const DeleteAgentApi = async (c: Context) => {
  let email= ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub // For logging or audit if needed, not directly used in delete logic by ID
    const agentExternalId = c.req.param("agentExternalId")

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      return c.json({ message: "User or workspace not found" }, 404)
    }

    // Check if agent belongs to the user/workspace before deleting
    const existingAgent = await getAgentByExternalIdWithPermissionCheck(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
      userAndWorkspace.user.id,
    )
    if (!existingAgent || existingAgent.userId !== userAndWorkspace.user.id) {
      return c.json({ message: "Agent not found or access denied" }, 404)
    }

    const deletedAgent = await deleteAgentByExternalIdWithPermissionCheck(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
      userAndWorkspace.user.id,
    )

    if (!deletedAgent) {
      // This case should ideally be caught by the check above, but as a safeguard:
      return c.json({ message: "Agent not found or failed to delete" }, 404)
    }
    // For a DELETE request, typically a 204 No Content or 200 OK with a confirmation message is returned.
    // Returning the "deleted" (soft-deleted) agent object might be useful for the client to confirm.
    // Or simply return a success message.
    return c.json({
      message: "Agent deleted successfully",
      agent: selectPublicAgentSchema.parse(deletedAgent),
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({email: email}).error(
      error,
      `Delete Agent Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json({ message: "Could not delete agent", detail: errMsg }, 500)
  }
}

export const ListAgentsApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub
    // @ts-ignore
    const { limit, offset } = c.req.valid("query") as z.infer<
      typeof listAgentsSchema
    >

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      // Use return c.json for consistency, though HTTPException might be fine if Hono's default error handler is JSON-friendly
      return c.json({ message: "User or workspace not found" }, 404)
    }
    const agents = await getAgentsAccessibleToUser(
      db,
      userAndWorkspace.user.id,
      userAndWorkspace.workspace.id,
      limit,
      offset
    )
    return c.json(agents)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({email: email}).error(
      error,
      `List Agents Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json({ message: "Could not fetch agents", detail: errMsg }, 500)
  }
}

export const GetWorkspaceUsersApi = async (c: Context) => {
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    const email = sub

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      return c.json({ message: "User or workspace not found" }, 404)
    }

    // Get all users in the workspace
    const workspaceUsers = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(eq(users.workspaceId, userAndWorkspace.workspace.id))

    return c.json(workspaceUsers)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Get Workspace Users Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json(
      { message: "Could not fetch workspace users", detail: errMsg },
      500,
    )
  }
}

export const GetAgentPermissionsApi = async (c: Context) => {
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    const email = sub
    const agentExternalId = c.req.param("agentExternalId")

    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceExternalId,
      email,
    )
    if (
      !userAndWorkspace ||
      !userAndWorkspace.user ||
      !userAndWorkspace.workspace
    ) {
      return c.json({ message: "User or workspace not found" }, 404)
    }

    // Check if user has access to this agent
    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
      userAndWorkspace.user.id,
    )

    if (!agent) {
      return c.json({ message: "Agent not found or access denied" }, 404)
    }

    // Get agent permissions
    const permissions = await getAgentUsers(db, agent.id)

    // Return only the user emails for non-owner permissions
    const userEmails = permissions
      .filter((p) => p.role !== UserAgentRole.Owner)
      .map((p) => p.user.email)

    return c.json({ userEmails })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    Logger.error(
      error,
      `Get Agent Permissions Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json(
      { message: "Could not fetch agent permissions", detail: errMsg },
      500,
    )
  }
}
