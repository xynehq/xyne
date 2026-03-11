import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss } from "@/queue"
import {
  CHAT_MEMORY_INDEXING_QUEUE_NAME,
  type ChatMemoryIndexingJob,
} from "@/queue/chat-memory-indexing"
import { indexConversationTurn } from "@/services/chatMemoryIndexer"

const logger = getLogger(Subsystem.Worker).child({
  module: "chat-memory-worker",
})

export async function startChatMemoryWorker() {
  logger.info("Starting chat memory indexing worker")

  await boss.work(
    CHAT_MEMORY_INDEXING_QUEUE_NAME,
    { batchSize: 5 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          const payload = job.data as ChatMemoryIndexingJob
          try {
            await indexConversationTurn(payload)
            logger.debug(
              { chatId: payload.chatId, userMessageId: payload.userMessageId },
              "Chat memory turn indexed",
            )
          } catch (error) {
            logger.error(
              {
                error: error instanceof Error ? error.message : String(error),
                chatId: payload.chatId,
                userMessageId: payload.userMessageId,
              },
              "Chat memory indexing job failed",
            )
            throw error
          }
        }),
      )
    },
  )

  logger.info("Chat memory worker started")
}
