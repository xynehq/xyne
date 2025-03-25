import { Subsystem, type TxnOrClient } from "@/types"
import { groups } from "./schema"
import { getLogger } from "@/logger"
import { GroupInsertionError } from "@/errors"

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
