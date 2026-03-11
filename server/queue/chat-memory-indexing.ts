import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss } from "./boss"

const logger = getLogger(Subsystem.Queue).child({
  module: "chat-memory-indexing",
})

export const CHAT_MEMORY_INDEXING_QUEUE_NAME = "chat-memory-indexing"

export interface ChatMemoryIndexingJob {
  chatId: string
  workspaceId: string
  email: string
  userMessageId: number
  assistantMessageId: number
  userMessage: string
  assistantMessage: string
  /** Assistant reasoning/thinking for richer embedding. */
  assistantThinking?: string
  toolsUsed?: string[]
  /** Turn timestamp (ms) for recency ranking; use assistant.createdAt, fallback user.createdAt. */
  createdAt?: number
}

export async function queueChatMemoryIndexing(params: {
  chatId: string
  workspaceId: string
  email: string
  userMessageId: number
  assistantMessageId: number
  userMessage: string
  assistantMessage: string
  assistantThinking?: string
  toolsUsed?: string[]
  /** Turn timestamp (ms) for recency ranking; use assistant.createdAt, fallback user.createdAt. */
  createdAt?: number
}): Promise<void> {
  const job: ChatMemoryIndexingJob = {
    chatId: params.chatId,
    workspaceId: params.workspaceId,
    email: params.email,
    userMessageId: params.userMessageId,
    assistantMessageId: params.assistantMessageId,
    userMessage: params.userMessage,
    assistantMessage: params.assistantMessage,
    assistantThinking: params.assistantThinking,
    toolsUsed: params.toolsUsed,
    createdAt: params.createdAt,
  }
  try {
    await boss.send(CHAT_MEMORY_INDEXING_QUEUE_NAME, job, {
      retryLimit: 2,
      retryDelay: 60,
      expireInHours: 23,
    })
    logger.debug(
      { chatId: params.chatId, userMessageId: params.userMessageId },
      "Queued chat memory indexing",
    )
  } catch (error) {
    logger.error(
      {
        error: error instanceof Error ? error.message : String(error),
        chatId: params.chatId,
      },
      "Failed to queue chat memory indexing",
    )
    throw error
  }
}
