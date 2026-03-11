import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss } from "./boss"

const logger = getLogger(Subsystem.Queue).child({
  module: "episodic-memory-extraction",
})

export const EPISODIC_MEMORY_QUEUE_NAME = "episodic-memory-extraction"

export interface EpisodicMemoryMessage {
  role: string
  content: string
  /** For assistant messages: reasoning/thinking for richer extraction. */
  thinking?: string
}

export interface EpisodicMemoryExtractionJob {
  chatId: string
  email: string
  workspaceId: string
  /** Only the messages archived during compaction — not the full history. */
  messagesToProcess: EpisodicMemoryMessage[]
}

export async function queueEpisodicMemoryExtraction(params: {
  chatId: string
  email: string
  workspaceId: string
  messagesToProcess: EpisodicMemoryMessage[]
}): Promise<void> {
  const job: EpisodicMemoryExtractionJob = {
    chatId: params.chatId,
    email: params.email,
    workspaceId: params.workspaceId,
    messagesToProcess: params.messagesToProcess,
  }
  try {
    await boss.send(EPISODIC_MEMORY_QUEUE_NAME, job, {
      retryLimit: 2,
      retryDelay: 60,
      expireInHours: 23,
    })
    logger.debug({ chatId: params.chatId }, "Queued episodic memory extraction")
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), chatId: params.chatId },
      "Failed to queue episodic memory extraction",
    )
    throw error
  }
}
