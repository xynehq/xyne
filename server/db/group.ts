import { Subsystem, type TxnOrClient } from "@/types"
import { groups } from "./schema"
import { getLogger } from "@/logger"
import { GroupInsertionError } from "@/errors"
import { sql } from "drizzle-orm"

const Logger = getLogger(Subsystem.Db).child({ module: "group" })

export const insertGroup = async (
  trx: TxnOrClient,
  id: string,
  name: string,
  groupEmail: string,
  description: string,
  directMembersCount: string,
  memberEmails: string[],
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
        memberEmails,
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

export const getGroupEmailsFromEmail = async (
  trx: TxnOrClient,
  userEmail: string,
): Promise<string[]> => {
  // Query the groups table and select only the groupEmail field
  const rows = await trx
    .select({ groupEmail: groups.groupEmail })
    .from(groups)
    // Check if the provided userEmail is in the memberEmails array using the ANY operator
    .where(sql`${userEmail} = ANY(${groups.memberEmails})`)

  // Return an array of group emails
  return rows.map((row) => row.groupEmail)
}
