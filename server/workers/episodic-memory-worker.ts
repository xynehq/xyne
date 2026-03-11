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
                jobId: job.id,
              },
              "Episodic memory extraction job failed",
            )
            // Do not rethrow: allow batch to resolve so other jobs are not requeued
          }
        }),
      )
    },
  )

  logger.info("Episodic memory worker started")
}
