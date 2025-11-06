import type { Context } from "hono"
import { db } from "@/db/client"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import config from "@/config"
import { directMessages } from "@/db/schema/directMessages"
import { users } from "@/db/schema/users"
import { threads, threadReplies } from "@/db/schema/threads"
import { eq, and, or, desc, sql, asc, inArray } from "drizzle-orm"
import { getUserByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { realtimeMessagingService } from "@/services/callNotifications"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "directMessages" })

// Import Lexical schema
import { lexicalEditorStateSchema } from "@/db/schema/directMessages"

// Helper functions for cursor-based pagination
const encodeCursor = (id: number): string => {
  return Buffer.from(id.toString()).toString("base64")
}

const decodeCursor = (cursor: string): number | null => {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8")
    const id = parseInt(decoded, 10)
    return isNaN(id) ? null : id
  } catch {
    return null
  }
}

// Schemas
export const sendMessageSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  messageContent: lexicalEditorStateSchema,
})

/**
 * Cursor-based pagination schema for conversations
 * Following Slack's approach:
 * - Uses cursor instead of offset for efficient pagination
 * - Default limit of 100, max 200 (as recommended by Slack)
 * - Cursor is base64-encoded message ID
 * - Empty cursor means start from beginning
 * - Empty nextCursor in response means no more results
 */
export const getConversationSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  limit: z.coerce.number().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
})

export const markAsReadSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
})

export const editMessageSchema = z.object({
  messageId: z.number().int().positive("Message ID is required"),
  messageContent: lexicalEditorStateSchema,
})

export const deleteMessageSchema = z.object({
  messageId: z.number().int().positive("Message ID is required"),
})

// Send a direct message
export const SendMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: senderEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { targetUserId, messageContent } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = sendMessageSchema.parse({
      targetUserId,
      messageContent,
    })

    // Get sender info
    const senderUsers = await getUserByEmail(db, senderEmail)
    if (!senderUsers || senderUsers.length === 0) {
      throw new HTTPException(404, { message: "Sender not found" })
    }
    const sender = senderUsers[0]

    // Get target user info
    const targetUsers = await db
      .select()
      .from(users)
      .where(eq(users.externalId, validatedData.targetUserId))
      .limit(1)
    if (!targetUsers || targetUsers.length === 0) {
      throw new HTTPException(404, { message: "Target user not found" })
    }
    const targetUser = targetUsers[0]

    // Allow self-messaging (useful for notes/reminders)
    // No restriction on messaging yourself

    // Check if both users are in the same workspace (skip for self-messages)
    if (sender.workspaceId !== targetUser.workspaceId) {
      throw new HTTPException(403, {
        message: "Users must be in the same workspace",
      })
    }

    // Insert message
    const [message] = await db
      .insert(directMessages)
      .values({
        sentByUserId: sender.id,
        sentToUserId: targetUser.id,
        messageContent: validatedData.messageContent,
      })
      .returning()

    Logger.info({
      msg: "DM sent",
      messageId: message.id,
      fromUserId: sender.externalId,
      toUserId: targetUser.externalId,
    })

    // Extract plain text from Lexical JSON for notifications
    const extractPlainText = (lexicalJson: any): string => {
      const traverse = (node: any): string => {
        if (!node) return ""
        if (node.text) return node.text
        if (node.children && Array.isArray(node.children)) {
          return node.children.map((child: any) => traverse(child)).join("")
        }
        return ""
      }
      return traverse(lexicalJson.root)
    }

    const plainTextContent = extractPlainText(message.messageContent)

    // Send real-time notification to target user if they're online
    const messageNotification = {
      type: "direct_message" as const,
      messageId: message.id,
      messageContent: message.messageContent,
      plainTextContent, // For notifications/previews
      createdAt: message.createdAt,
      sender: {
        id: sender.externalId,
        name: sender.name,
        email: sender.email,
        photoLink: sender.photoLink,
      },
      timestamp: Date.now(),
    }

    realtimeMessagingService.sendDirectMessage(
      targetUser.externalId,
      messageNotification,
    )

    return c.json({
      success: true,
      message: {
        id: message.id,
        sentByUserId: sender.externalId,
        sentToUserId: targetUser.externalId,
        messageContent: message.messageContent,
        isRead: message.isRead,
        createdAt: message.createdAt,
        sender: {
          id: sender.externalId,
          name: sender.name,
          email: sender.email,
          photoLink: sender.photoLink,
        },
      },
    })
  } catch (error) {
    Logger.error(error, "Error sending message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to send message" })
  }
}

// Get conversation history between two users
export const GetConversationApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get query parameters - already validated by zValidator middleware
    const targetUserId = c.req.query("targetUserId")!
    const limitStr = c.req.query("limit")
    const cursor = c.req.query("cursor")

    // Parse and validate with schema (applies defaults)
    const validatedData = getConversationSchema.parse({
      targetUserId,
      limit: limitStr, // z.coerce.number() will convert this
      cursor,
    })

    // Get current user info
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get target user info
    const targetUsers = await db
      .select()
      .from(users)
      .where(eq(users.externalId, validatedData.targetUserId))
      .limit(1)
    if (!targetUsers || targetUsers.length === 0) {
      throw new HTTPException(404, { message: "Target user not found" })
    }
    const targetUser = targetUsers[0]

    // Check if both users are in the same workspace
    if (currentUser.workspaceId !== targetUser.workspaceId) {
      throw new HTTPException(403, {
        message: "Users must be in the same workspace",
      })
    }

    // Decode cursor to get the message ID to start from
    let cursorId: number | null = null
    if (validatedData.cursor) {
      cursorId = decodeCursor(validatedData.cursor)
      if (cursorId === null) {
        throw new HTTPException(400, { message: "invalid_cursor" })
      }
    }

    // Fetch limit + 1 to determine if there are more results
    const fetchLimit = validatedData.limit + 1

    // Build the where clause
    const conversationCondition = and(
      or(
        and(
          eq(directMessages.sentByUserId, currentUser.id),
          eq(directMessages.sentToUserId, targetUser.id),
        ),
        and(
          eq(directMessages.sentByUserId, targetUser.id),
          eq(directMessages.sentToUserId, currentUser.id),
        ),
      ),
      sql`${directMessages.deletedAt} IS NULL`,
      // Add cursor condition: fetch messages with ID less than cursor (for descending order - older messages)
      cursorId ? sql`${directMessages.id} < ${cursorId}` : sql`1=1`,
    )

    // Get messages between the two users
    const messages = await db
      .select({
        id: directMessages.id,
        messageContent: directMessages.messageContent,
        isRead: directMessages.isRead,
        isEdited: directMessages.isEdited,
        createdAt: directMessages.createdAt,
        sentByUserId: directMessages.sentByUserId,
        sentToUserId: directMessages.sentToUserId,
        senderName: sql<string>`sender.name`,
        senderEmail: sql<string>`sender.email`,
        senderPhotoLink: sql<string>`sender."photoLink"`,
        senderExternalId: sql<string>`sender.external_id`,
        // Thread information
        threadId: threads.id,
        replyCount: threads.replyCount,
        lastReplyAt: threads.lastReplyAt,
      })
      .from(directMessages)
      .innerJoin(
        sql`users AS sender`,
        sql`sender.id = ${directMessages.sentByUserId}`,
      )
      .leftJoin(
        threads,
        and(
          eq(threads.parentMessageId, directMessages.id),
          eq(threads.messageType, "direct"),
        ),
      )
      .where(conversationCondition)
      .orderBy(desc(directMessages.id)) // Order by ID DESC to get newest first, then paginate to older
      .limit(fetchLimit)

    // Determine if there are more results
    const hasMore = messages.length > validatedData.limit
    const messagesToReturn = hasMore ? messages.slice(0, -1) : messages

    // Generate next cursor from the last (oldest) message's ID
    let nextCursor = ""
    if (hasMore && messagesToReturn.length > 0) {
      const oldestMessage = messagesToReturn[messagesToReturn.length - 1]
      nextCursor = encodeCursor(oldestMessage.id)
    }

    // Reverse the messages to display oldest to newest (bottom to top in chat UI)
    const messagesInDisplayOrder = messagesToReturn.reverse()

    // Fetch repliers for messages with threads (limit to 3 most recent unique repliers per thread)
    const threadIds = messagesInDisplayOrder
      .filter((msg) => msg.threadId)
      .map((msg) => msg.threadId!)

    let repliersMap = new Map<
      number,
      Array<{ userId: number; name: string; photoLink: string | null }>
    >()

    if (threadIds.length > 0) {
      // Get distinct repliers for each thread (limit 3 most recent unique repliers per thread)
      // We need to get all replies, then group by thread and get unique senders
      const allReplies = await db
        .select({
          threadId: threadReplies.threadId,
          senderId: threadReplies.senderId,
          senderName: users.name,
          senderPhotoLink: users.photoLink,
          createdAt: threadReplies.createdAt,
        })
        .from(threadReplies)
        .innerJoin(users, eq(users.id, threadReplies.senderId))
        .where(
          and(
            inArray(threadReplies.threadId, threadIds),
            sql`${threadReplies.deletedAt} IS NULL`,
          ),
        )
        .orderBy(desc(threadReplies.createdAt))

      // Group by thread ID and get up to 3 unique senders per thread
      for (const reply of allReplies) {
        if (!repliersMap.has(reply.threadId)) {
          repliersMap.set(reply.threadId, [])
        }
        const threadRepliers = repliersMap.get(reply.threadId)!

        // Check if this sender is already in the list (by userId, not name)
        const alreadyAdded = threadRepliers.some(
          (r) => r.userId === reply.senderId,
        )

        // Add if not already added and we haven't reached the limit of 3
        if (!alreadyAdded && threadRepliers.length < 3) {
          threadRepliers.push({
            userId: reply.senderId,
            name: reply.senderName,
            photoLink: reply.senderPhotoLink,
          })
        }
      }
    }

    return c.json({
      success: true,
      messages: messagesInDisplayOrder.map((msg) => ({
        id: msg.id,
        messageContent: msg.messageContent,
        isRead: msg.isRead,
        isEdited: msg.isEdited,
        createdAt: msg.createdAt,
        sentByUserId: msg.senderExternalId,
        isMine: msg.sentByUserId === currentUser.id,
        sender: {
          id: msg.senderExternalId,
          name: msg.senderName,
          email: msg.senderEmail,
          photoLink: msg.senderPhotoLink,
        },
        // Thread information
        threadId: msg.threadId,
        replyCount: msg.replyCount || 0,
        lastReplyAt: msg.lastReplyAt,
        repliers: msg.threadId
          ? (repliersMap.get(msg.threadId) || []).map(
              ({ userId, name, photoLink }) => ({
                userId,
                name,
                photoLink,
              }),
            )
          : [],
      })),
      targetUser: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink,
      },
      responseMetadata: {
        nextCursor, // Empty string when no more results
        hasMore,
      },
    })
  } catch (error) {
    Logger.error(error, "Error getting conversation")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get conversation" })
  }
}

// Mark messages as read
export const MarkMessagesAsReadApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { targetUserId } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = markAsReadSchema.parse({ targetUserId })

    // Get current user info
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get target user info
    const targetUsers = await db
      .select()
      .from(users)
      .where(eq(users.externalId, validatedData.targetUserId))
      .limit(1)
    if (!targetUsers || targetUsers.length === 0) {
      throw new HTTPException(404, { message: "Target user not found" })
    }
    const targetUser = targetUsers[0]

    // Enforce workspace scoping
    if (currentUser.workspaceId !== targetUser.workspaceId) {
      throw new HTTPException(403, {
        message: "Users must be in the same workspace",
      })
    }

    // Mark all unread messages from targetUser to currentUser as read
    await db
      .update(directMessages)
      .set({ isRead: true, updatedAt: new Date() })
      .where(
        and(
          eq(directMessages.sentByUserId, targetUser.id),
          eq(directMessages.sentToUserId, currentUser.id),
          eq(directMessages.isRead, false),
        ),
      )

    // Send read receipt to target user if they're online
    realtimeMessagingService.sendReadReceipt(
      targetUser.externalId,
      currentUser.externalId,
    )

    return c.json({
      success: true,
      message: "Messages marked as read",
    })
  } catch (error) {
    Logger.error(error, "Error marking messages as read")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to mark messages as read" })
  }
}

// Get unread message counts
export const GetUnreadCountsApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get current user info
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get unread counts per sender
    const unreadCounts = await db
      .select({
        senderUserId: directMessages.sentByUserId,
        count: sql<number>`COUNT(*)::int`,
        senderName: sql<string>`sender.name`,
        senderEmail: sql<string>`sender.email`,
        senderPhotoLink: sql<string>`sender."photoLink"`,
        senderExternalId: sql<string>`sender.external_id`,
      })
      .from(directMessages)
      .innerJoin(
        sql`users AS sender`,
        sql`sender.id = ${directMessages.sentByUserId}`,
      )
      .where(
        and(
          eq(directMessages.sentToUserId, currentUser.id),
          eq(directMessages.isRead, false),
          sql`${directMessages.deletedAt} IS NULL`,
        ),
      )
      .groupBy(
        directMessages.sentByUserId,
        sql`sender.name`,
        sql`sender.email`,
        sql`sender."photoLink"`,
        sql`sender.external_id`,
      )

    return c.json({
      success: true,
      unreadCounts: unreadCounts.map((item) => ({
        userId: item.senderExternalId,
        count: item.count,
        user: {
          id: item.senderExternalId,
          name: item.senderName,
          email: item.senderEmail,
          photoLink: item.senderPhotoLink,
        },
      })),
    })
  } catch (error) {
    Logger.error(error, "Error getting unread counts")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to get unread counts" })
  }
}

// Get conversation participants (users you've chatted with)
export const GetConversationParticipantsApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Get current user info
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get all unique users with their most recent message time
    // Subquery to get the most recent message timestamp for each conversation
    const participants = await db
      .select({
        userExternalId: sql<string>`other_user.external_id`,
        userName: sql<string>`other_user.name`,
        userEmail: sql<string>`other_user.email`,
        userPhotoLink: sql<string>`other_user."photoLink"`,
        lastMessageTime: sql<Date>`MAX(${directMessages.createdAt})`,
      })
      .from(directMessages)
      .innerJoin(
        sql`users AS other_user`,
        sql`other_user.id = CASE 
          WHEN ${directMessages.sentByUserId} = ${currentUser.id} THEN ${directMessages.sentToUserId}
          ELSE ${directMessages.sentByUserId}
        END`,
      )
      .where(
        and(
          or(
            eq(directMessages.sentByUserId, currentUser.id),
            eq(directMessages.sentToUserId, currentUser.id),
          ),
          sql`${directMessages.deletedAt} IS NULL`,
        ),
      )
      .groupBy(
        sql`other_user.external_id`,
        sql`other_user.name`,
        sql`other_user.email`,
        sql`other_user."photoLink"`,
      )
      .orderBy(desc(sql`MAX(${directMessages.createdAt})`))

    return c.json({
      success: true,
      participants: participants.map((p) => ({
        id: p.userExternalId,
        name: p.userName,
        email: p.userEmail,
        photoLink: p.userPhotoLink,
      })),
    })
  } catch (error) {
    Logger.error(error, "Error getting conversation participants")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, {
      message: "Failed to get conversation participants",
    })
  }
}

// Edit a direct message
export const EditMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { messageId, messageContent } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = editMessageSchema.parse({
      messageId,
      messageContent,
    })

    // Get current user info
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get the message and verify ownership
    const [message] = await db
      .select()
      .from(directMessages)
      .where(eq(directMessages.id, validatedData.messageId))
      .limit(1)

    if (!message) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    if (message.sentByUserId !== currentUser.id) {
      throw new HTTPException(403, {
        message: "You can only edit your own messages",
      })
    }

    if (message.deletedAt) {
      throw new HTTPException(400, { message: "Cannot edit deleted message" })
    }

    // Update the message
    const [updatedMessage] = await db
      .update(directMessages)
      .set({
        messageContent: validatedData.messageContent,
        isEdited: true,
        updatedAt: new Date(),
      })
      .where(eq(directMessages.id, validatedData.messageId))
      .returning()

    Logger.info({
      msg: "DM edited",
      messageId: updatedMessage.id,
      userId: currentUser.externalId,
    })

    // Get recipient info for real-time notification
    const [recipient] = await db
      .select({
        id: users.id,
        externalId: users.externalId,
      })
      .from(users)
      .where(eq(users.id, message.sentToUserId))
      .limit(1)

    // Send real-time notification to the recipient
    if (recipient) {
      realtimeMessagingService.sendDirectMessageEdit(
        recipient.externalId,
        updatedMessage.id,
        updatedMessage.messageContent,
        updatedMessage.updatedAt,
      )
    }

    return c.json({
      success: true,
      message: {
        id: updatedMessage.id,
        messageContent: updatedMessage.messageContent,
        isEdited: updatedMessage.isEdited,
        updatedAt: updatedMessage.updatedAt,
      },
    })
  } catch (error) {
    Logger.error(error, "Error editing message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to edit message" })
  }
}

// Delete a direct message (soft delete)
export const DeleteMessageApi = async (c: Context) => {
  try {
    const { workspaceId, sub: userEmail } = c.get(JwtPayloadKey)
    const requestBody = await c.req.json()
    const { messageId } = requestBody

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    // Validate input
    const validatedData = deleteMessageSchema.parse({ messageId })

    // Get current user info
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]

    // Get the message and verify ownership
    const [message] = await db
      .select()
      .from(directMessages)
      .where(eq(directMessages.id, validatedData.messageId))
      .limit(1)

    if (!message) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    if (message.sentByUserId !== currentUser.id) {
      throw new HTTPException(403, {
        message: "You can only delete your own messages",
      })
    }

    if (message.deletedAt) {
      throw new HTTPException(400, { message: "Message already deleted" })
    }

    // Soft delete the message
    await db
      .update(directMessages)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(directMessages.id, validatedData.messageId))

    Logger.info({
      msg: "DM deleted",
      messageId: validatedData.messageId,
      userId: currentUser.externalId,
    })

    // Get recipient info for real-time notification
    const [recipient] = await db
      .select({
        id: users.id,
        externalId: users.externalId,
      })
      .from(users)
      .where(eq(users.id, message.sentToUserId))
      .limit(1)

    // Send real-time notification to the recipient
    if (recipient) {
      realtimeMessagingService.sendDirectMessageDelete(
        recipient.externalId,
        validatedData.messageId,
      )
    }

    return c.json({
      success: true,
      message: "Message deleted successfully",
    })
  } catch (error) {
    Logger.error(error, "Error deleting message")
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(500, { message: "Failed to delete message" })
  }
}
