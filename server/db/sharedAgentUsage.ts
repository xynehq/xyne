import { createId } from "@paralleldrive/cuid2"
import {
  agents,
  chats,
  messages,
  users,
  selectAgentSchema,
  selectMessageSchema,
  type SelectAgent,
  type SelectMessage,
} from "@/db/schema"
import { MessageRole, type TxnOrClient } from "@/types"
import {
  and,
  asc,
  eq,
  lt,
  count,
  inArray,
  isNull,
  desc,
  gte,
  lte,
  sql,
} from "drizzle-orm"
import { z } from "zod"

export interface SharedAgentUsageData {
  agentId: string
  agentName: string
  agentDescription?: string | null
  totalChats: number
  totalMessages: number
  likes: number
  dislikes: number
  userUsage: AgentUserUsage[]
}

export interface AgentUserUsage {
  userId: number
  userEmail: string
  userName: string
  chatCount: number
  messageCount: number
  likes: number
  dislikes: number
  lastUsed: string
}

export interface UserAgentLeaderboard {
  agentId: string
  agentName: string
  agentDescription?: string | null
  chatCount: number
  messageCount: number
  likes: number
  dislikes: number
  lastUsed: string
  rank: number
}

/**
 * Get public agents created by the user (for shared agent usage analysis)
 */
export async function getPublicAgentsByUser({
  db,
  userId,
  workspaceId,
  email,
  workspaceExternalId,
}: {
  db: TxnOrClient
  userId: number
  workspaceId: number
  email: string
  workspaceExternalId: string
}): Promise<SelectAgent[]> {
  const result = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.userId, userId),
        eq(agents.workspaceId, workspaceId),
        eq(agents.isPublic, true),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(desc(agents.updatedAt))

  return z.array(selectAgentSchema).parse(result)
}

/**
 * Get chat counts by agent across all users
 */
export async function getChatCountsByAgents({
  db,
  agentExternalIds,
  workspaceExternalId,
  timeRange,
}: {
  db: TxnOrClient
  agentExternalIds: string[]
  workspaceExternalId: string
  timeRange?: { from: string; to: string }
}): Promise<Record<string, number>> {
  const conditions = [
    inArray(chats.agentId, agentExternalIds),
    isNull(chats.deletedAt),
  ]

  if (timeRange?.from) {
    conditions.push(gte(chats.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    conditions.push(lte(chats.createdAt, new Date(timeRange.to)))
  }

  const result = await db
    .select({
      agentId: chats.agentId,
      count: count(chats.id),
    })
    .from(chats)
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(...conditions, eq(users.workspaceExternalId, workspaceExternalId)),
    )
    .groupBy(chats.agentId)

  const chatCounts: Record<string, number> = {}
  for (const row of result) {
    if (row.agentId) {
      chatCounts[row.agentId] = row.count
    }
  }

  return chatCounts
}

/**
 * Get message counts by agent across all users
 */
export async function getMessageCountsByAgents({
  db,
  agentExternalIds,
  workspaceExternalId,
  timeRange,
}: {
  db: TxnOrClient
  agentExternalIds: string[]
  workspaceExternalId: string
  timeRange?: { from: string; to: string }
}): Promise<Record<string, number>> {
  const conditions = [
    inArray(chats.agentId, agentExternalIds),
    isNull(chats.deletedAt),
    isNull(messages.deletedAt),
  ]

  if (timeRange?.from) {
    conditions.push(gte(messages.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    conditions.push(lte(messages.createdAt, new Date(timeRange.to)))
  }

  const result = await db
    .select({
      agentId: chats.agentId,
      count: count(messages.id),
    })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(...conditions, eq(users.workspaceExternalId, workspaceExternalId)),
    )
    .groupBy(chats.agentId)

  const messageCounts: Record<string, number> = {}
  for (const row of result) {
    if (row.agentId) {
      messageCounts[row.agentId] = row.count
    }
  }

  return messageCounts
}

/**
 * Get feedback statistics by agent across all users
 */
export async function getFeedbackStatsByAgents({
  db,
  agentExternalIds,
  workspaceExternalId,
  timeRange,
}: {
  db: TxnOrClient
  agentExternalIds: string[]
  workspaceExternalId: string
  timeRange?: { from: string; to: string }
}): Promise<Record<string, { likes: number; dislikes: number }>> {
  const conditions = [
    inArray(chats.agentId, agentExternalIds),
    isNull(chats.deletedAt),
    isNull(messages.deletedAt),
  ]

  if (timeRange?.from) {
    conditions.push(gte(messages.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    conditions.push(lte(messages.createdAt, new Date(timeRange.to)))
  }

  const result = await db
    .select({
      agentId: chats.agentId,
      likes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'like' THEN 1 ELSE 0 END)`,
      dislikes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'dislike' THEN 1 ELSE 0 END)`,
    })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(...conditions, eq(users.workspaceExternalId, workspaceExternalId)),
    )
    .groupBy(chats.agentId)

  const feedbackStats: Record<string, { likes: number; dislikes: number }> = {}
  for (const row of result) {
    if (row.agentId) {
      feedbackStats[row.agentId] = {
        likes: Number(row.likes) || 0,
        dislikes: Number(row.dislikes) || 0,
      }
    }
  }

  return feedbackStats
}

/**
 * Get detailed usage by users for specific agents
 */
export async function getAgentUsageByUsers({
  db,
  agentExternalIds,
  workspaceExternalId,
  timeRange,
}: {
  db: TxnOrClient
  agentExternalIds: string[]
  workspaceExternalId: string
  timeRange?: { from: string; to: string }
}): Promise<Record<string, AgentUserUsage[]>> {
  const conditions = [
    inArray(chats.agentId, agentExternalIds),
    isNull(chats.deletedAt),
  ]

  if (timeRange?.from) {
    conditions.push(gte(chats.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    conditions.push(lte(chats.createdAt, new Date(timeRange.to)))
  }

  const chatStats = await db
    .select({
      agentId: chats.agentId,
      userId: users.id,
      userEmail: users.email,
      userName: users.name,
      chatCount: count(chats.id),
      lastUsed: sql<string>`MAX(${chats.createdAt})`,
    })
    .from(chats)
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(...conditions, eq(users.workspaceExternalId, workspaceExternalId)),
    )
    .groupBy(chats.agentId, users.id, users.email, users.name)

  const messageConditions = [
    inArray(chats.agentId, agentExternalIds),
    isNull(chats.deletedAt),
    isNull(messages.deletedAt),
  ]

  if (timeRange?.from) {
    messageConditions.push(gte(messages.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    messageConditions.push(lte(messages.createdAt, new Date(timeRange.to)))
  }

  const messageStats = await db
    .select({
      agentId: chats.agentId,
      userId: users.id,
      messageCount: count(messages.id),
      likes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'like' THEN 1 ELSE 0 END)`,
      dislikes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'dislike' THEN 1 ELSE 0 END)`,
    })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(
        ...messageConditions,
        eq(users.workspaceExternalId, workspaceExternalId),
      ),
    )
    .groupBy(chats.agentId, users.id)

  const messageStatsMap = new Map<string, (typeof messageStats)[0]>()
  for (const stat of messageStats) {
    const key = `${stat.agentId}-${stat.userId}`
    messageStatsMap.set(key, stat)
  }

  const userUsageByAgent: Record<string, AgentUserUsage[]> = {}

  for (const chatStat of chatStats) {
    if (!chatStat.agentId) continue

    const key = `${chatStat.agentId}-${chatStat.userId}`
    const messageStat = messageStatsMap.get(key)

    if (!userUsageByAgent[chatStat.agentId]) {
      userUsageByAgent[chatStat.agentId] = []
    }

    userUsageByAgent[chatStat.agentId].push({
      userId: chatStat.userId,
      userEmail: chatStat.userEmail,
      userName: chatStat.userName || "Unknown User",
      chatCount: chatStat.chatCount,
      messageCount: messageStat?.messageCount || 0,
      likes: Number(messageStat?.likes) || 0,
      dislikes: Number(messageStat?.dislikes) || 0,
      lastUsed: chatStat.lastUsed,
    })
  }

  for (const agentId in userUsageByAgent) {
    userUsageByAgent[agentId].sort((a, b) => b.messageCount - a.messageCount)
  }

  return userUsageByAgent
}

/**
 * Get agent leaderboard for a specific user showing how much they've used each agent
 */
export async function getUserAgentLeaderboard({
  db,
  userId,
  workspaceExternalId,
  timeRange,
}: {
  db: TxnOrClient
  userId: number
  workspaceExternalId: string
  timeRange?: { from: string; to: string }
}): Promise<UserAgentLeaderboard[]> {
  const conditions = [
    eq(chats.userId, userId),
    isNull(chats.deletedAt),
    isNull(agents.deletedAt),
  ]

  if (timeRange?.from) {
    conditions.push(gte(chats.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    conditions.push(lte(chats.createdAt, new Date(timeRange.to)))
  }

  // Get chat statistics per agent for the user
  const chatStats = await db
    .select({
      agentId: agents.externalId,
      agentName: agents.name,
      agentDescription: agents.description,
      chatCount: count(chats.id),
      lastUsed: sql<string>`MAX(${chats.createdAt})`,
    })
    .from(chats)
    .innerJoin(agents, eq(chats.agentId, agents.externalId))
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(...conditions, eq(users.workspaceExternalId, workspaceExternalId)),
    )
    .groupBy(agents.externalId, agents.name, agents.description)

  const messageConditions = [
    eq(chats.userId, userId),
    isNull(chats.deletedAt),
    isNull(messages.deletedAt),
    isNull(agents.deletedAt),
  ]

  if (timeRange?.from) {
    messageConditions.push(gte(messages.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    messageConditions.push(lte(messages.createdAt, new Date(timeRange.to)))
  }

  // Get message statistics and feedback per agent for the user
  const messageStats = await db
    .select({
      agentId: agents.externalId,
      messageCount: count(messages.id),
      likes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'like' THEN 1 ELSE 0 END)`,
      dislikes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'dislike' THEN 1 ELSE 0 END)`,
    })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .innerJoin(agents, eq(chats.agentId, agents.externalId))
    .innerJoin(users, eq(chats.userId, users.id))
    .where(
      and(
        ...messageConditions,
        eq(users.workspaceExternalId, workspaceExternalId),
      ),
    )
    .groupBy(agents.externalId)

  // Create a map for quick lookup of message stats
  const messageStatsMap = new Map<string, (typeof messageStats)[0]>()
  for (const stat of messageStats) {
    messageStatsMap.set(stat.agentId, stat)
  }

  // Combine chat and message statistics
  const leaderboard: UserAgentLeaderboard[] = chatStats.map((chatStat) => {
    const messageStat = messageStatsMap.get(chatStat.agentId)

    return {
      agentId: chatStat.agentId,
      agentName: chatStat.agentName,
      agentDescription: chatStat.agentDescription,
      chatCount: chatStat.chatCount,
      messageCount: messageStat?.messageCount || 0,
      likes: Number(messageStat?.likes) || 0,
      dislikes: Number(messageStat?.dislikes) || 0,
      lastUsed: chatStat.lastUsed,
      rank: 0, // Will be set after sorting
    }
  })

  // Sort by message count (primary) and then by chat count (secondary)
  leaderboard.sort((a, b) => {
    if (b.messageCount !== a.messageCount) {
      return b.messageCount - a.messageCount
    }
    return b.chatCount - a.chatCount
  })

  // Assign ranks
  leaderboard.forEach((item, index) => {
    item.rank = index + 1
  })

  return leaderboard
}

export interface AgentAnalysisData {
  agentId: string
  agentName: string
  agentDescription?: string | null
  totalUsers: number
  totalChats: number
  totalMessages: number
  likes: number
  dislikes: number
  createdAt: string
  userLeaderboard: AgentUserLeaderboard[]
}

export interface AgentUserLeaderboard {
  userId: number
  userEmail: string
  userName: string
  chatCount: number
  messageCount: number
  likes: number
  dislikes: number
  lastUsed: string
  rank: number
}

/**
 * Get agent analysis data showing agent stats and user leaderboard who have used it
 */
export async function getAgentAnalysis({
  db,
  agentId,
  workspaceExternalId,
  timeRange,
}: {
  db: TxnOrClient
  agentId: string
  workspaceExternalId?: string // Optional for admin cross-workspace view
  timeRange?: { from: string; to: string }
}): Promise<AgentAnalysisData | null> {
  // First get agent information
  const agentInfo = await db
    .select({
      agentId: agents.externalId,
      agentName: agents.name,
      agentDescription: agents.description,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(
      and(eq(agents.externalId, agentId), sql`${agents.deletedAt} IS NULL`),
    )
    .limit(1)

  if (agentInfo.length === 0) {
    return null
  }

  const agent = agentInfo[0]

  const conditions = [eq(chats.agentId, agentId), isNull(chats.deletedAt)]

  if (timeRange?.from) {
    conditions.push(gte(chats.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    conditions.push(lte(chats.createdAt, new Date(timeRange.to)))
  }

  // Get user statistics for this agent
  const userStatsConditions = [...conditions]
  if (workspaceExternalId) {
    userStatsConditions.push(eq(users.workspaceExternalId, workspaceExternalId))
  }

  const userStats = await db
    .select({
      userId: users.id,
      userEmail: users.email,
      userName: users.name,
      chatCount: count(chats.id),
      lastUsed: sql<string>`MAX(${chats.createdAt})`,
    })
    .from(chats)
    .innerJoin(users, eq(chats.userId, users.id))
    .where(and(...userStatsConditions))
    .groupBy(users.id, users.email, users.name)

  const messageConditions = [
    eq(chats.agentId, agentId),
    isNull(chats.deletedAt),
    isNull(messages.deletedAt),
  ]

  if (timeRange?.from) {
    messageConditions.push(gte(messages.createdAt, new Date(timeRange.from)))
  }
  if (timeRange?.to) {
    messageConditions.push(lte(messages.createdAt, new Date(timeRange.to)))
  }

  // Get message statistics and feedback for this agent
  const messageStatsConditions = [...messageConditions]
  if (workspaceExternalId) {
    messageStatsConditions.push(
      eq(users.workspaceExternalId, workspaceExternalId),
    )
  }

  const messageStats = await db
    .select({
      userId: users.id,
      messageCount: count(messages.id),
      likes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'like' THEN 1 ELSE 0 END)`,
      dislikes: sql<number>`SUM(CASE WHEN ${messages.feedback} = 'dislike' THEN 1 ELSE 0 END)`,
    })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .innerJoin(users, eq(chats.userId, users.id))
    .where(and(...messageStatsConditions))
    .groupBy(users.id)

  // Create a map for quick lookup of message stats
  const messageStatsMap = new Map<number, (typeof messageStats)[0]>()
  for (const stat of messageStats) {
    messageStatsMap.set(stat.userId, stat)
  }

  // Combine user and message statistics
  const userLeaderboard: AgentUserLeaderboard[] = userStats.map((userStat) => {
    const messageStat = messageStatsMap.get(userStat.userId)

    return {
      userId: userStat.userId,
      userEmail: userStat.userEmail,
      userName: userStat.userName || "Unknown User",
      chatCount: userStat.chatCount,
      messageCount: messageStat?.messageCount || 0,
      likes: Number(messageStat?.likes) || 0,
      dislikes: Number(messageStat?.dislikes) || 0,
      lastUsed: userStat.lastUsed,
      rank: 0, // Will be set after sorting
    }
  })

  // Sort by message count (primary) and then by chat count (secondary)
  userLeaderboard.sort((a, b) => {
    if (b.messageCount !== a.messageCount) {
      return b.messageCount - a.messageCount
    }
    return b.chatCount - a.chatCount
  })

  // Assign ranks
  userLeaderboard.forEach((item, index) => {
    item.rank = index + 1
  })

  // Calculate totals
  const totalUsers = userLeaderboard.length
  const totalChats = userLeaderboard.reduce(
    (sum, user) => sum + user.chatCount,
    0,
  )
  const totalMessages = userLeaderboard.reduce(
    (sum, user) => sum + user.messageCount,
    0,
  )
  const totalLikes = userLeaderboard.reduce((sum, user) => sum + user.likes, 0)
  const totalDislikes = userLeaderboard.reduce(
    (sum, user) => sum + user.dislikes,
    0,
  )

  return {
    agentId: agent.agentId,
    agentName: agent.agentName,
    agentDescription: agent.agentDescription,
    totalUsers,
    totalChats,
    totalMessages,
    likes: totalLikes,
    dislikes: totalDislikes,
    createdAt: agent.createdAt.toISOString(),
    userLeaderboard,
  }
}
