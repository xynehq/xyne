import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getRedisClient } from "@/lib/redisClient"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "doclingAsyncSubmitPermits",
})

const ACTIVE_PERMITS_KEY = "docling:async:submit-permits:active"
const PERMIT_META_PREFIX = "docling:async:submit-permit"

const ACQUIRE_SCRIPT = `
local active_key = KEYS[1]
local meta_key = KEYS[2]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local expires_at_ms = tonumber(ARGV[3])
local lease_ttl_ms = tonumber(ARGV[4])
local job_id = ARGV[5]

redis.call("ZREMRANGEBYSCORE", active_key, "-inf", now_ms)

if redis.call("ZSCORE", active_key, job_id) then
  redis.call("PEXPIRE", meta_key, lease_ttl_ms)
  return 2
end

if redis.call("ZCARD", active_key) >= capacity then
  return 0
end

redis.call("ZADD", active_key, expires_at_ms, job_id)
redis.call(
  "HSET",
  meta_key,
  "jobId", job_id,
  "fileId", ARGV[6],
  "docId", ARGV[7],
  "vespaDocId", ARGV[8],
  "fileName", ARGV[9],
  "acquiredAt", ARGV[10],
  "expiresAt", ARGV[3]
)
redis.call("PEXPIRE", meta_key, lease_ttl_ms)
return 1
`

const RELEASE_SCRIPT = `
local removed = redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("DEL", KEYS[2])
return removed
`

type PermitInput = {
  jobId: string
  fileId: string
  docId: string
  vespaDocId: string
  fileName: string
}

export type DoclingAsyncSubmitPermit = {
  jobId: string
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const permitMetaKey = (jobId: string) => `${PERMIT_META_PREFIX}:${jobId}`

const tryAcquirePermit = async (input: PermitInput): Promise<number> => {
  const now = Date.now()
  const redis = await getRedisClient()
  const result = await redis.sendCommand([
    "EVAL",
    ACQUIRE_SCRIPT,
    "2",
    ACTIVE_PERMITS_KEY,
    permitMetaKey(input.jobId),
    String(now),
    String(config.doclingAsyncSubmitPermits),
    String(now + config.doclingAsyncSubmitPermitLeaseTtlMs),
    String(config.doclingAsyncSubmitPermitLeaseTtlMs),
    input.jobId,
    input.fileId,
    input.docId,
    input.vespaDocId,
    input.fileName,
    new Date(now).toISOString(),
  ])

  return Number(result)
}

export const acquireDoclingAsyncSubmitPermit = async (
  input: PermitInput,
): Promise<DoclingAsyncSubmitPermit> => {
  const waitStartedAt = Date.now()

  while (true) {
    const acquired = await tryAcquirePermit(input)

    if (acquired > 0) {
      Logger.info(
        {
          jobId: input.jobId,
          fileId: input.fileId,
          permits: config.doclingAsyncSubmitPermits,
          reusedExistingPermit: acquired === 2,
          waitMs: Date.now() - waitStartedAt,
        },
        "Acquired async Docling submit permit",
      )
      return { jobId: input.jobId }
    }

    const waitedMs = Date.now() - waitStartedAt
    if (
      config.doclingAsyncSubmitPermitMaxWaitMs > 0 &&
      waitedMs >= config.doclingAsyncSubmitPermitMaxWaitMs
    ) {
      throw new Error(
        `Timed out waiting for async Docling submit permit after ${waitedMs}ms`,
      )
    }

    Logger.warn(
      {
        jobId: input.jobId,
        fileId: input.fileId,
        permits: config.doclingAsyncSubmitPermits,
        waitedMs,
        pollMs: config.doclingAsyncSubmitPermitPollMs,
      },
      "Waiting for async Docling submit permit",
    )

    const remainingWaitMs =
      config.doclingAsyncSubmitPermitMaxWaitMs > 0
        ? Math.max(config.doclingAsyncSubmitPermitMaxWaitMs - waitedMs, 1)
        : config.doclingAsyncSubmitPermitPollMs
    await sleep(Math.min(config.doclingAsyncSubmitPermitPollMs, remainingWaitMs))
  }
}

export const releaseDoclingAsyncSubmitPermit = async (
  jobId: string,
): Promise<void> => {
  const redis = await getRedisClient()
  const result = await redis.sendCommand([
    "EVAL",
    RELEASE_SCRIPT,
    "2",
    ACTIVE_PERMITS_KEY,
    permitMetaKey(jobId),
    jobId,
  ])

  if (Number(result) > 0) {
    Logger.info({ jobId }, "Released async Docling submit permit")
  }
}
