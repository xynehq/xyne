import type { Context } from "hono"
import { db } from "@/db/client"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import config from "@/config"
import { directMessages } from "@/db/schema/directMessages"
import { users } from "@/db/schema/users"
import { eq, and, or, desc, sql, asc } from "drizzle-orm"
import { getUserByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { realtimeMessagingService } from "@/services/callNotifications"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "directMessages" })

// Import Lexical schema
import { lexicalEditorStateSchema } from "@/db/schema/directMessages"

// Schemas
export const sendMessageSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  messageContent: lexicalEditorStateSchema,
})

export const getConversationSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
})

export const markAsReadSchema = z.object({
  targetUserId: z.string().min(1, "Target user ID is required"),
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
    const targetUserId = c.req.query("targetUserId")
    const limit = parseInt(c.req.query("limit") || "50")
    const offset = parseInt(c.req.query("offset") || "0")

    if (!workspaceId) {
      throw new HTTPException(400, { message: "Workspace ID is required" })
    }

    if (!targetUserId) {
      throw new HTTPException(400, { message: "Target user ID is required" })
    }

    // Validate input
    const validatedData = getConversationSchema.parse({
      targetUserId,
      limit,
      offset,
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

    // Get messages between the two users
    const messages = await db
      .select({
        id: directMessages.id,
        messageContent: directMessages.messageContent,
        isRead: directMessages.isRead,
        createdAt: directMessages.createdAt,
        sentByUserId: directMessages.sentByUserId,
        sentToUserId: directMessages.sentToUserId,
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
        ),
      )
      .orderBy(asc(directMessages.createdAt))
      .limit(validatedData.limit)
      .offset(validatedData.offset)

    return c.json({
      success: true,
      messages: messages.map((msg) => ({
        id: msg.id,
        messageContent: msg.messageContent,
        isRead: msg.isRead,
        createdAt: msg.createdAt,
        sentByUserId: msg.senderExternalId,
        isMine: msg.sentByUserId === currentUser.id,
        sender: {
          id: msg.senderExternalId,
          name: msg.senderName,
          email: msg.senderEmail,
          photoLink: msg.senderPhotoLink,
        },
      })),
      targetUser: {
        id: targetUser.externalId,
        name: targetUser.name,
        email: targetUser.email,
        photoLink: targetUser.photoLink,
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
