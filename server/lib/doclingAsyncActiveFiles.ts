import config from "@/config"
import { getRedisClient } from "@/lib/redisClient"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Integrations).child({
  module: "doclingAsyncActiveFiles",
})

const ACTIVE_FILES_KEY = "docling:async:active-files"
const ACTIVE_FILE_META_PREFIX = "docling:async:active-file"
const MIN_ACTIVE_FILE_LEASE_TTL_MS = 60 * 60 * 1000

const ACQUIRE_SCRIPT = `
local active_key = KEYS[1]
local meta_key = KEYS[2]
local now_ms = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local expires_at_ms = tonumber(ARGV[3])
local lease_ttl_ms = tonumber(ARGV[4])
local file_id = ARGV[5]

redis.call("ZREMRANGEBYSCORE", active_key, "-inf", now_ms)

if redis.call("ZSCORE", active_key, file_id) then
  redis.call("ZADD", active_key, expires_at_ms, file_id)
  redis.call("PEXPIRE", meta_key, lease_ttl_ms)
  return 2
end

if redis.call("ZCARD", active_key) >= capacity then
  return 0
end

redis.call("ZADD", active_key, expires_at_ms, file_id)
redis.call(
  "HSET",
  meta_key,
  "fileId", file_id,
  "fileName", ARGV[6],
  "acquiredAt", ARGV[7],
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

type ActiveFileInput = {
  fileId: string
  fileName?: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const activeFileMetaKey = (fileId: string) =>
  `${ACTIVE_FILE_META_PREFIX}:${fileId}`

const activeFileLeaseTtlMs = () =>
  Math.max(
    config.doclingAsyncSubmitPermitLeaseTtlMs,
    MIN_ACTIVE_FILE_LEASE_TTL_MS,
  )

const tryAcquireActiveFile = async (input: ActiveFileInput): Promise<number> => {
  if (config.doclingActiveFileLimit <= 0) {
    return 1
  }

  const now = Date.now()
  const leaseTtlMs = activeFileLeaseTtlMs()
  const redis = await getRedisClient()
  const result = await redis.sendCommand([
    "EVAL",
    ACQUIRE_SCRIPT,
    "2",
    ACTIVE_FILES_KEY,
    activeFileMetaKey(input.fileId),
    String(now),
    String(config.doclingActiveFileLimit),
    String(now + leaseTtlMs),
    String(leaseTtlMs),
    input.fileId,
    input.fileName || input.fileId,
    new Date(now).toISOString(),
  ])

  return Number(result)
}

export const acquireDoclingActiveFile = async (
  input: ActiveFileInput,
): Promise<void> => {
  if (config.doclingActiveFileLimit <= 0) {
    return
  }

  const waitStartedAt = Date.now()
  while (true) {
    const acquired = await tryAcquireActiveFile(input)

    if (acquired > 0) {
      Logger.info(
        {
          fileId: input.fileId,
          fileName: input.fileName,
          limit: config.doclingActiveFileLimit,
          reusedExistingSlot: acquired === 2,
          waitMs: Date.now() - waitStartedAt,
        },
        "Acquired async Docling active-file slot",
      )
      return
    }

    const waitedMs = Date.now() - waitStartedAt
    Logger.warn(
      {
        fileId: input.fileId,
        fileName: input.fileName,
        limit: config.doclingActiveFileLimit,
        waitedMs,
        pollMs: config.doclingAsyncSubmitPermitPollMs,
      },
      "Waiting for async Docling active-file slot",
    )
    await sleep(config.doclingAsyncSubmitPermitPollMs)
  }
}

export const releaseDoclingActiveFile = async (
  fileId?: string | null,
): Promise<void> => {
  if (!fileId || config.doclingActiveFileLimit <= 0) {
    return
  }

  const redis = await getRedisClient()
  const result = await redis.sendCommand([
    "EVAL",
    RELEASE_SCRIPT,
    "2",
    ACTIVE_FILES_KEY,
    activeFileMetaKey(fileId),
    fileId,
  ])

  if (Number(result) > 0) {
    Logger.info({ fileId }, "Released async Docling active-file slot")
  }
}
