import type { Context } from "hono"
import { db } from "@/db/client"
import { sharedChats, chats, messages, users } from "@/db/schema"
import { and, eq, desc, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { nanoid } from "nanoid"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

// Schema for creating a shared chat
export const createSharedChatSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
})

// Schema for getting shared chat
export const getSharedChatSchema = z.object({
  token: z.string(),
})

// Schema for deleting shared chat
export const deleteSharedChatSchema = z.object({
  shareToken: z.string(),
})

// Schema for listing shared chats
export const listSharedChatsSchema = z.object({
  page: z.string().default("0").transform(Number),
  limit: z.string().default("20").transform(Number),
})

// Schema for checking existing share
export const checkSharedChatSchema = z.object({
  chatId: z.string(),
})

// Create a shared chat link
export const CreateSharedChatApi = async (c: Context) => {
  // @ts-ignore - Validation handled by middleware
  const body = c.req.valid("json")
  const { sub, workspaceId } = c.get("jwtPayload") ?? {}
  const email = sub || ""

  // Type assertion for validated body
  const { chatId, messageId } = body as z.infer<typeof createSharedChatSchema>

  try {
    // Get user info
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!user) {
      throw new HTTPException(404, { message: "User not found" })
    }

    // Get chat info
    const [chat] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.externalId, chatId), eq(chats.userId, user.id)))
      .limit(1)

    if (!chat) {
      throw new HTTPException(404, { message: "Chat not found" })
    }

    // Get message info
    const [message] = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.externalId, messageId), eq(messages.chatId, chat.id)),
      )
      .limit(1)

    if (!message) {
      throw new HTTPException(404, { message: "Message not found" })
    }

    // Check if share already exists for this chat+message combination
    const existingShare = await db
      .select()
      .from(sharedChats)
      .where(
        and(
          eq(sharedChats.chatId, chat.id),
          eq(sharedChats.messageId, message.id),
        ),
      )
      .limit(1)

    if (existingShare.length > 0) {
      // If it exists but is deleted, reactivate it
      if (existingShare[0].deletedAt) {
        await db
          .update(sharedChats)
          .set({
            deletedAt: null,
            updatedAt: new Date(),
          })
          .where(eq(sharedChats.id, existingShare[0].id))
      }

      return c.json({
        shareToken: existingShare[0].shareToken,
      })
    }

    // Generate unique share token
    const shareToken = nanoid(15)

    // Create shared chat
    const [sharedChat] = await db
      .insert(sharedChats)
      .values({
        chatId: chat.id,
        messageId: message.id,
        workspaceId: chat.workspaceId,
        userId: user.id,
        shareToken,
        title: chat.title,
      })
      .returning()

    return c.json({
      shareToken: sharedChat.shareToken,
    })
  } catch (error) {
    Logger.error(error, "Failed to create shared chat")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, { message: "Failed to create shared chat" })
  }
}

// Get shared chat by token (for viewing)
export const GetSharedChatApi = async (c: Context) => {
  // @ts-ignore - Validation handled by middleware
  const { token } = c.req.valid("query")

  try {
    // Get shared chat info (only active shares)
    const [sharedChat] = await db
      .select({
        sharedChat: sharedChats,
        chat: chats,
      })
      .from(sharedChats)
      .innerJoin(chats, eq(sharedChats.chatId, chats.id))
      .where(
        and(eq(sharedChats.shareToken, token), isNull(sharedChats.deletedAt)),
      )
      .limit(1)

    if (!sharedChat) {
      throw new HTTPException(404, {
        message: "Shared chat not found or has been deactivated",
      })
    }

    // Get messages up to the shared message
    const sharedMessages = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, sharedChat.chat.id),
          isNull(messages.deletedAt),
        ),
      )
      .orderBy(messages.createdAt)

    // Filter messages up to and including the shared message
    const messageIndex = sharedMessages.findIndex(
      (msg) => msg.id === sharedChat.sharedChat.messageId,
    )

    const messagesToShare =
      messageIndex >= 0 ? sharedMessages.slice(0, messageIndex + 1) : []

    return c.json({
      chat: {
        externalId: sharedChat.chat.externalId,
        title: sharedChat.sharedChat.title,
        createdAt: sharedChat.chat.createdAt,
      },
      messages: messagesToShare.map((msg) => ({
        externalId: msg.externalId,
        message: msg.message,
        messageRole: msg.messageRole,
        thinking: msg.thinking,
        modelId: msg.modelId,
        sources: msg.sources,
        fileIds: msg.fileIds,
        createdAt: msg.createdAt,
        errorMessage: msg.errorMessage,
        feedback: msg.feedback,
        attachments: msg.attachments,
      })),
      sharedAt: sharedChat.sharedChat.createdAt,
    })
  } catch (error) {
    Logger.error(error, "Failed to get shared chat")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, { message: "Failed to get shared chat" })
  }
}

// List all shared chats for a user
export const ListSharedChatsApi = async (c: Context) => {
  // @ts-ignore - Validation handled by middleware
  const { page, limit } = c.req.valid("query")
  const { sub } = c.get("jwtPayload") ?? {}
  const email = sub || ""

  try {
    // Get user info
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!user) {
      throw new HTTPException(404, { message: "User not found" })
    }

    // Get active shared chats
    const userSharedChats = await db
      .select({
        shareToken: sharedChats.shareToken,
        title: sharedChats.title,
        createdAt: sharedChats.createdAt,
        chatExternalId: chats.externalId,
        deletedAt: sharedChats.deletedAt,
      })
      .from(sharedChats)
      .innerJoin(chats, eq(sharedChats.chatId, chats.id))
      .where(
        and(eq(sharedChats.userId, user.id), isNull(sharedChats.deletedAt)),
      )
      .orderBy(desc(sharedChats.createdAt))
      .limit(limit)
      .offset(page * limit)

    return c.json({
      sharedChats: userSharedChats,
      page,
      limit,
    })
  } catch (error) {
    Logger.error(error, "Failed to list shared chats")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, { message: "Failed to list shared chats" })
  }
}

// Delete shared chat
export const DeleteSharedChatApi = async (c: Context) => {
  // @ts-ignore - Validation handled by middleware
  const body = c.req.valid("json")
  const { sub } = c.get("jwtPayload") ?? {}
  const email = sub || ""
  const { shareToken } = body

  try {
    // Get user info
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!user) {
      throw new HTTPException(404, { message: "User not found" })
    }

    // Soft delete shared chat
    const result = await db
      .update(sharedChats)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sharedChats.shareToken, shareToken),
          eq(sharedChats.userId, user.id),
          isNull(sharedChats.deletedAt), // Only delete if not already deleted
        ),
      )
      .returning()

    if (result.length === 0) {
      throw new HTTPException(404, {
        message: "Shared chat not found or already deleted",
      })
    }

    return c.json({ success: true })
  } catch (error) {
    Logger.error(error, "Failed to delete shared chat")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, { message: "Failed to delete shared chat" })
  }
}

// Check if a chat has an existing share
export const CheckSharedChatApi = async (c: Context) => {
  // @ts-ignore - Validation handled by middleware
  const { chatId } = c.req.valid("query")
  const { sub } = c.get("jwtPayload") ?? {}
  const email = sub || ""

  try {
    // Get user info
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!user) {
      throw new HTTPException(404, { message: "User not found" })
    }

    // Get chat info
    const [chat] = await db
      .select()
      .from(chats)
      .where(and(eq(chats.externalId, chatId), eq(chats.userId, user.id)))
      .limit(1)

    if (!chat) {
      throw new HTTPException(404, { message: "Chat not found" })
    }

    // Check for the most recent active share for this chat
    const [existingShare] = await db
      .select({
        shareToken: sharedChats.shareToken,
        title: sharedChats.title,
        createdAt: sharedChats.createdAt,
        chatExternalId: chats.externalId,
      })
      .from(sharedChats)
      .innerJoin(chats, eq(sharedChats.chatId, chats.id))
      .where(
        and(eq(sharedChats.chatId, chat.id), isNull(sharedChats.deletedAt)),
      )
      .orderBy(desc(sharedChats.createdAt))
      .limit(1)

    if (existingShare) {
      return c.json({
        exists: true,
        share: existingShare,
      })
    }

    return c.json({
      exists: false,
      share: null,
    })
  } catch (error) {
    Logger.error(error, "Failed to check shared chat")
    if (error instanceof HTTPException) throw error
    throw new HTTPException(500, { message: "Failed to check shared chat" })
  }
}
