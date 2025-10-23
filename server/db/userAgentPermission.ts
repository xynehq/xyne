import {
  userAgentPermissions,
  agents,
  users,
  insertUserAgentPermissionSchema,
  selectUserAgentPermissionSchema,
  userAgentPermissionWithDetailsSchema,
  type InsertUserAgentPermission,
  type SelectUserAgentPermission,
  type UserAgentPermissionWithDetails,
  type SelectAgent,
  type SelectPublicAgent,
  selectPublicAgentSchema,
  AgentCreationSource,
} from "@/db/schema"
import { UserAgentRole } from "@/shared/types"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { and, eq, isNull, desc, or, inArray } from "drizzle-orm"

/**
 * Check if a user has access to a specific agent
 */
export const checkUserAgentAccess = async (
  trx: TxnOrClient,
  userId: number,
  agentId: number,
): Promise<SelectUserAgentPermission | null> => {
  const permissionArr = await trx
    .select()
    .from(userAgentPermissions)
    .where(
      and(
        eq(userAgentPermissions.userId, userId),
        eq(userAgentPermissions.agentId, agentId),
      ),
    )

  if (!permissionArr || !permissionArr.length) {
    return null
  }

  return selectUserAgentPermissionSchema.parse(permissionArr[0])
}

/**
 * Check if a user has access to an agent by external ID
 * Returns permission if user has explicit access OR if agent is public
 */
export const checkUserAgentAccessByExternalId = async (
  trx: TxnOrClient,
  userId: number,
  agentExternalId: string,
  workspaceId: number,
): Promise<SelectUserAgentPermission | null> => {
  // First check for explicit permissions
  const permissionArr = await trx
    .select({
      id: userAgentPermissions.id,
      userId: userAgentPermissions.userId,
      agentId: userAgentPermissions.agentId,
      role: userAgentPermissions.role,
      createdAt: userAgentPermissions.createdAt,
      updatedAt: userAgentPermissions.updatedAt,
    })
    .from(userAgentPermissions)
    .innerJoin(agents, eq(userAgentPermissions.agentId, agents.id))
    .where(
      and(
        eq(userAgentPermissions.userId, userId),
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )

  if (permissionArr && permissionArr.length > 0) {
    return selectUserAgentPermissionSchema.parse(permissionArr[0])
  }

  // If no explicit permission, check if agent is public
  const publicAgentArr = await trx
    .select({
      id: agents.id,
      isPublic: agents.isPublic,
    })
    .from(agents)
    .where(
      and(
        eq(agents.externalId, agentExternalId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.isPublic, true),
        isNull(agents.deletedAt),
      ),
    )

  if (publicAgentArr && publicAgentArr.length > 0) {
    // Return a virtual permission for public access
    return {
      id: 0, // Virtual permission ID
      userId,
      agentId: publicAgentArr[0].id,
      role: "viewer" as any, // Public users get viewer access
      createdAt: new Date(),
      updatedAt: new Date(),
    }
  }

  return null
}

/**
 * Get all agents accessible to a user (owned + shared + public) - preferred method
 */
export const getUserAccessibleAgents = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .selectDistinct({
      externalId: agents.externalId,
      name: agents.name,
      description: agents.description,
      prompt: agents.prompt,
      model: agents.model,
      isPublic: agents.isPublic,
      appIntegrations: agents.appIntegrations,
      allowWebSearch: agents.allowWebSearch,
      isRagOn: agents.isRagOn,
      docIds: agents.docIds,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .leftJoin(userAgentPermissions, eq(agents.id, userAgentPermissions.agentId))
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        isNull(agents.deletedAt),
        or(
          // User has explicit permission to the agent
          eq(userAgentPermissions.userId, userId),
          // Agent is public (accessible to all workspace members)
          eq(agents.isPublic, true),
        ),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

/**
 * Get agents created by the user (where user is Owner)
 */
export const getAgentsMadeByMe = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .selectDistinct({
      externalId: agents.externalId,
      name: agents.name,
      description: agents.description,
      prompt: agents.prompt,
      model: agents.model,
      isPublic: agents.isPublic,
      appIntegrations: agents.appIntegrations,
      allowWebSearch: agents.allowWebSearch,
      isRagOn: agents.isRagOn,
      docIds: agents.docIds,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .innerJoin(
      userAgentPermissions,
      eq(agents.id, userAgentPermissions.agentId),
    )
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        isNull(agents.deletedAt),
        eq(userAgentPermissions.userId, userId),
        eq(userAgentPermissions.role, UserAgentRole.Owner),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

/**
 * Get agents shared with the user (where user has a role other than Owner)
 */
export const getAgentsSharedToMe = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<SelectPublicAgent[]> => {
  const agentsArr = await trx
    .selectDistinct({
      externalId: agents.externalId,
      name: agents.name,
      description: agents.description,
      prompt: agents.prompt,
      model: agents.model,
      isPublic: agents.isPublic,
      appIntegrations: agents.appIntegrations,
      allowWebSearch: agents.allowWebSearch,
      isRagOn: agents.isRagOn,
      docIds: agents.docIds,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .innerJoin(
      userAgentPermissions,
      eq(agents.id, userAgentPermissions.agentId),
    )
    .where(
      and(
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        eq(userAgentPermissions.userId, userId),
        eq(userAgentPermissions.role, UserAgentRole.Shared),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z.array(selectPublicAgentSchema).parse(agentsArr)
}

/**
 * Get agents with permission details for a user
 */
export const getUserAgentsWithPermissions = async (
  trx: TxnOrClient,
  userId: number,
  workspaceId: number,
  limit: number = 50,
  offset: number = 0,
): Promise<UserAgentPermissionWithDetails[]> => {
  const results = await trx
    .select({
      // Permission fields
      id: userAgentPermissions.id,
      userId: userAgentPermissions.userId,
      agentId: userAgentPermissions.agentId,
      role: userAgentPermissions.role,
      createdAt: userAgentPermissions.createdAt,
      updatedAt: userAgentPermissions.updatedAt,
      // User fields
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        photoLink: users.photoLink,
        externalId: users.externalId,
      },
      // Agent fields
      agent: {
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        description: agents.description,
        model: agents.model,
      },
    })
    .from(userAgentPermissions)
    .innerJoin(users, eq(userAgentPermissions.userId, users.id))
    .innerJoin(agents, eq(userAgentPermissions.agentId, agents.id))
    .where(
      and(
        eq(userAgentPermissions.userId, userId),
        eq(agents.workspaceId, workspaceId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(desc(agents.updatedAt))
    .limit(limit)
    .offset(offset)

  return z.array(userAgentPermissionWithDetailsSchema).parse(results)
}

/**
 * Grant permission to a user for an agent
 */
export const grantUserAgentPermission = async (
  trx: TxnOrClient,
  permissionData: InsertUserAgentPermission,
): Promise<SelectUserAgentPermission> => {
  const validatedData = insertUserAgentPermissionSchema.parse(permissionData)

  const permissionArr = await trx
    .insert(userAgentPermissions)
    .values(validatedData)
    .returning()

  if (!permissionArr || !permissionArr.length) {
    throw new Error('Error in insert of user agent permission "returning"')
  }

  return selectUserAgentPermissionSchema.parse(permissionArr[0])
}

/**
 * Update user's permission for an agent
 */
export const updateUserAgentPermission = async (
  trx: TxnOrClient,
  userId: number,
  agentId: number,
  role: UserAgentRole,
): Promise<SelectUserAgentPermission | null> => {
  const permissionArr = await trx
    .update(userAgentPermissions)
    .set({
      role,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userAgentPermissions.userId, userId),
        eq(userAgentPermissions.agentId, agentId),
      ),
    )
    .returning()

  if (!permissionArr || !permissionArr.length) {
    return null
  }

  return selectUserAgentPermissionSchema.parse(permissionArr[0])
}

/**
 * Revoke user's permission for an agent
 */
export const revokeUserAgentPermission = async (
  trx: TxnOrClient,
  userId: number,
  agentId: number,
): Promise<boolean> => {
  const result = await trx
    .delete(userAgentPermissions)
    .where(
      and(
        eq(userAgentPermissions.userId, userId),
        eq(userAgentPermissions.agentId, agentId),
      ),
    )

  return result.rowCount > 0
}

/**
 * Get all users who have access to a specific agent
 */
export const getAgentUsers = async (
  trx: TxnOrClient,
  agentId: number,
): Promise<UserAgentPermissionWithDetails[]> => {
  const results = await trx
    .select({
      // Permission fields
      id: userAgentPermissions.id,
      userId: userAgentPermissions.userId,
      agentId: userAgentPermissions.agentId,
      role: userAgentPermissions.role,
      createdAt: userAgentPermissions.createdAt,
      updatedAt: userAgentPermissions.updatedAt,
      // User fields
      user: {
        id: users.id,
        email: users.email,
        name: users.name,
        photoLink: users.photoLink,
        externalId: users.externalId,
      },
      // Agent fields
      agent: {
        id: agents.id,
        externalId: agents.externalId,
        name: agents.name,
        description: agents.description,
        model: agents.model,
      },
    })
    .from(userAgentPermissions)
    .innerJoin(users, eq(userAgentPermissions.userId, users.id))
    .innerJoin(agents, eq(userAgentPermissions.agentId, agents.id))
    .where(eq(userAgentPermissions.agentId, agentId))
    .orderBy(desc(userAgentPermissions.createdAt))

  return z.array(userAgentPermissionWithDetailsSchema).parse(results)
}

/**
 * Sync user permissions for an agent based on provided email list
 * This function will:
 * 1. Add permissions for new users (as Shared role)
 * 2. Remove permissions for users not in the list (except Owner)
 * 3. Keep existing permissions for users still in the list
 */
export const syncAgentUserPermissions = async (
  trx: TxnOrClient,
  agentId: number,
  userEmails: string[],
  workspaceId: number,
): Promise<void> => {
  // Get current permissions for this agent
  const currentPermissions = await trx
    .select({
      userId: userAgentPermissions.userId,
      userEmail: users.email,
      role: userAgentPermissions.role,
    })
    .from(userAgentPermissions)
    .innerJoin(users, eq(userAgentPermissions.userId, users.id))
    .where(eq(userAgentPermissions.agentId, agentId))

  // Get users by email in the workspace
  const usersInWorkspace = await trx
    .select({
      id: users.id,
      email: users.email,
    })
    .from(users)
    .where(
      and(eq(users.workspaceId, workspaceId), inArray(users.email, userEmails)),
    )

  const currentUserEmails = currentPermissions.map((p) => p.userEmail)
  const newUserEmails = userEmails.filter(
    (email) => !currentUserEmails.includes(email),
  )
  const removedUserEmails = currentUserEmails.filter(
    (email) =>
      !userEmails.includes(email) &&
      currentPermissions.find((p) => p.userEmail === email)?.role !==
        UserAgentRole.Owner,
  )

  // Add permissions for new users
  for (const email of newUserEmails) {
    const user = usersInWorkspace.find((u) => u.email === email)
    if (user) {
      await grantUserAgentPermission(trx, {
        userId: user.id,
        agentId,
        role: UserAgentRole.Shared,
      })
    }
  }

  // Remove permissions for users no longer in the list (except Owner)
  if (removedUserEmails.length > 0) {
    const usersToRemove = await trx
      .select({
        userId: users.id,
      })
      .from(users)
      .where(
        and(
          eq(users.workspaceId, workspaceId),
          inArray(users.email, removedUserEmails),
        ),
      )

    for (const user of usersToRemove) {
      await revokeUserAgentPermission(trx, user.userId, agentId)
    }
  }
}
