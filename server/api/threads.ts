import type { Context } from "hono"
import { db } from "@/db/client"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import config from "@/config"
import {
  threads,
  threadReplies,
  channelMessages,
  directMessages,
  lexicalEditorStateSchema,
  insertThreadReplySchema,
} from "@/db/schema"
import { users } from "@/db/schema/users"
import { channelMembers } from "@/db/schema/channels"
import { eq, and, desc, sql } from "drizzle-orm"
import { getUserByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { realtimeMessagingService } from "@/services/callNotifications"

const { JwtPayloadKey } = config
const Logger = getLogger(Subsystem.Api).child({ module: "threads" })

// ==================== Validation Schemas ====================

// Query params for GET thread
export const getThreadSchema = z.object({
  messageType: z.enum(["channel", "direct"]),
})

// Body for POST reply
export const sendThreadReplySchema = z.object({
  messageType: z.enum(["channel", "direct"]),
  messageContent: lexicalEditorStateSchema,
})

export const updateThreadReplySchema = z.object({
  messageContent: lexicalEditorStateSchema,
})

export const deleteThreadReplySchema = z.object({
  replyId: z.coerce.number().int().positive(),
})

// ==================== Helper Functions ====================

/**
 * Verify that a message exists and user has access to it
 */
async function verifyMessageAccess(
  messageId: number,
  messageType: "channel" | "direct",
  userId: number,
): Promise<{ channelId?: number; workspaceId?: number }> {
  if (messageType === "channel") {
    // Check if the message exists and user is a member of the channel
    const message = await db
      .select({
        channelId: channelMessages.channelId,
      })
      .from(channelMessages)
      .where(eq(channelMessages.id, messageId))
      .limit(1)

    if (!message.length) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    // Verify user is a member of the channel
    const membership = await db.query.channelMembers.findFirst({
      where: (channelMembers, { eq, and }) =>
        and(
          eq(channelMembers.channelId, message[0].channelId),
          eq(channelMembers.userId, userId),
        ),
    })

    if (!membership) {
      throw new HTTPException(403, {
        message: "You do not have access to this channel",
      })
    }

    return { channelId: message[0].channelId }
  } else {
    // For direct messages, check if user is sender or receiver
    const message = await db
      .select()
      .from(directMessages)
      .where(eq(directMessages.id, messageId))
      .limit(1)

    if (!message.length) {
      Logger.warn({ messageId, messageType }, "Direct message not found")
      throw new HTTPException(404, { message: "Message not found" })
    }

    Logger.debug(
      {
        messageId,
        sentByUserId: message[0].sentByUserId,
        sentToUserId: message[0].sentToUserId,
        currentUserId: userId,
      },
      "Verifying DM access",
    )

    if (
      message[0].sentByUserId !== userId &&
      message[0].sentToUserId !== userId
    ) {
      Logger.warn(
        {
          messageId,
          userId,
          sentBy: message[0].sentByUserId,
          sentTo: message[0].sentToUserId,
        },
        "User does not have access to this DM",
      )
      throw new HTTPException(403, {
        message: "You do not have access to this message",
      })
    }

    return {}
  }
}

/**
 * Get or create a thread for a message
 */
async function getOrCreateThread(
  messageId: number,
  messageType: "channel" | "direct",
  channelId?: number,
): Promise<number> {
  // Check if thread already exists
  const existingThread = await db.query.threads.findFirst({
    where: (threads, { eq, and }) =>
      and(
        eq(threads.parentMessageId, messageId),
        eq(threads.messageType, messageType),
      ),
  })

  if (existingThread) {
    return existingThread.id
  }

  // Create new thread
  const [newThread] = await db
    .insert(threads)
    .values({
      parentMessageId: messageId,
      messageType,
      channelId,
    })
    .returning()

  return newThread.id
}

// ==================== API Handlers ====================

/**
 * Get thread and all replies for a message
 * GET /api/threads/:messageId?messageType=channel|direct
 */
export async function getThread(c: Context) {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)

    // Get current user from email
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]
    const userId = currentUser.id

    // Get messageId from path param
    const messageIdParam = c.req.param("messageId")
    const messageId = Number(messageIdParam)

    // Get query param
    const messageTypeParam = c.req.query("messageType")

    Logger.info(
      {
        messageIdParam,
        messageId,
        messageTypeParam,
        userId,
        userEmail,
        isNaN: isNaN(messageId),
      },
      "getThread request received",
    )

    if (isNaN(messageId)) {
      throw new HTTPException(400, { message: "Invalid messageId" })
    }

    // Validate query params
    const { messageType } = getThreadSchema.parse({
      messageType: messageTypeParam,
    })

    Logger.info({ messageId, messageType, userId }, "Getting thread")

    // Verify access to the message
    const access = await verifyMessageAccess(messageId, messageType, userId)

    // Get thread
    const thread = await db.query.threads.findFirst({
      where: (threads, { eq, and }) =>
        and(
          eq(threads.parentMessageId, messageId),
          eq(threads.messageType, messageType),
        ),
    })

    if (!thread) {
      // No thread exists yet, return empty
      return c.json({
        thread: null,
        replies: [],
      })
    }

    // Get all replies with sender information
    const replies = await db
      .select({
        id: threadReplies.id,
        threadId: threadReplies.threadId,
        senderId: threadReplies.senderId,
        messageContent: threadReplies.messageContent,
        isEdited: threadReplies.isEdited,
        createdAt: threadReplies.createdAt,
        updatedAt: threadReplies.updatedAt,
        sender: {
          id: users.id,
          externalId: users.externalId,
          name: users.name,
          email: users.email,
          photoLink: users.photoLink,
        },
      })
      .from(threadReplies)
      .innerJoin(users, eq(threadReplies.senderId, users.id))
      .where(
        and(
          eq(threadReplies.threadId, thread.id),
          sql`${threadReplies.deletedAt} IS NULL`,
        ),
      )
      .orderBy(threadReplies.createdAt)

    return c.json({
      thread: {
        id: thread.id,
        parentMessageId: thread.parentMessageId,
        messageType: thread.messageType,
        replyCount: thread.replyCount,
        lastReplyAt: thread.lastReplyAt,
        createdAt: thread.createdAt,
      },
      replies,
    })
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    // Check for Zod validation errors
    if (error && typeof error === "object" && "issues" in error) {
      Logger.error({ error }, "Validation error in getThread")
      throw new HTTPException(400, {
        message: "Invalid request parameters",
        cause: error,
      })
    }
    Logger.error({ error }, "Error getting thread")
    throw new HTTPException(500, { message: "Failed to get thread" })
  }
}

/**
 * Send a reply to a thread
 * POST /api/threads/:messageId/reply
 */
export async function sendThreadReply(c: Context) {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)

    // Get current user from email
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]
    const userId = currentUser.id

    // Get messageId from path param
    const messageId = Number(c.req.param("messageId"))

    // Validate body
    const body = await c.req.json()
    const { messageType, messageContent } = sendThreadReplySchema.parse({
      messageType: body.messageType,
      messageContent: body.messageContent,
    })

    Logger.info({ messageId, messageType, userId }, "Sending thread reply")

    // Verify access to the message
    const access = await verifyMessageAccess(messageId, messageType, userId)

    // Get or create thread
    const threadId = await getOrCreateThread(
      messageId,
      messageType,
      access.channelId,
    )

    // Insert reply
    const [reply] = await db
      .insert(threadReplies)
      .values({
        threadId,
        senderId: userId,
        messageContent,
      })
      .returning()

    // Update thread metadata
    await db
      .update(threads)
      .set({
        replyCount: sql`${threads.replyCount} + 1`,
        lastReplyAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(threads.id, threadId))

    // Get sender information for response
    const sender = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        externalId: true,
        name: true,
        email: true,
        photoLink: true,
      },
    })

    const replyWithSender = {
      ...reply,
      sender,
    }

    // Send real-time notification to channel members or DM participant
    if (messageType === "channel" && access.channelId) {
      // Get all channel members with their external IDs
      const members = await db
        .select({
          userId: channelMembers.userId,
          externalId: users.externalId,
        })
        .from(channelMembers)
        .innerJoin(users, eq(channelMembers.userId, users.id))
        .where(eq(channelMembers.channelId, access.channelId!))

      // Notify all members except sender
      for (const member of members) {
        if (member.userId !== userId) {
          realtimeMessagingService.sendThreadReply(member.externalId, {
            threadId,
            parentMessageId: messageId,
            messageType,
            reply: replyWithSender,
          })
        }
      }
    } else if (messageType === "direct") {
      // Get the other participant in the DM with their external ID
      const message = await db
        .select({
          sentByUserId: directMessages.sentByUserId,
          sentToUserId: directMessages.sentToUserId,
        })
        .from(directMessages)
        .where(eq(directMessages.id, messageId))
        .limit(1)

      if (message.length > 0) {
        const otherUserId =
          message[0].sentByUserId === userId
            ? message[0].sentToUserId
            : message[0].sentByUserId

        // Get the external ID of the other user
        const otherUser = await db.query.users.findFirst({
          where: eq(users.id, otherUserId),
          columns: { externalId: true },
        })

        if (otherUser) {
          realtimeMessagingService.sendThreadReply(otherUser.externalId, {
            threadId,
            parentMessageId: messageId,
            messageType,
            reply: replyWithSender,
          })
        }
      }
    }

    return c.json({
      success: true,
      reply: replyWithSender,
    })
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    Logger.error({ error }, "Error sending thread reply")
    throw new HTTPException(500, { message: "Failed to send thread reply" })
  }
}

/**
 * Update a thread reply
 * PATCH /api/threads/replies/:replyId
 */
export async function updateThreadReply(c: Context) {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)

    // Get current user from email
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]
    const userId = currentUser.id

    // Get replyId from path param
    const replyId = Number(c.req.param("replyId"))

    // Validate body
    const body = await c.req.json()
    const { messageContent } = updateThreadReplySchema.parse({
      messageContent: body.messageContent,
    })

    Logger.info({ replyId, userId }, "Updating thread reply")

    // Get the reply and verify ownership
    const reply = await db.query.threadReplies.findFirst({
      where: eq(threadReplies.id, replyId),
    })

    if (!reply) {
      throw new HTTPException(404, { message: "Reply not found" })
    }

    if (reply.senderId !== userId) {
      throw new HTTPException(403, {
        message: "You can only edit your own replies",
      })
    }

    // Update reply
    const [updatedReply] = await db
      .update(threadReplies)
      .set({
        messageContent,
        isEdited: true,
        updatedAt: new Date(),
      })
      .where(eq(threadReplies.id, replyId))
      .returning()

    return c.json({
      success: true,
      reply: updatedReply,
    })
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    Logger.error({ error }, "Error updating thread reply")
    throw new HTTPException(500, { message: "Failed to update thread reply" })
  }
}

/**
 * Delete a thread reply
 * DELETE /api/threads/replies/:replyId
 */
export async function deleteThreadReply(c: Context) {
  try {
    const { sub: userEmail } = c.get(JwtPayloadKey)

    // Get current user from email
    const currentUsers = await getUserByEmail(db, userEmail)
    if (!currentUsers || currentUsers.length === 0) {
      throw new HTTPException(404, { message: "User not found" })
    }
    const currentUser = currentUsers[0]
    const userId = currentUser.id

    // Get replyId from path param
    const replyId = Number(c.req.param("replyId"))

    Logger.info({ replyId, userId }, "Deleting thread reply")

    // Get the reply and verify ownership
    const reply = await db.query.threadReplies.findFirst({
      where: eq(threadReplies.id, replyId),
    })

    if (!reply) {
      throw new HTTPException(404, { message: "Reply not found" })
    }

    if (reply.senderId !== userId) {
      throw new HTTPException(403, {
        message: "You can only delete your own replies",
      })
    }

    // Soft delete the reply
    await db
      .update(threadReplies)
      .set({
        deletedAt: new Date(),
      })
      .where(eq(threadReplies.id, replyId))

    // Update thread reply count
    await db
      .update(threads)
      .set({
        replyCount: sql`${threads.replyCount} - 1`,
        updatedAt: new Date(),
      })
      .where(eq(threads.id, reply.threadId))

    return c.json({
      success: true,
      message: "Reply deleted successfully",
    })
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    Logger.error({ error }, "Error deleting thread reply")
    throw new HTTPException(500, { message: "Failed to delete thread reply" })
  }
}
