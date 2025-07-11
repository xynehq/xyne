import { eq, and } from "drizzle-orm"
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js"
import { messages } from "./schema"
import type { AttachmentMetadata } from "@/shared/types"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Db).child({ module: "attachment" })

export interface AttachmentWithContext extends AttachmentMetadata {
  chatId: string
  messageId: string
  userId: number
}

/**
 * Store attachment metadata in message
 */
export const storeAttachmentMetadata = async (
  db: PostgresJsDatabase<any>,
  messageExternalId: string,
  attachmentsMetadata: AttachmentMetadata[],
  userEmail: string,
): Promise<void> => {
  try {
    await db
      .update(messages)
      .set({
        attachments: attachmentsMetadata,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messages.externalId, messageExternalId),
          eq(messages.email, userEmail),
        ),
      )

    Logger.info(
      `Stored ${attachmentsMetadata.length} attachment(s) metadata for message ${messageExternalId}`,
    )
  } catch (error) {
    Logger.error(
      error,
      `Failed to store attachment metadata for message ${messageExternalId}`,
    )
    throw error
  }
}

/**
 * Retrieve all attachments for a message
 */
export const getAttachmentsByMessageId = async (
  db: PostgresJsDatabase<any>,
  messageExternalId: string,
  userEmail: string,
): Promise<AttachmentMetadata[]> => {
  try {
    const result = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.externalId, messageExternalId),
          eq(messages.email, userEmail),
        ),
      )
      .limit(1)

    if (result.length === 0) {
      return []
    }

    const chat = result[0]
    const attachments = chat.attachments as AttachmentMetadata[]

    // Handle different attachment formats
    let finalAttachments: AttachmentMetadata[] = []
    if (attachments && Array.isArray(attachments)) {
      finalAttachments = attachments
    } else if (typeof attachments === "string") {
      try {
        const parsed = JSON.parse(attachments)
        if (Array.isArray(parsed)) {
          // Validate each item has the expected structure
          finalAttachments = parsed.filter(
            (item) =>
              item &&
              typeof item === "object" &&
              "fileId" in item &&
              "fileName" in item,
          ) as AttachmentMetadata[]
        } else {
          finalAttachments = []
        }
      } catch (e) {
        Logger.error(
          e,
          `Failed to parse attachments string for message ${messageExternalId}`,
        )
      }
    } else if (
      attachments &&
      typeof attachments === "object" &&
      !Array.isArray(attachments)
    ) {
      // If it's a single object, wrap it in an array
      finalAttachments = [attachments as AttachmentMetadata]
    }

    return finalAttachments
  } catch (error) {
    Logger.error(
      error,
      `Failed to retrieve attachments for message ${messageExternalId}`,
    )
    throw error
  }
}
