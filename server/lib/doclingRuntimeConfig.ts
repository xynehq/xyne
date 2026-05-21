import config from "@/config"
import { getRedisClient } from "@/lib/redisClient"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingRuntimeConfig",
})

export type DoclingRuntimeConfig = {
  submitPermits: number
  activeOcrFiles: number
  perFileInflightParts: number
  splitterConcurrency: number
  vespaWritePermits: number
  version: string | null
  updatedAt: string | null
  source: "defaults" | "redis"
}

const DEFAULT_RUNTIME_CONFIG: DoclingRuntimeConfig = Object.freeze({
  submitPermits: config.doclingAsyncSubmitPermits,
  activeOcrFiles: config.doclingSchedulerActiveOcrFiles,
  perFileInflightParts: config.doclingSchedulerPerFileInflightParts,
  splitterConcurrency: config.doclingSchedulerSplitConcurrency,
  vespaWritePermits: config.doclingSchedulerVespaWritePermits,
  version: null,
  updatedAt: null,
  source: "defaults",
})

let currentRuntimeConfig: DoclingRuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG }
let refreshPromise: Promise<DoclingRuntimeConfig> | null = null
let pollTimer: NodeJS.Timeout | null = null
let pollingStarted = false

const parsePositiveInteger = (
  rawValue: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(rawValue || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const sameRuntimeConfig = (
  left: DoclingRuntimeConfig,
  right: DoclingRuntimeConfig,
) =>
  left.submitPermits === right.submitPermits &&
  left.activeOcrFiles === right.activeOcrFiles &&
  left.perFileInflightParts === right.perFileInflightParts &&
  left.splitterConcurrency === right.splitterConcurrency &&
  left.vespaWritePermits === right.vespaWritePermits &&
  left.version === right.version &&
  left.updatedAt === right.updatedAt &&
  left.source === right.source

const buildRuntimeConfig = (
  payload: Record<string, string>,
): DoclingRuntimeConfig => {
  if (Object.keys(payload).length === 0) {
    return { ...DEFAULT_RUNTIME_CONFIG }
  }

  return {
    submitPermits: parsePositiveInteger(
      payload.submit_permits,
      DEFAULT_RUNTIME_CONFIG.submitPermits,
    ),
    activeOcrFiles: parsePositiveInteger(
      payload.active_ocr_files,
      DEFAULT_RUNTIME_CONFIG.activeOcrFiles,
    ),
    perFileInflightParts: parsePositiveInteger(
      payload.per_file_inflight_parts,
      DEFAULT_RUNTIME_CONFIG.perFileInflightParts,
    ),
    splitterConcurrency: parsePositiveInteger(
      payload.splitter_concurrency,
      DEFAULT_RUNTIME_CONFIG.splitterConcurrency,
    ),
    vespaWritePermits: parsePositiveInteger(
      payload.vespa_write_permits,
      DEFAULT_RUNTIME_CONFIG.vespaWritePermits,
    ),
    version: payload.version || null,
    updatedAt: payload.updated_at || null,
    source: "redis",
  }
}

const schedulePoll = () => {
  if (!pollingStarted) {
    return
  }

  pollTimer = setTimeout(async () => {
    pollTimer = null
    await refreshDoclingRuntimeConfig()
    schedulePoll()
  }, config.doclingRuntimeConfigPollMs)

  pollTimer.unref?.()
}

export const getDoclingRuntimeConfig = (): DoclingRuntimeConfig =>
  currentRuntimeConfig

export const refreshDoclingRuntimeConfig =
  async (): Promise<DoclingRuntimeConfig> => {
    if (refreshPromise) {
      return refreshPromise
    }

    refreshPromise = (async () => {
      try {
        const redis = await getRedisClient()
        const payload = await redis.hGetAll(config.doclingRuntimeConfigKey)
        const nextRuntimeConfig = buildRuntimeConfig(payload)

        if (!sameRuntimeConfig(currentRuntimeConfig, nextRuntimeConfig)) {
          Logger.info(
            {
              redisKey: config.doclingRuntimeConfigKey,
              previous: currentRuntimeConfig,
              next: nextRuntimeConfig,
            },
            "Updated Docling runtime config from Redis",
          )
        }

        currentRuntimeConfig = nextRuntimeConfig
      } catch (error) {
        Logger.warn(
          {
            redisKey: config.doclingRuntimeConfigKey,
            error: getErrorMessage(error),
          },
          "Failed to refresh Docling runtime config from Redis; keeping previous values",
        )
      }

      return currentRuntimeConfig
    })().finally(() => {
      refreshPromise = null
    })

    return refreshPromise
  }

export const startDoclingRuntimeConfigPolling = () => {
  if (pollingStarted) {
    return
  }

  pollingStarted = true
  void refreshDoclingRuntimeConfig()
  schedulePoll()
}

export const stopDoclingRuntimeConfigPolling = () => {
  pollingStarted = false
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
