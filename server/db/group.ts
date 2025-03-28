import { Subsystem, type TxnOrClient } from "@/types"
import { groupMembers, groups } from "./schema"
import { getLogger } from "@/logger"
import { GroupInsertionError } from "@/errors"
import { eq } from "drizzle-orm"

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
    Logger.info("Group inserted successfully")
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
    Logger.info(`Group members for group ${groupId} inserted successfully`)
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
