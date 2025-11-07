import {
  userWorkflowPermissions,
  workflowTemplate,
  users,
  insertUserWorkflowPermissionSchema,
  selectUserWorkflowPermissionSchema,
  userWorkflowPermissionWithDetailsSchema,
  type InsertUserWorkflowPermission,
  type SelectUserWorkflowPermission,
  type UserWorkflowPermissionWithDetails,
} from "@/db/schema"
import { UserWorkflowRole } from "@/shared/types"
import type { TxnOrClient } from "@/types"
import { z } from "zod"
import { and, eq, isNull, desc, or, inArray } from "drizzle-orm"

//Check if a user has access to a specific workflow
export const checkUserWorkflowAccess = async (
  trx: TxnOrClient,
  userId: number,
  workflowId: string,
): Promise<SelectUserWorkflowPermission | null> => {
  const permissionArr = await trx
    .select()
    .from(userWorkflowPermissions)
    .where(
      and(
        eq(userWorkflowPermissions.userId, userId),
        eq(userWorkflowPermissions.workflowId, workflowId),
      ),
    )

  if (!permissionArr || !permissionArr.length) {
    return null
  }

  return selectUserWorkflowPermissionSchema.parse(permissionArr[0])
}

//Grant permission to a user for a workflow
export const grantUserWorkflowPermission = async (
  trx: TxnOrClient,
  permissionData: InsertUserWorkflowPermission,
): Promise<SelectUserWorkflowPermission> => {
  const validatedData = insertUserWorkflowPermissionSchema.parse(permissionData)

  const permissionArr = await trx
    .insert(userWorkflowPermissions)
    .values(validatedData)
    .returning()

  if (!permissionArr || !permissionArr.length) {
    throw new Error('Error in insert of user workflow permission "returning"')
  }

  return selectUserWorkflowPermissionSchema.parse(permissionArr[0])
}

//Update user's permission for a workflow
export const updateUserWorkflowPermission = async (
  trx: TxnOrClient,
  userId: number,
  workflowId: string,
  role: UserWorkflowRole,
): Promise<SelectUserWorkflowPermission | null> => {
  const permissionArr = await trx
    .update(userWorkflowPermissions)
    .set({
      role,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userWorkflowPermissions.userId, userId),
        eq(userWorkflowPermissions.workflowId, workflowId),
      ),
    )
    .returning()

  if (!permissionArr || !permissionArr.length) {
    return null
  }

  return selectUserWorkflowPermissionSchema.parse(permissionArr[0])
}

//Get all users (owner + shard + viewer) for a workflow
export const getWorkflowUsers = async (
  trx: TxnOrClient,
  workflowId: string,
): Promise<UserWorkflowPermissionWithDetails[]> => {
  const results = await trx
    .select({
      user: {
        externalId: users.externalId,
        email: users.email,
        name: users.name,
        photoLink: users.photoLink,
      },
      workflow: {
        id: workflowTemplate.id,
        name: workflowTemplate.name,
        description: workflowTemplate.description,
        version: workflowTemplate.version
      },
      role: userWorkflowPermissions.role,
    })
    .from(userWorkflowPermissions)
    .innerJoin(users, eq(userWorkflowPermissions.userId, users.id))
    .innerJoin(workflowTemplate, eq(userWorkflowPermissions.workflowId, workflowTemplate.id))
    .where(eq(userWorkflowPermissions.workflowId, workflowId))


  return z.array(userWorkflowPermissionWithDetailsSchema).parse(results)
}

//Revoke user's permission for a workflow
export const revokeUserWorkflowPermission = async (
  trx: TxnOrClient,
  userId: number,
  workflowId: string,
): Promise<boolean> => {
  const result = await trx
    .delete(userWorkflowPermissions)
    .where(
      and(
        eq(userWorkflowPermissions.userId, userId),
        eq(userWorkflowPermissions.workflowId, workflowId),
      ),
    )
    .returning()

  return result.length > 0
}

/**
 * Sync user permissions for a workflow based on provided email list
 * This function will:
 * 1. Add permissions for new users (as Shared role)
 * 2. Remove permissions for users not in the list (except Owner)
 * 3. Keep existing permissions for users still in the list
 */
export const syncWorkflowUserPermissions = async (
  trx: TxnOrClient,
  workflowId: string,
  userEmails: string[],
  workspaceId: number,
): Promise<void> => {
  // Get current permissions for this workflow
  const currentPermissions = await trx
    .select({
      userId: userWorkflowPermissions.userId,
      userEmail: users.email,
      role: userWorkflowPermissions.role,
    })
    .from(userWorkflowPermissions)
    .innerJoin(users, eq(userWorkflowPermissions.userId, users.id))
    .where(eq(userWorkflowPermissions.workflowId, workflowId))

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
        UserWorkflowRole.Owner,
  )

  // Add permissions for new users
  for (const email of newUserEmails) {
    const user = usersInWorkspace.find((u) => u.email === email)
    if (user) {
      await grantUserWorkflowPermission(trx, {
        userId: user.id,
        workflowId,
        role: UserWorkflowRole.Shared,
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
      await revokeUserWorkflowPermission(trx, user.userId, workflowId)
    }
  }
}