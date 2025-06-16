import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { db } from "@/db/client"
import {
  insertAgent,
  getAgentsByUserId,
  updateAgentByExternalId,
  getAgentByExternalId,
  deleteAgentByExternalId,
  getAllAgents,
} from "@/db/agent"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { HTTPException } from "hono/http-exception"
import { getErrorMessage } from "@/utils"
import { selectPublicAgentSchema } from "@/db/schema"

const Logger = getLogger(Subsystem.AgentApi)
const loggerWithChild = getLoggerWithChild(Subsystem.AgentApi)
const { JwtPayloadKey } = config

// Schema for creating an agent
export const createAgentSchema = z.object({
  // Keep this for create
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  prompt: z.string().optional(),
  model: z.string().min(1, "Model is required"),
  appIntegrations: z.array(z.string()).optional().default([]),
  allowWebSearch: z.boolean().optional().default(false),
  uploadedFileNames: z.array(z.string()).optional().default([]),
})
export type CreateAgentPayload = z.infer<typeof createAgentSchema>

// Schema for updating an agent (all fields optional)
export const updateAgentSchema = createAgentSchema.partial().extend({
  // No fields need to be explicitly required for an update,
  // but you could add specific checks if needed.
  // For example, if name could not be unset: name: z.string().min(1).optional()
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
      appIntegrations: validatedBody.appIntegrations,
      allowWebSearch: validatedBody.allowWebSearch,
      uploadedFileNames: validatedBody.uploadedFileNames,
    }

    const newAgent = await insertAgent(
      db,
      agentData,
      userAndWorkspace.user.id,
      userAndWorkspace.workspace.id,
    )

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
    const existingAgent = await getAgentByExternalId(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
    )
    if (!existingAgent || existingAgent.userId !== userAndWorkspace.user.id) {
      return c.json({ message: "Agent not found or access denied" }, 404)
    }

    const updatedAgent = await updateAgentByExternalId(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
      validatedBody,
    )

    if (!updatedAgent) {
      return c.json({ message: "Agent not found or failed to update" }, 404)
    }

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
    const existingAgent = await getAgentByExternalId(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
    )
    if (!existingAgent || existingAgent.userId !== userAndWorkspace.user.id) {
      return c.json({ message: "Agent not found or access denied" }, 404)
    }

    const deletedAgent = await deleteAgentByExternalId(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
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

    const agents = await getAllAgents(db, limit, offset)
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
