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
  getAgentsMadeByMe,
  getAgentsSharedToMe,
} from "@/db/agent"

import { fetchedDataSourceSchema } from "@/db/schema/agents"
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
import { eq, isNull, and } from "drizzle-orm"
import { users } from "@/db/schema"
import { ApiKeyScopes, UserAgentRole } from "@/shared/types"
import { getCollectionItemById } from "@/db/knowledgeBase"

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
  appIntegrations: z
    .union([
      z.array(z.string()), // Legacy format
      z.record(
        z.string(),
        z.object({
          // AppSelectionMap format
          itemIds: z.array(z.string()).default([]),
          selectedAll: z.boolean(),

          // Multiple filter groups
          filters: z
            .array(
              z.object({
                id: z.number(), // Numeric identifier for this filter
                // Gmail-specific filters
                from: z.array(z.string()).optional(),
                to: z.array(z.string()).optional(),
                cc: z.array(z.string()).optional(),
                bcc: z.array(z.string()).optional(),
                // Slack-specific filters
                senderId: z.array(z.string()).optional(),
                channelId: z.array(z.string()).optional(),
                // Common filters
                timeRange: z
                  .object({
                    startDate: z.number(),
                    endDate: z.number(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      ),
    ])
    .optional()
    .default([]),
  allowWebSearch: z.boolean().optional().default(false),
  isRagOn: z.boolean().optional().default(true),
  uploadedFileNames: z.array(z.string()).optional().default([]),
  userEmails: z.array(z.string().email()).optional().default([]),
  docIds: z.array(fetchedDataSourceSchema).optional().default([]),
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

export const GetAgentApi = async (c: Context) => {
  const { email, workspaceExternalId, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.READ_AGENT)) {
      return c.json(
        { message: "API key does not have scope to read agent details" },
        403,
      )
    }
  }

  try {
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

    const agent = await getAgentByExternalIdWithPermissionCheck(
      db,
      agentExternalId,
      userAndWorkspace.workspace.id,
      userAndWorkspace.user.id,
    )

    if (!agent) {
      return c.json({ message: "Agent not found or access denied" }, 404)
    }

    return c.json(selectPublicAgentSchema.parse(agent))
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Get Agent Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json({ message: "Could not fetch agent", detail: errMsg }, 500)
  }
}

// Schema for listing agents (query params)
export const listAgentsSchema = z.object({
  limit: z.coerce.number().int().positive().optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
  filter: z.enum(["all", "madeByMe", "sharedToMe"]).optional().default("all"),
})

export const safeGet = <T>(c: Context, key: string): T | undefined => {
  try {
    return c.get(key) as T
  } catch {
    return undefined
  }
}

type Auth = { email: string; workspaceExternalId: string; via_apiKey: boolean }

export const getAuth = (c: Context): Auth => {
  const jwt = safeGet<{ sub: string; workspaceId: string }>(c, JwtPayloadKey)
  return {
    email: jwt?.sub ?? safeGet<string>(c, "userEmail") ?? "",
    workspaceExternalId:
      jwt?.workspaceId ?? safeGet<string>(c, "workspaceId") ?? "",
    via_apiKey: jwt?.sub && jwt?.workspaceId ? false : true,
  }
}

export const CreateAgentApi = async (c: Context) => {
  const { email, workspaceExternalId, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.CREATE_AGENT)) {
      return c.json(
        { message: "API key does not have scope to create agents" },
        403,
      )
    }
  }
  try {
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
      isRagOn: validatedBody.isRagOn,
      uploadedFileNames: validatedBody.uploadedFileNames,
      docIds: validatedBody.docIds,
      via_apiKey,
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
    loggerWithChild({ email: email }).error(
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
  const { email, workspaceExternalId, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.UPDATE_AGENT)) {
      return c.json(
        { message: "API key does not have scope to update agents" },
        403,
      )
    }
  }

  try {
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
    loggerWithChild({ email: email }).error(
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
  const { email, workspaceExternalId, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.DELETE_AGENT)) {
      return c.json(
        { message: "API key does not have scope to delete agents" },
        403,
      )
    }
  }
  try {
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
    loggerWithChild({ email: email }).error(
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
    const { limit, offset, filter } = c.req.valid("query") as z.infer<
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

    let agents
    if (filter === "madeByMe") {
      agents = await getAgentsMadeByMe(
        db,
        userAndWorkspace.user.id,
        userAndWorkspace.workspace.id,
        limit,
        offset,
      )
    } else if (filter === "sharedToMe") {
      agents = await getAgentsSharedToMe(
        db,
        userAndWorkspace.user.id,
        userAndWorkspace.workspace.id,
        limit,
        offset,
      )
    } else {
      // Default to "all"
      agents = await getAgentsAccessibleToUser(
        db,
        userAndWorkspace.user.id,
        userAndWorkspace.workspace.id,
        limit,
        offset,
      )
    }
    return c.json(agents)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `List Agents Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json({ message: "Could not fetch agents", detail: errMsg }, 500)
  }
}

export const GetWorkspaceUsersApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub

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

    // Get all users in the workspace (excluding deleted users)
    const workspaceUsers = await db
      .select({
        id: users.externalId, // Use externalId instead of internal id
        name: users.name,
        email: users.email,
        photoLink: users.photoLink,
      })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, userAndWorkspace.workspace.id),
          isNull(users.deletedAt)
        )
      )

    return c.json(workspaceUsers)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
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
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub
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
    loggerWithChild({ email: email }).error(
      error,
      `Get Agent Permissions Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json(
      { message: "Could not fetch agent permissions", detail: errMsg },
      500,
    )
  }
}

export const GetAgentIntegrationItemsApi = async (c: Context) => {
  let email = ""
  try {
    const { sub, workspaceId: workspaceExternalId } = c.get(JwtPayloadKey)
    email = sub
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

    // Parse app integrations
    const appIntegrations = agent.appIntegrations as Record<string, any>
    const integrationItems: Record<string, any> = {}

    // Handle knowledge base integrations
    if (
      appIntegrations &&
      typeof appIntegrations === "object" &&
      appIntegrations.knowledge_base
    ) {
      const clConfig = appIntegrations.knowledge_base
      const itemIds = clConfig.itemIds || []

      if (itemIds.length > 0) {
        // Extract actual item IDs from prefixed format
        const actualItemIds: string[] = []
        const collectionIds: string[] = []

        for (const itemId of itemIds) {
          if (itemId.startsWith("cl-")) {
            // This is a collection ID
            collectionIds.push(itemId.replace("cl-", ""))
          } else if (itemId.startsWith("clfd-") || itemId.startsWith("clf-")) {
            // This is a folder or file ID - extract the actual ID
            actualItemIds.push(itemId.replace(/^(clfd-|clf-)/, ""))
          } else {
            // Assume it's already a clean ID
            actualItemIds.push(itemId)
          }
        }

        // Fetch items from database to get basic structure
        const dbItems = await Promise.all(
          actualItemIds.map(async (itemId: string) => {
            try {
              const item = await getCollectionItemById(db, itemId)
              return item
            } catch (error) {
              loggerWithChild({ email }).warn(
                `Failed to fetch KB item ${itemId}: ${getErrorMessage(error)}`,
              )
              return null
            }
          }),
        )

        // Filter out null items
        const validDbItems = dbItems.filter(Boolean)

        // Group items by their collection ID
        const clGroups: Record<string, any[]> = {}

        for (const item of validDbItems) {
          if (!item) continue // Skip null items

          // Find the root Collection ID by traversing up the hierarchy
          let clId = item.collectionId

          if (!clGroups[clId]) {
            clGroups[clId] = []
          }

          // Add the item with basic database info
          // Note: The actual content names will be fetched by the frontend via Vespa
          clGroups[clId].push({
            id: item.id,
            name: item.name || item.originalName || "Unnamed",
            type: item.type,
            parentId: item.parentId,
            path: item.path,
            vespaDocId: item.vespaDocId,
            metadata: item.metadata,
          })
        }

        // Handle collection-level selections
        for (const collectionId of collectionIds) {
          if (!clGroups[collectionId]) {
            clGroups[collectionId] = []
          }
          // Mark this as a collection-level selection
          clGroups[collectionId].push({
            id: collectionId,
            name: "Entire Collection",
            type: "collection",
            isCollectionLevel: true,
          })
        }

        integrationItems.collection = {
          type: "collection",
          groups: clGroups,
          totalItems: validDbItems.length + collectionIds.length,
        }
      }
    }

    // Handle legacy format or other integrations if needed
    if (Array.isArray(appIntegrations)) {
      // Legacy format - just return the integration IDs
      integrationItems.legacy = {
        type: "legacy",
        integrationIds: appIntegrations,
      }
    } else if (appIntegrations && typeof appIntegrations === "object") {
      // Handle other integration types (non-KB)
      for (const [key, value] of Object.entries(appIntegrations)) {
        if (key !== "knowledge_base" && value && typeof value === "object") {
          integrationItems[key] = {
            type: "regular",
            config: value,
          }
        }
      }
    }

    return c.json({
      agentId: agent.externalId,
      integrationItems,
    })
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: email }).error(
      error,
      `Get Agent Integration Items Error: ${errMsg} ${(error as Error).stack}`,
    )
    return c.json(
      { message: "Could not fetch agent integration items", detail: errMsg },
      500,
    )
  }
}
