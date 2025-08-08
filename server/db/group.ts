import { Subsystem, type TxnOrClient } from "@/types"
import { groups } from "@/db/schema/groups"
import { getLogger } from "@/logger"
import { GroupInsertionError } from "@/errors"
import { eq } from "drizzle-orm"
import { groupMembers } from "@/db/schema/groupMembers"

const Logger = getLogger(Subsystem.Db).child({ module: "group" })

export const insertGroup = async (
  trx: TxnOrClient,
  id: string,
  name: string,
  groupEmail: string,
  description: string,
  directMembersCount: string,
) => {
  try {
    const inserted = await trx
      .insert(groups)
      .values({
        id,
        name,
        groupEmail,
        description,
        directMembersCount,
      })
      .returning()
    return inserted[0]
  } catch (error) {
    Logger.error(
      error,
      `Error inserting group:, ${error} \n ${(error as Error).stack}`,
    )
    throw new GroupInsertionError({
      message: "Could not insert group",
      cause: error as Error,
    })
  }
}

export const insertGroupMembers = async (
  trx: TxnOrClient,
  groupId: string,
  memberEmails: string[],
) => {
  try {
    const rows = memberEmails.map((email) => ({
      groupId,
      memberEmail: email,
    }))

    const inserted = await trx.insert(groupMembers).values(rows).returning()
    return inserted[0]
  } catch (error) {
    Logger.error(
      error,
      `Error inserting group members for group ${groupId}: ${error} \n ${(error as Error).stack}`,
    )
    throw new GroupInsertionError({
      message: "Could not insert group members",
      cause: error as Error,
    })
  }
}

export const getGroupEmailsFromEmail = async (
  trx: TxnOrClient,
  userEmail: string,
): Promise<string[]> => {
  const rows = await trx
    .select({ groupEmail: groups.groupEmail })
    .from(groups)
    .innerJoin(groupMembers, eq(groups.id, groupMembers.groupId))
    .where(eq(groupMembers.memberEmail, userEmail))

  return rows.map((row) => row.groupEmail)
}

export const getAllGroupEmails = async (
  trx: TxnOrClient,
): Promise<string[]> => {
  const allGroups = await trx
    .select({ groupEmail: groups.groupEmail })
    .from(groups)
  return allGroups.map((grp) => grp.groupEmail)
}
