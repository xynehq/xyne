import {
  userWorkflowPermissions,
  insertUserWorkflowPermissionSchema,
  selectUserWorkflowPermissionSchema,
  type InsertUserWorkflowPermission,
  type SelectUserWorkflowPermission,
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

  return result.rowCount > 0
}
