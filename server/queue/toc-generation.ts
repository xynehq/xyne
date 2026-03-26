import type PgBoss from "pg-boss"
import {
  TOC_QUEUE_EXPIRE_IN_HOURS,
  TOC_QUEUE_NAME,
  TOC_QUEUE_RETRY_DELAY_SECONDS,
  TOC_QUEUE_RETRY_LIMIT,
} from "@/knowledgeBase/toc"

export interface TocGenerationJob {
  fileId: string
  force?: boolean
}

function getTocQueueExpirationSeconds(): number {
  const requestedSeconds = TOC_QUEUE_EXPIRE_IN_HOURS * 60 * 60
  const maxAllowedSeconds = 24 * 60 * 60 - 1
  return Math.min(requestedSeconds, maxAllowedSeconds)
}

export async function enqueueTocGenerationJob(
  boss: PgBoss,
  job: TocGenerationJob,
): Promise<string | null> {
  return boss.send(TOC_QUEUE_NAME, job, {
    retryLimit: TOC_QUEUE_RETRY_LIMIT,
    retryDelay: TOC_QUEUE_RETRY_DELAY_SECONDS,
    // pg-boss 10.x enforces expiration strictly below 24 hours.
    expireInSeconds: getTocQueueExpirationSeconds(),
  })
}

export { TOC_QUEUE_NAME }
export const __tocGenerationInternals = {
  getTocQueueExpirationSeconds,
}
