import { createId } from "@paralleldrive/cuid2"
import {
  messages,
  chats,
  users,
  agents,
  selectMessageSchema,
  type InsertMessage,
  type SelectMessage,
} from "@/db/schema"
import { MessageRole, type TxnOrClient } from "@/types"
import {
  and,
  asc,
  eq,
  lt,
  gte,
  lte,
  count,
  inArray,
  sql,
  desc,
  isNull,
} from "drizzle-orm"
import { z } from "zod"

export const insertMessage = async (
  trx: TxnOrClient,
  message: Omit<InsertMessage, "externalId">,
): Promise<SelectMessage> => {
  const messageWithExternalId = {
    ...message,
    externalId: createId(),
  }
  const messageArr = await trx
    .insert(messages)
    .values(messageWithExternalId)
    .returning()
  if (!messageArr || !messageArr.length) {
    throw new Error('Error in insert of message "returning"')
  }
  const parsedData = selectMessageSchema.safeParse(messageArr[0])
  if (!parsedData.success) {
    throw new Error(
      `Could not get message after inserting: ${parsedData.error.toString()}`,
    )
  }
  return parsedData.data
}

export const getChatMessagesWithAuth = async (
  trx: TxnOrClient,
  chatId: string,
  email: string,
): Promise<SelectMessage[]> => {
  const messagesArr = await trx
    .select()
    .from(messages)
    .where(and(eq(messages.chatExternalId, chatId), eq(messages.email, email)))
    .orderBy(asc(messages.createdAt))
  return z.array(selectMessageSchema).parse(messagesArr)
}

export const getChatMessagesBefore = async (
  trx: TxnOrClient,
  chatId: number,
  createdAt: Date,
): Promise<SelectMessage[]> => {
  const messagesArr = await trx
    .select()
    .from(messages)
    .where(and(lt(messages.createdAt, createdAt), eq(messages.chatId, chatId)))
    .orderBy(asc(messages.createdAt))
  return z.array(selectMessageSchema).parse(messagesArr)
}

export const getMessageByExternalId = async (
  trx: TxnOrClient,
  messageId: string,
): Promise<SelectMessage> => {
  const messageArr = await trx
    .select()
    .from(messages)
    .where(eq(messages.externalId, messageId))
  if (!messageArr || !messageArr.length) {
    throw new Error("Chat not found")
  }
  return selectMessageSchema.parse(messageArr[0])
}

export const updateMessage = async (
  trx: TxnOrClient,
  messageId: string,
  updatedFields: Partial<InsertMessage>,
): Promise<void> => {
  await trx
    .update(messages)
    .set(updatedFields)
    .where(and(eq(messages.externalId, messageId)))
}

export async function getAllMessages({
  db,
  externalChatId,
}: {
  db: TxnOrClient
  externalChatId: string
}): Promise<SelectMessage[]> {
  const result = await db
    .select()
    .from(messages)
    .where(eq(messages.chatExternalId, externalChatId))
    .orderBy(asc(messages.createdAt))

  return selectMessageSchema.array().parse(result)
}

export async function getMessageCountsByChats({
  db,
  chatExternalIds,
}: {
  db: TxnOrClient
  chatExternalIds: string[]
}): Promise<
  Record<
    string,
    { messageCount: number; totalCost: number; totalTokens: number }
  >
> {
  if (chatExternalIds.length === 0) {
    return {}
  }

  // Build a query to get message counts, cost, and tokens for each chat
  const result = await db
    .select({
      chatExternalId: chats.externalId,
      messageCount: count(messages.externalId),
      totalCost: sql<number>`COALESCE(SUM(${messages.cost}), 0)::numeric`,
      totalTokens: sql<number>`COALESCE(SUM(${messages.tokensUsed}), 0)::bigint`,
    })
    .from(chats)
    .leftJoin(
      messages,
      and(eq(chats.id, messages.chatId), isNull(messages.deletedAt)),
    )
    .where(inArray(chats.externalId, chatExternalIds))
    .groupBy(chats.externalId)

  // Convert to a map for easier lookup
  const countMap: Record<
    string,
    { messageCount: number; totalCost: number; totalTokens: number }
  > = {}
  for (const row of result) {
    countMap[row.chatExternalId] = {
      messageCount: row.messageCount,
      totalCost: Number(row.totalCost) || 0, // numeric → string at runtime
      totalTokens: Number(row.totalTokens) || 0, // bigint → string at runtime
    }
  }

  return countMap
}

export async function getMessageFeedbackStats({
  db,
  chatExternalIds,
  email,
  workspaceExternalId,
}: {
  db: TxnOrClient
  chatExternalIds: string[]
  email: string
  workspaceExternalId: string
}): Promise<{
  totalLikes: number
  totalDislikes: number
  totalCost: number
  totalTokens: number
  feedbackByChat: Record<
    string,
    { likes: number; dislikes: number; cost: number; tokens: number }
  >
  feedbackMessages: Array<{
    messageId: string
    chatExternalId: string
    type: "like" | "dislike"
    feedbackText: string[]
    timestamp: string
  }>
}> {
  if (chatExternalIds.length === 0) {
    return {
      totalLikes: 0,
      totalDislikes: 0,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      feedbackByChat: {},
      feedbackMessages: [],
    }
  }

  // Get aggregated feedback counts, cost, and tokens
  const result = await db
    .select({
      chatExternalId: messages.chatExternalId,
      likes: sql<number>`SUM(CASE WHEN ${messages.feedback}->>'type' = 'like' THEN 1 ELSE 0 END)::int`,
      dislikes: sql<number>`SUM(CASE WHEN ${messages.feedback}->>'type' = 'dislike' THEN 1 ELSE 0 END)::int`,
      totalCost: sql<number>`COALESCE(SUM(${messages.cost}), 0)::numeric`,
      totalTokens: sql<number>`COALESCE(SUM(${messages.tokensUsed}), 0)::bigint`,
      inputTokens: sql<number>`COALESCE(SUM(${messages.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`COALESCE(SUM(${messages.outputTokens}), 0)::bigint`,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.chatExternalId, chatExternalIds),
        eq(messages.email, email),
        eq(messages.workspaceExternalId, workspaceExternalId),
        isNull(messages.deletedAt),
      ),
    )
    .groupBy(messages.chatExternalId)

  // Get detailed feedback messages
  const feedbackMessages = await db
    .select({
      messageId: messages.externalId,
      chatExternalId: messages.chatExternalId,
      feedback: messages.feedback,
      updatedAt: messages.updatedAt,
    })
    .from(messages)
    .where(
      and(
        inArray(messages.chatExternalId, chatExternalIds),
        eq(messages.email, email),
        eq(messages.workspaceExternalId, workspaceExternalId),
        sql`${messages.feedback}->>'type' IN ('like', 'dislike')`,
      ),
    )
    .orderBy(desc(messages.updatedAt))

  let totalLikes = 0
  let totalDislikes = 0
  let totalCost = 0
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  const feedbackByChat: Record<
    string,
    { likes: number; dislikes: number; cost: number; tokens: number }
  > = {}

  // Initialize all chats with zero feedback, cost, and tokens
  chatExternalIds.forEach((chatId) => {
    feedbackByChat[chatId] = { likes: 0, dislikes: 0, cost: 0, tokens: 0 }
  })

  // Populate with actual feedback counts, cost, and tokens
  result.forEach((row) => {
    feedbackByChat[row.chatExternalId].likes = row.likes
    feedbackByChat[row.chatExternalId].dislikes = row.dislikes
    feedbackByChat[row.chatExternalId].cost = Number(row.totalCost) || 0 // numeric → string at runtime
    feedbackByChat[row.chatExternalId].tokens = Number(row.totalTokens) || 0 // bigint → string at runtime
    totalLikes += row.likes
    totalDislikes += row.dislikes
    totalCost += Number(row.totalCost) || 0 // numeric → string at runtime
    totalTokens += Number(row.totalTokens) || 0 // bigint → string at runtime
    inputTokens += Number(row.inputTokens) || 0 // bigint → string at runtime
    outputTokens += Number(row.outputTokens) || 0 // bigint → string at runtime
  })

  // Process detailed feedback messages
  const processedFeedbackMessages = feedbackMessages.map((msg) => {
    const feedbackData = msg.feedback as any
    return {
      messageId: msg.messageId,
      chatExternalId: msg.chatExternalId,
      type: (feedbackData?.type || "like") as "like" | "dislike",
      feedbackText: Array.isArray(feedbackData?.feedback)
        ? feedbackData.feedback.filter((text: string) => text && text.trim())
        : [""],
      timestamp: msg.updatedAt?.toISOString() || new Date().toISOString(),
    }
  })

  return {
    totalLikes,
    totalDislikes,
    totalCost,
    totalTokens,
    inputTokens,
    outputTokens,
    feedbackByChat,
    feedbackMessages: processedFeedbackMessages,
  }
}

export const getMessagesWithAttachmentsByChatId = async (
  trx: TxnOrClient,
  chatExternalId: string,
  limit: number,
  offset: number,
): Promise<
  Array<{
    id: number
    externalId: string
    attachments: unknown
    sources: unknown
    email: string
  }>
> => {
  const chatMessages = await trx
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
        eq(messages.chatExternalId, chatExternalId),
        isNull(messages.deletedAt),
      ),
    )
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit)
    .offset(offset)
  return chatMessages
}

export const updateMessageAttachmentsAndSources = async (
  trx: TxnOrClient,
  messageExternalId: string,
  email: string,
  updatedSources: unknown[],
): Promise<void> => {
  await trx
    .update(messages)
    .set({
      attachments: [],
      sources: updatedSources,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(messages.externalId, messageExternalId),
        eq(messages.email, email),
      ),
    )
}

export const fetchUserQueriesForChat = async (
  trx: TxnOrClient,
  chatExternalId: string,
  workspaceExternalId?: string,
): Promise<string[]> => {
  const conditions = [
    eq(messages.chatExternalId, chatExternalId),
    eq(messages.messageRole, MessageRole.User),
    isNull(messages.deletedAt),
  ]

  // Add workspace validation if workspaceExternalId is provided
  if (workspaceExternalId) {
    conditions.push(eq(messages.workspaceExternalId, workspaceExternalId))
  }

  const queries = await trx
    .select({
      content: messages.message,
    })
    .from(messages)
    .where(and(...conditions))
    .orderBy(asc(messages.createdAt))
  return queries.map((q) => q.content)
}

export const parseValidDate = (value?: string): Date | null => {
  if (!value) return null;

  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
};

export type AgentQueryResponsePair = {
  chatId: string
    chatTitle: string
    chatCreatedAt: string
    userEmail: string
    userName: string
    totalCost: number
    totalTokens: number
    messageCount: number
    totalLikes: number
    totalDislikes: number
    messages: {
      messageId: string
      queryText: string
      responseText: string
      createdAt: string
      cost: number
      tokensUsed: number
      feedback: unknown | null
    }[]
}

export const fetchAgentQueryResponsePairs = async (
  trx: TxnOrClient,
  agentExternalId: string,
  workspaceExternalId?: string,
  fromDate?: string,
  toDate?: string,
): Promise<
  AgentQueryResponsePair []
> => {
  const conditions = [
    eq(chats.agentId, agentExternalId),
    isNull(messages.deletedAt),
    isNull(chats.deletedAt),
    eq(agents.isPublic, true), // Only fetch data for public agents
  ]

  // Add workspace validation if workspaceExternalId is provided
  if (workspaceExternalId) {
    conditions.push(eq(chats.workspaceExternalId, workspaceExternalId))
  }

  // Add date range filtering - default to last 1 month if not provided
  const now = new Date()
  const defaultFromDate = new Date()
  defaultFromDate.setMonth(defaultFromDate.getMonth() - 1)
  const parsedFrom = parseValidDate(fromDate);
  const parsedTo = parseValidDate(toDate);
  const from = parsedFrom ?? defaultFromDate;
  const to = parsedTo ?? now;


  conditions.push(gte(messages.createdAt, from))
  conditions.push(lte(messages.createdAt, to))

  // Get all messages for the agent, ordered by creation time (newest first)
  const allMessages = await trx
    .select({
      chatId: messages.chatExternalId,
      chatTitle: chats.title,
      chatCreatedAt: chats.createdAt,
      messageId: messages.externalId,
      messageRole: messages.messageRole,
      message: messages.message,
      createdAt: messages.createdAt,
      userEmail: messages.email,
      userName: users.name,
      cost: messages.cost,
      tokensUsed: messages.tokensUsed,
      feedback: messages.feedback,
    })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .innerJoin(agents, eq(chats.agentId, agents.externalId))
    .innerJoin(users, eq(messages.email, users.email))
    .where(and(...conditions))
    .orderBy(desc(chats.createdAt), desc(messages.createdAt))


  // Group messages by chat and pair user queries with assistant responses
  const chatMap = new Map<string, {
    chatId: string
    chatTitle: string
    chatCreatedAt: string
    userEmail: string
    userName: string
    messages: {
      messageId: string
      queryText: string
      responseText: string
      createdAt: string
      cost: number
      tokensUsed: number
      feedback: unknown | null
    }[]
    totalCost: number
    totalTokens: number
    totalLikes: number
    totalDislikes: number
  }>()

  // First pass: pair messages
  for (let i = 0; i < allMessages.length - 1; i++) {
    const currentMsg = allMessages[i]
    const nextMsg = allMessages[i + 1]

    // Check if current is assistant message and next is user message in same chat
    if (
      currentMsg.messageRole === MessageRole.Assistant &&
      nextMsg.messageRole === MessageRole.User &&
      currentMsg.chatId === nextMsg.chatId
    ) {
      if (!chatMap.has(currentMsg.chatId)) {
        chatMap.set(currentMsg.chatId, {
          chatId: currentMsg.chatId,
          chatTitle: currentMsg.chatTitle || "Untitled Chat",
          chatCreatedAt: currentMsg.chatCreatedAt.toISOString(),
          userEmail: nextMsg.userEmail,
          userName: nextMsg.userName || "Unknown User",
          messages: [],
          totalCost: 0,
          totalTokens: 0,
          totalLikes: 0,
          totalDislikes: 0,
        })
      }

      const chat = chatMap.get(currentMsg.chatId)!
      const cost = Number(currentMsg.cost) || 0
      const tokens = Number(currentMsg.tokensUsed) || 0

      // Count likes and dislikes
      if (currentMsg.feedback && typeof currentMsg.feedback === 'object') {
        const feedbackObj = currentMsg.feedback as { type?: string }
        if (feedbackObj.type === 'like') {
          chat.totalLikes++
        } else if (feedbackObj.type === 'dislike') {
          chat.totalDislikes++
        }
      }

      chat.messages.push({
        messageId: nextMsg.messageId,
        queryText: nextMsg.message,
        responseText: currentMsg.message,
        createdAt: nextMsg.createdAt.toISOString(),
        cost,
        tokensUsed: tokens,
        feedback: currentMsg.feedback || null, // Feedback is from assistant message
      })

      chat.totalCost += cost
      chat.totalTokens += tokens
    }
  }

  // Convert map to array and sort by latest message timestamp (newest first)
  return Array.from(chatMap.values())
    .map(chat => ({
      ...chat,
      messageCount: chat.messages.length,
      // Get the latest message timestamp for sorting
      latestMessageTime: chat.messages.length > 0
        ? Math.max(...chat.messages.map(m => new Date(m.createdAt).getTime()))
        : new Date(chat.chatCreatedAt).getTime()
    }))
    .sort((a, b) => b.latestMessageTime - a.latestMessageTime)
    .map(({ latestMessageTime, ...chat }) => chat) // Remove latestMessageTime from final result
}
