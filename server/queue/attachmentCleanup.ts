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
 * 1. Find all chats inactive for > 15 days (based on updatedAt) - in batches
 * 2. Get all messages for those chats - in batches
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

  const CHAT_BATCH_SIZE = 100
  const MESSAGE_BATCH_SIZE = 50

  let totalChatsProcessed = 0
  let totalMessagesProcessed = 0
  let totalAttachmentsDeleted = 0

  try {
    Logger.info(`Finding chats inactive since ${fifteenDaysAgo.toISOString()}`)

    // Step 1: Process chats in batches to prevent memory exhaustion
    let chatOffset = 0
    let hasMoreChats = true

    while (hasMoreChats) {
      // Fetch batch of inactive chats
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
        .limit(CHAT_BATCH_SIZE)
        .offset(chatOffset)

      if (inactiveChats.length === 0) {
        hasMoreChats = false
        break
      }

      Logger.info(
        `Processing chat batch: offset ${chatOffset}, found ${inactiveChats.length} chats`
      )

      // Step 2: Process each chat in the batch
      for (const chat of inactiveChats) {
        Logger.info(`Processing chat ${chat.externalId} (last updated: ${chat.updatedAt})`)

        // Step 3: Process messages in batches per chat
        let messageOffset = 0
        let hasMoreMessages = true

        while (hasMoreMessages) {
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
            .limit(MESSAGE_BATCH_SIZE)
            .offset(messageOffset)

          if (chatMessages.length === 0) {
            hasMoreMessages = false
            break
          }

          Logger.debug(
            `Processing message batch for chat ${chat.externalId}: offset ${messageOffset}, found ${chatMessages.length} messages`
          )

          totalMessagesProcessed += chatMessages.length

          // Step 4: Process each message's attachments
          for (const message of chatMessages) {
            const attachments = message.attachments as AttachmentMetadata[]

            if (!attachments || !Array.isArray(attachments) || attachments.length === 0) {
              continue
            }

            Logger.info(
              `Processing ${attachments.length} attachment(s) from message ${message.externalId}`
            )

            // Step 5: Use transaction to delete attachments and update message
            try {
              await db.transaction(async (trx) => {
                // Collect fileIds to remove from sources
                const fileIdsToRemove = new Set<string>()

                // Step 5a: Delete each attachment from Vespa and file system
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

                // Step 5b: Remove fileIds from sources array
                const sources = (message.sources || []) as any[]
                const updatedSources = sources.filter((source: any) => {
                  // Remove sources that reference deleted attachments
                  if (source.fileId && fileIdsToRemove.has(source.fileId)) {
                    return false
                  }
                  return true
                })

                // Step 5c: Clear attachment metadata and update sources in Postgres
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

          messageOffset += MESSAGE_BATCH_SIZE
        }

        totalChatsProcessed++
      }

      // Move to next batch of chats
      chatOffset += CHAT_BATCH_SIZE
      hasMoreChats = inactiveChats.length === CHAT_BATCH_SIZE
    }

    const summary = {
      chatsProcessed: totalChatsProcessed,
      messagesProcessed: totalMessagesProcessed,
      attachmentsDeleted: totalAttachmentsDeleted,
    }

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
      throw error
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
    throw error
  }
}
