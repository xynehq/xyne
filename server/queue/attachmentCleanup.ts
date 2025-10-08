import { db } from "@/db/client"
import { chats, messages } from "@/db/schema"
import { lt, eq, and, isNull } from "drizzle-orm"
import { rm } from "fs/promises"
import { join } from "path"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { AttachmentMetadata } from "@/shared/types"
import { DeleteDocument } from "@/search/vespa"
import { KbItemsSchema, fileSchema } from "@xyne/vespa-ts/types"

const Logger = getLogger(Subsystem.Queue).child({ module: "attachment-cleanup" })

/**
 * Cleanup job that deletes attachments from chats that have been inactive for over 15 days
 *
 * Flow:
 * 1. Find all chats inactive for > 15 days (based on updatedAt)
 * 2. Get all messages for those chats
 * 3. Extract all attachment IDs from those messages
 * 4. Delete attachments from both:
 *    - File system (for images stored in downloads/xyne_images_db)
 *    - Vespa (for non-images stored as KnowledgeBase entities)
 * 5. Clear attachment metadata from messages table
 */
export const handleAttachmentCleanup = async () => {
  Logger.info("Starting attachment cleanup job for inactive chats")

  const fifteenDaysAgo = new Date()
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15)

  try {
    // Step 1: Find all chats that have been inactive for over 15 days
    Logger.info(`Finding chats inactive since ${fifteenDaysAgo.toISOString()}`)

    const inactiveChats = await db
      .select({
        id: chats.id,
        externalId: chats.externalId,
        email: chats.email,
        updatedAt: chats.updatedAt,
      })
      .from(chats)
      .where(
        and(
          lt(chats.updatedAt, fifteenDaysAgo),
          isNull(chats.deletedAt) // Only consider non-deleted chats
        )
      )

    if (inactiveChats.length === 0) {
      Logger.info("No inactive chats found. Cleanup complete.")
      return {
        chatsProcessed: 0,
        messagesProcessed: 0,
        attachmentsDeleted: 0,
      }
    }

    Logger.info(`Found ${inactiveChats.length} inactive chats to process`)

    let totalMessagesProcessed = 0
    let totalAttachmentsDeleted = 0

    // Step 2: Process messages in batches per chat for better performance
    for (const chat of inactiveChats) {
      Logger.info(`Processing chat ${chat.externalId} (last updated: ${chat.updatedAt})`)

      const chatMessages = await db
        .select({
          id: messages.id,
          externalId: messages.externalId,
          attachments: messages.attachments,
          sources: messages.sources,
          email: messages.email,
        })
        .from(messages)
        .where(
          and(
            eq(messages.chatExternalId, chat.externalId),
            isNull(messages.deletedAt)
          )
        )

      if (chatMessages.length === 0) {
        Logger.debug(`No messages found for chat ${chat.externalId}`)
        continue
      }

      totalMessagesProcessed += chatMessages.length
      Logger.info(`Found ${chatMessages.length} messages in chat ${chat.externalId}`)

      // Step 3: Process each message's attachments
      for (const message of chatMessages) {
        const attachments = message.attachments as AttachmentMetadata[]

        if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
          continue
        }

        Logger.info(
          `Processing ${attachments.length} attachment(s) from message ${message.externalId}`
        )

        // Step 4 & 5: Use transaction to delete attachments and update message
        try {
          await db.transaction(async (trx) => {
            // Collect fileIds to remove from sources
            const fileIdsToRemove = new Set<string>()

            // Step 4a: Delete each attachment from Vespa and file system
            for (const attachment of attachments) {
              try {
                await deleteAttachment(attachment, message.email)
                totalAttachmentsDeleted++

                // Track fileId for removal from sources
                fileIdsToRemove.add(attachment.fileId)

                Logger.info(
                  `Deleted attachment ${attachment.fileId} (${attachment.fileName}) from message ${message.externalId}`
                )
              } catch (error) {
                Logger.error(
                  error,
                  `Failed to delete attachment ${attachment.fileId} from message ${message.externalId}`
                )
                // Re-throw to rollback transaction
                throw error
              }
            }

            // Step 4b: Remove fileIds from sources array
            const sources = (message.sources || []) as any[]
            const updatedSources = sources.filter((source: any) => {
              // Remove sources that reference deleted attachments
              if (source.fileId && fileIdsToRemove.has(source.fileId)) {
                return false
              }
              return true
            })

            // Step 4c: Clear attachment metadata and update sources in Postgres
            await trx
              .update(messages)
              .set({
                attachments: [],
                sources: updatedSources,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(messages.externalId, message.externalId),
                  eq(messages.email, message.email)
                )
              )

            Logger.debug(
              `Cleared attachment metadata and removed ${fileIdsToRemove.size} fileIds from sources for message ${message.externalId}`
            )
          })

          Logger.info(
            `Successfully processed all attachments for message ${message.externalId} in transaction`
          )
        } catch (error) {
          Logger.error(
            error,
            `Transaction failed for message ${message.externalId}, rolling back`
          )
          // Transaction will automatically rollback on error
        }
      }
    }

    const summary = {
      chatsProcessed: inactiveChats.length,
      messagesProcessed: totalMessagesProcessed,
      attachmentsDeleted: totalAttachmentsDeleted,
    }

    Logger.info(
      `Attachment cleanup complete. Summary: ${JSON.stringify(summary)}`
    )

    return summary
  } catch (error) {
    Logger.error(error, "Error during attachment cleanup job")
    throw error
  }
}

/**
 * Delete a single attachment from both file system and Vespa
 */
async function deleteAttachment(
  attachment: AttachmentMetadata,
  _userEmail: string
): Promise<void> {
  const fileId = attachment.fileId

  // Delete from file system (for images only)
  if (attachment.isImage) {
    try {
      const baseDir = Bun.env.IMAGE_DIR || "downloads/xyne_images_db"
      const attachmentDir = join(baseDir, fileId)

      await rm(attachmentDir, { recursive: true, force: true })

      Logger.debug(`Deleted image attachment directory: ${attachmentDir}`)
    } catch (error) {
      // Log but don't fail - file might already be deleted
      Logger.warn(
        error,
        `Could not delete image directory for attachment ${fileId}`
      )
    }
  }

  // Delete from Vespa
  // - If fileId starts with 'att_', it's an attachment stored in KbItemsSchema
  // - Otherwise, it's a file stored in fileSchema
  try {
    if (fileId.startsWith("att_")) {
      await DeleteDocument(fileId, KbItemsSchema)
      Logger.debug(`Deleted attachment ${fileId} from Vespa (KbItemsSchema)`)
    } else {
      await DeleteDocument(fileId, fileSchema)
      Logger.debug(`Deleted file ${fileId} from Vespa (fileSchema)`)
    }
  } catch (error) {
    // Log but don't fail - document might not exist in Vespa
    Logger.warn(
      error,
      `Could not delete Vespa document for ${fileId}`
    )
  }
}
