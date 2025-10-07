import type { AttachmentMetadata } from "@/shared/types"
import { HTTPException } from "hono/http-exception"
import type { Context } from "hono"
import { Subsystem } from "@/types"
import { getLogger } from "@/logger"
import { attachmentMetadataSchema } from "@/shared/types"
import { db } from "@/db/client"
import { getChatMessagesWithAuth } from "@/db/message"
import { getAttachmentsByMessageId } from "@/db/attachment"
import { MessageRole } from "@/types"
import { getErrorMessage } from "@/utils"

const logger = getLogger(Subsystem.Utils).child({ module: "attachment" })

export const parseAttachmentMetadata = (c: Context): AttachmentMetadata[] => {
  const attachmentMetadataQuery = c.req.query("attachmentMetadata")

  if (!attachmentMetadataQuery) {
    return []
  }

  try {
    const parsed = JSON.parse(attachmentMetadataQuery)

    // Validate that the parsed result is an array
    if (!Array.isArray(parsed)) {
      logger.warn("attachmentMetadata query parameter is not an array", {
        type: typeof parsed,
        value: parsed,
      })
      throw new HTTPException(400, {
        message: "attachmentMetadata must be an array",
      })
    }

    // Validate each item against the schema
    const validatedItems = parsed.map((item, index) => {
      try {
        return attachmentMetadataSchema.parse(item)
      } catch (error) {
        logger.warn(`Invalid attachment metadata at index ${index}`, {
          item,
          error,
        })
        throw new HTTPException(400, {
          message: `Invalid attachment metadata format at index ${index}`,
        })
      }
    })

    return validatedItems
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error // Re-throw our own HTTPExceptions
    }

    // Handle JSON parsing errors
    logger.error("Failed to parse attachmentMetadata JSON", {
      error: error instanceof Error ? error.message : String(error),
      queryValue: attachmentMetadataQuery,
    })

    throw new HTTPException(400, {
      message: "Failed to parse attachmentMetadata",
    })
  }
}

interface FollowUpContext {
  fileIds: string[];
  imageAttachmentFileIds: string[];
  attachmentMetadata: AttachmentMetadata[];
}

/**
 * Retrieves follow-up context from the previous user message
 * @param chatId - Chat external ID
 * @param email - User email
 * @returns Context from previous message (fileIds and attachments)
 */
export async function applyFollowUpContext(
  chatId: string,
  email: string
): Promise<FollowUpContext> {
  logger.info("isFollowUp is true, getting context from previous user message")

  const newContext: FollowUpContext = {
    fileIds: [],
    imageAttachmentFileIds: [],
    attachmentMetadata: [],
  }
  
  try {
    // Get all messages from the chat
    const allMessages = await getChatMessagesWithAuth(db, chatId, email)
    
    // Find the last user message by iterating backwards (more efficient)
    let lastUserMessage = null
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].messageRole === MessageRole.User) {
        lastUserMessage = allMessages[i]
        break
      }
    }
    
    if (!lastUserMessage) {
      logger.warn("No previous user message found for follow-up context")
      return newContext
    }
    
    // Get and add fileIds from the previous user message
    const prevFileIds = Array.isArray(lastUserMessage.fileIds) ? lastUserMessage.fileIds : []
    if (prevFileIds.length > 0) {
      logger.info(
        `Found ${prevFileIds.length} fileIds from previous user message`
      )
      newContext.fileIds.push(...prevFileIds)
    }
    
    // Get attachments from the previous user message
    const prevAttachments = await getAttachmentsByMessageId(db, lastUserMessage.externalId, email)
    if (prevAttachments.length > 0) {
      logger.info(
        `Found ${prevAttachments.length} attachments from previous user message`
      )

      // Add all previous attachments to attachmentMetadata
      newContext.attachmentMetadata.push(...prevAttachments)
      
      // Add image attachment fileIds
      const prevImageAttachmentFileIds = prevAttachments
        .filter((m) => m.isImage)
        .map((m) => m.fileId)
      
      if (prevImageAttachmentFileIds.length > 0) {
        newContext.imageAttachmentFileIds.push(...prevImageAttachmentFileIds)
      }
      
      // Add non-image attachment fileIds
      const prevNonImageAttachmentFileIds = prevAttachments
        .filter((m) => !m.isImage)
        .map((m) => m.fileId)
      
      if (prevNonImageAttachmentFileIds.length > 0) {
        newContext.fileIds.push(...prevNonImageAttachmentFileIds)
      }
    }
    
    return newContext
  } catch (error) {
    logger.error(
      error,
      `Error getting context from previous user message for isFollowUp: ${getErrorMessage(error)}`
    )
    // Continue execution even if we can't get previous context
    return newContext
  }
}
