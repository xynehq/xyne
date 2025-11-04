import {
  agents,
  insertAgentSchema,
  selectAgentSchema,
  selectPublicAgentSchema,
  type InsertAgent,
  type SelectAgent,
  type SelectPublicAgent,
} from "@/db/schema"
export type { SelectAgent } // Re-export SelectAgent
import { createId } from "@paralleldrive/cuid2"
import { Subsystem, type TxnOrClient } from "@/types"
import { z } from "zod"
import { and, desc, eq, isNull, sql } from "drizzle-orm"
import { UserAgentRole } from "@/shared/types"
import {
  grantUserAgentPermission,
  getUserAccessibleAgents,
  checkUserAgentAccessByExternalId,
  getAgentsMadeByMe,
  getAgentsSharedToMe,
} from "@/db/userAgentPermission"
import { db } from "./client"
import { getLoggerWithChild } from "@/logger"
import { getUserByEmail } from "./user"


export { getAgentsMadeByMe, getAgentsSharedToMe }

const loggerWithChild = getLoggerWithChild(Subsystem.Db)
export const insertAgent = async (
  trx: TxnOrClient,
  agentData: Omit<InsertAgent, "externalId" | "userId" | "workspaceId">,
  userId: number,
  workspaceId: number,
): Promise<SelectAgent> => {
  const externalId = createId()
  const agentWithIds = {
    ...agentData,
    externalId,
    userId,
    workspaceId,
  }
  const validatedAgentData = insertAgentSchema.parse(agentWithIds)

  // Use transaction to ensure both agent and permission are created atomically
  const result = await trx.transaction(async (tx) => {
    // Insert the agent
    const agentArr = await tx
      .insert(agents)
      .values(validatedAgentData)
      .returning()

    if (!agentArr || !agentArr.length) {
      throw new Error('Error in insert of agent "returning"')
    }

    const newAgent = selectAgentSchema.parse(agentArr[0])

    // Grant owner permission to the creator
    await grantUserAgentPermission(tx, {
      userId,
      agentId: newAgent.id,
      role: UserAgentRole.Owner,
    })

    return newAgent
  })

  return result
}

export const getAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectAgent | null> => {
  const agentArr = await trx
    .select()
    .from(agents)
    .where(
      and(eq(agents.externalId, agentExternalId), isNull(agents.deletedAt)),
    )
  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}

/**
 * Get agent by external ID with permission check
 */
export const getAgentByExternalIdWithPermissionCheck = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  userId: number,
): Promise<SelectAgent | null> => {
  // First check if user has permission
  const permission = await checkUserAgentAccessByExternalId(
    trx,
    userId,
    agentExternalId,
    workspaceId,
  )

  if (!permission) {
    return null // User doesn't have access
  }

  // If user has permission, get the agent
  return getAgentByExternalId(trx, agentExternalId, workspaceId)
}

/**
 * @deprecated Use getUserAccessibleAgents instead for permission-based access
 */
export const getAgentsByUserId = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  // Redirect to permission-based function
  return getUserAccessibleAgents(trx, userId, workspaceId, limit, offset)
}

/**
 * Get all agents accessible to a user (owned + shared) - preferred method
 */
export const getAgentsAccessibleToUser = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  return getUserAccessibleAgents(trx, userId, workspaceId, limit, offset)
}

// to list all the agent which are there is respective of who has created it
export const getAllAgents = async (
  trx: TxnOrClient,
  // userId: number,
  // workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .select()
    .from(agents)
    .where(and(isNull(agents.deletedAt)))
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)
  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

export const updateAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  agentData: Partial<
    Omit<InsertAgent, "externalId" | "userId" | "workspaceId">
  >,
): Promise<SelectAgent | null> => {
  const updateData = { ...agentData, updatedAt: new Date() }
  // Validate partial update data - Drizzle Zod doesn't directly support partial insert schemas for updates
  // We can manually pick keys or ensure the input is structured correctly.
  // For simplicity, we assume agentData contains valid updatable fields.

  const agentArr = await trx
    .update(agents)
    .set(updateData)
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .returning()

  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}

/**
 * Update agent with permission check
 */
export const updateAgentByExternalIdWithPermissionCheck = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  userId: number,
  agentData: Partial<
    Omit<InsertAgent, "externalId" | "userId" | "workspaceId">
  >,
): Promise<SelectAgent | null> => {
  // Check if user has permission (owner or editor)
  const permission = await checkUserAgentAccessByExternalId(
    trx,
    userId,
    agentExternalId,
    workspaceId,
  )

  if (
    !permission ||
    (permission.role !== UserAgentRole.Owner &&
      permission.role !== UserAgentRole.Editor)
  ) {
    return null // User doesn't have edit permission
  }

  return updateAgentByExternalId(trx, agentExternalId, workspaceId, agentData)
}

export const deleteAgentByExternalId = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectAgent | null> => {
  const agentArr = await trx
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt), // Ensure we only "delete" it once
      ),
    )
    .returning()
  if (!agentArr || !agentArr.length) {
    return null
  }
  return selectAgentSchema.parse(agentArr[0])
}

/**
 * Delete agent with permission check (only owners can delete)
 */
export const deleteAgentByExternalIdWithPermissionCheck = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceId: number,
  userId: number,
): Promise<SelectAgent | null> => {
  // Check if user has owner permission
  const permission = await checkUserAgentAccessByExternalId(
    trx,
    userId,
    agentExternalId,
    workspaceId,
  )

  if (!permission || permission.role !== UserAgentRole.Owner) {
    return null // Only owners can delete agents
  }

  return deleteAgentByExternalId(trx, agentExternalId, workspaceId)
}

export const removeAppIntegrationFromAllAgents = async (
  trx: TxnOrClient,
  appIntegrationNameToRemove: string,
): Promise<void> => {
  try {
    // 1. Fetch only the agents that contain the specified app integration
    const agentsToUpdate = await trx
      .select()
      .from(agents)
      .where(
        sql`${agents.appIntegrations} @> ${JSON.stringify([
          appIntegrationNameToRemove,
        ])}`,
      )

    loggerWithChild().info(
      `Count of agents to update: ${agentsToUpdate.length}`,
    )
    if (agentsToUpdate.length === 0) {
      // No agents to update
      return
    }

    // 2. For each agent, remove the app integration and update the record
    for (const agent of agentsToUpdate) {
      const currentIntegrations =
        (agent.appIntegrations as string[] | null) || []
      const updatedIntegrations = currentIntegrations.filter(
        (integration) => integration !== appIntegrationNameToRemove,
      )

      await trx
        .update(agents)
        .set({ appIntegrations: updatedIntegrations, updatedAt: new Date() })
        .where(eq(agents.id, agent.id))
    }
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to remove app integration "${appIntegrationNameToRemove}" from all agents`,
    )
    throw new Error(
      `Failed to remove app integration: ${appIntegrationNameToRemove}`,
    )
  }
}

export const getAgentsByDataSourceId = async (
  trx: TxnOrClient,
  dataSourceId: string,
): Promise<Pick<SelectAgent, "name" | "externalId">[]> => {
  try {
    const agentsWithDataSource = await trx
      .select({
        name: agents.name,
        externalId: agents.externalId,
      })
      .from(agents)
      .where(
        sql`${agents.appIntegrations} @> ${JSON.stringify([dataSourceId])}`,
      )

    return agentsWithDataSource
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to get agents for data source ID "${dataSourceId}"`,
    )
    throw new Error(`Failed to get agents for data source: ${dataSourceId}`)
  }
}

export const cleanUpAgentDb = async (
  trx: TxnOrClient,
  deletedItemIds: string[],
  userEmail: string,
): Promise<void> => {
  if (!deletedItemIds || deletedItemIds.length === 0) {
    loggerWithChild().info("No item IDs provided for agent cleanup")
    return
  }

  try {
    loggerWithChild().info(
      `Starting agent cleanup for deleted item IDs: ${deletedItemIds.join(", ")} requested by ${userEmail}`,
    )

    // Get the user by email to get their userId
    const users = await getUserByEmail(trx, userEmail)
    if (!users || users.length === 0) {
      loggerWithChild().warn(`User not found for email: ${userEmail}`)
      return
    }
    const userId = users[0].id

    // Only fetch agents created by this specific user
    const allActiveAgents = await trx
      .select()
      .from(agents)
      .where(and(isNull(agents.deletedAt), eq(agents.userId, userId)))

    const agentsToUpdate = allActiveAgents.filter((agent) => {
      const currentIntegrations = agent.appIntegrations as any

      if (Array.isArray(currentIntegrations)) {
        return currentIntegrations.some((integration: string) =>
          deletedItemIds.includes(integration),
        )
      } else if (
        currentIntegrations &&
        typeof currentIntegrations === "object"
      ) {
        if (currentIntegrations.knowledge_base?.itemIds) {
          return currentIntegrations.knowledge_base.itemIds.some((id: string) =>
            deletedItemIds.includes(id),
          )
        }
      }
      return false
    })

    loggerWithChild().info(
      `Found ${agentsToUpdate.length} agents with references to deleted items`,
    )

    if (agentsToUpdate.length === 0) {
      return
    }
    let updatedAgentsCount = 0
    for (const agent of agentsToUpdate) {
      const currentIntegrations = agent.appIntegrations as any
      let updatedIntegrations

      loggerWithChild().info(
        `Processing agent ${agent.name} (${agent.externalId}) with integrations: ${JSON.stringify(currentIntegrations)}`,
      )

      if (Array.isArray(currentIntegrations)) {
        updatedIntegrations = currentIntegrations.filter(
          (integration: string) => !deletedItemIds.includes(integration),
        )
      } else if (
        currentIntegrations &&
        typeof currentIntegrations === "object"
      ) {
        updatedIntegrations = JSON.parse(JSON.stringify(currentIntegrations))

        if (updatedIntegrations.knowledge_base?.itemIds) {
          const originalItemIds = [
            ...updatedIntegrations.knowledge_base.itemIds,
          ]
          updatedIntegrations.knowledge_base.itemIds =
            updatedIntegrations.knowledge_base.itemIds.filter(
              (id: string) => !deletedItemIds.includes(id),
            )
          loggerWithChild().info(
            `Agent ${agent.name}: original itemIds: ${JSON.stringify(originalItemIds)}, after filtering: ${JSON.stringify(updatedIntegrations.knowledge_base.itemIds)}`,
          )
          if (updatedIntegrations.knowledge_base.itemIds.length === 0) {
            delete updatedIntegrations.knowledge_base
            loggerWithChild().info(
              `Agent ${agent.name}: removed entire knowledge_base key as no itemIds left`,
            )
          }
        }
      } else {
        loggerWithChild().warn(
          `Unrecognized app_integrations format for agent ${agent.id}: ${JSON.stringify(currentIntegrations)}`,
        )
        continue
      }

      loggerWithChild().info(
        `Agent ${agent.name}: final updatedIntegrations: ${JSON.stringify(updatedIntegrations)}`,
      )

      console.log(
        "DEBUG: About to check update condition for agent:",
        agent.name,
      )

      const originalCount = Array.isArray(currentIntegrations)
        ? currentIntegrations.length
        : currentIntegrations?.knowledge_base?.itemIds?.length || 0
      const newCount = Array.isArray(updatedIntegrations)
        ? updatedIntegrations.length
        : updatedIntegrations?.knowledge_base?.itemIds?.length || 0

      const originalHasKnowledgeBase =
        currentIntegrations?.knowledge_base !== undefined
      const updatedHasKnowledgeBase =
        updatedIntegrations?.knowledge_base !== undefined
      const knowledgeBaseStructureChanged =
        originalHasKnowledgeBase !== updatedHasKnowledgeBase

      loggerWithChild().info(
        `Agent ${agent.name}: originalCount=${originalCount}, newCount=${newCount}, countChanged=${originalCount !== newCount}, knowledgeBaseStructureChanged=${knowledgeBaseStructureChanged}`,
      )

      const hasChanges =
        originalCount !== newCount ||
        knowledgeBaseStructureChanged ||
        JSON.stringify(currentIntegrations) !==
          JSON.stringify(updatedIntegrations)

      if (hasChanges) {
        loggerWithChild().info(
          `Agent ${agent.name}: updating database with new integrations`,
        )

        await trx
          .update(agents)
          .set({
            appIntegrations: updatedIntegrations,
            updatedAt: new Date(),
          })
          .where(eq(agents.id, agent.id))

        updatedAgentsCount++
      } else {
        loggerWithChild().info(
          `Agent ${agent.name}: no changes needed, skipping update`,
        )
      }
    }
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to clean up agents for deleted item IDs: ${deletedItemIds.join(", ")}`,
    )
    throw new Error(
      `Failed to clean up agents for deleted items: ${deletedItemIds.join(", ")}`,
    )
  }
}


export const getAllPublicAgents = async (
  trx: TxnOrClient,
  workspaceId: number,
): Promise<SelectPublicAgent[]> => {
  const publicAgents = await trx
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.isPublic, true),
        isNull(agents.deletedAt),
      ),
    )
  return z.array(selectPublicAgentSchema).parse(publicAgents)
}