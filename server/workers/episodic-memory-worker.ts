import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { boss } from "@/queue"
import {
  EPISODIC_MEMORY_QUEUE_NAME,
  type EpisodicMemoryExtractionJob,
} from "@/queue/episodic-memory-extraction"
import { extractEpisodicMemories } from "@/services/episodicMemoryExtractor"

const logger = getLogger(Subsystem.Worker).child({
  module: "episodic-memory-worker",
})

export async function startEpisodicMemoryWorker() {
  logger.info("Starting episodic memory extraction worker")

  await boss.work(
    EPISODIC_MEMORY_QUEUE_NAME,
    { batchSize: 3 },
    async (jobs) => {
      await Promise.all(
        jobs.map(async (job) => {
          const payload = job.data as EpisodicMemoryExtractionJob
          const { chatId, email, workspaceId, messagesToProcess } = payload
          try {
            // Use the messages passed in the job — only the archived batch,
            // not the entire conversation history.
            await extractEpisodicMemories({
              chatId,
              email,
              workspaceId,
              messagesToProcess,
            })
            logger.info(
              { chatId, messageCount: messagesToProcess.length },
              "Episodic memory extraction completed",
            )
          } catch (error) {
            logger.error(
              {
                error: error instanceof Error ? error.message : String(error),
                chatId,
              },
              "Episodic memory extraction job failed",
            )
            throw error
          }
        }),
      )
    },
  )

  logger.info("Episodic memory worker started")
}
