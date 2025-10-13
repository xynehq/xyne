import { db } from "@/db/client"
import { chats, messages } from "@/db/schema"
import { lt, eq, and, isNull } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { AttachmentMetadata } from "@/shared/types"
import { handleAttachmentDelete } from "@/api/files"

const Logger = getLogger(Subsystem.Queue).child({ module: "attachment-cleanup" })
const INACTIVE_CHAT_CLEANUP_DAYS = 15

/**
 * Cleanup job that deletes attachments from chats that have been inactive for over 15 days
 *
 * Flow:
 * 1. Find all chats inactive for > 15 days (based on updatedAt) - in batches
 * 2. Get all messages for those chats - in batches
 * 3. Extract all attachment IDs from those messages
 * 4. Delete attachments using handleAttachmentDelete from @/api/files:
 *    - File system (for images stored in downloads/xyne_images_db)
 *    - Vespa (for both KbItemsSchema with 'att_' prefix and fileSchema with 'attf_' prefix)
 * 5. Clear attachment metadata and update sources in messages table
 */
export const handleAttachmentCleanup = async () => {
  Logger.info("Starting attachment cleanup job for inactive chats")

  const fifteenDaysAgo = new Date()
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - INACTIVE_CHAT_CLEANUP_DAYS)

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

            // Step 5: Delete attachments and update message
            try {
              // Collect fileIds to remove from sources
              const fileIdsToRemove = new Set<string>()
              for (const attachment of attachments) {
                fileIdsToRemove.add(attachment.fileId)
              }

              // Delete all attachments using the shared function from files.ts
              await handleAttachmentDelete(attachments, message.email)
              totalAttachmentsDeleted += attachments.length

              Logger.info(
                `Deleted ${attachments.length} attachment(s) from message ${message.externalId}`
              )

              // Update message in database to clear attachments and update sources
              await db.transaction(async (trx) => {
                // Remove fileIds from sources array
                const sources = (message.sources || []) as any[]
                const updatedSources = sources.filter((source: any) => {
                  // Remove sources that reference deleted attachments
                  if (source.fileId && fileIdsToRemove.has(source.fileId)) {
                    return false
                  }
                  return true
                })

                // Clear attachment metadata and update sources in Postgres
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
                `Successfully processed all attachments for message ${message.externalId}`
              )
            } catch (error) {
              Logger.error(
                error,
                `Failed to process attachments for message ${message.externalId}`
              )
              // Continue processing other messages even if this one fails
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
