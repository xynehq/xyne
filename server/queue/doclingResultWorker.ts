import { randomUUID } from "node:crypto"
import config from "@/config"
import { db } from "@/db/client"
import { updateParentStatus } from "@/db/knowledgeBase"
import { collectionItems } from "@/db/schema"
import {
  type DoclingResponse,
  processingResultFromDoclingResponse,
} from "@/lib/chunkByDocling"
import { recordWorkerPhase } from "@/lib/appSyncDiagnostics"
import { releaseDoclingActiveFile } from "@/lib/doclingAsyncActiveFiles"
import {
  type DoclingAsyncPartState,
  deleteDoclingAsyncPartResult,
  doclingAsyncApplyLockKey,
  getDoclingAsyncFileState,
  getDoclingAsyncPartResult,
  getDoclingAsyncPartState,
  nullableFromRedis,
  numberFromRedis,
  parseJsonFromRedis,
  patchDoclingAsyncFileState,
  patchDoclingAsyncPartState,
  putDoclingAsyncPartResult,
} from "@/lib/doclingAsyncState"
import { releaseDoclingAsyncSubmitPermit } from "@/lib/doclingAsyncSubmitPermits"
import {
  PDF_PROCESSING_METHOD,
  type ProcessingResult as PdfProcessingResult,
  PdfProcessor,
} from "@/lib/pdfProcessor"
import { getRedisClient } from "@/lib/redisClient"
import { getLogger } from "@/logger"
import {
  appendDoclingPartToKbItem,
  mergeCollectionItemMetadata,
  submitNextDoclingAsyncPart,
} from "@/queue/fileProcessor"
import { UploadStatus } from "@/shared/types"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { eq } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingResultWorker",
})

type RedisStreamEntry = {
  id: string
  fields: Record<string, string>
}

const parseStreamFields = (rawFields: unknown): Record<string, string> => {
  if (Array.isArray(rawFields)) {
    const fields: Record<string, string> = {}
    for (let index = 0; index < rawFields.length; index += 2) {
      const key = rawFields[index]
      const value = rawFields[index + 1]
      if (typeof key === "string") {
        fields[key] = typeof value === "string" ? value : String(value ?? "")
      }
    }
    return fields
  }

  if (rawFields && typeof rawFields === "object") {
    return Object.fromEntries(
      Object.entries(rawFields as Record<string, unknown>).map(
        ([key, value]) => [
          key,
          typeof value === "string" ? value : String(value ?? ""),
        ],
      ),
    )
  }

  return {}
}

const parseXReadResponse = (response: unknown): RedisStreamEntry[] => {
  if (!Array.isArray(response)) {
    return []
  }

  const entries: RedisStreamEntry[] = []
  for (const stream of response) {
    if (!Array.isArray(stream)) {
      continue
    }
    const messages = stream[1]
    if (!Array.isArray(messages)) {
      continue
    }

    for (const message of messages) {
      if (!Array.isArray(message) || typeof message[0] !== "string") {
        continue
      }
      entries.push({
        id: message[0],
        fields: parseStreamFields(message[1]),
      })
    }
  }

  return entries
}

const parseXAutoClaimResponse = (response: unknown): RedisStreamEntry[] => {
  if (!Array.isArray(response)) {
    return []
  }

  const messages = response[1]
  if (!Array.isArray(messages)) {
    return []
  }

  return messages
    .filter(
      (message) => Array.isArray(message) && typeof message[0] === "string",
    )
    .map((message) => ({
      id: message[0] as string,
      fields: parseStreamFields(message[1]),
    }))
}

const ackRedisMessage = async (messageId: string) => {
  const redis = await getRedisClient()
  await redis.sendCommand([
    "XACK",
    config.doclingResultsStream,
    config.doclingResultGroup,
    messageId,
  ])
}

const getPartIndexFromJobId = (jobId: string): number | null => {
  const match = jobId.match(/:part:(\d+):/)
  if (!match) {
    return null
  }

  const parsed = Number.parseInt(match[1] || "", 10)
  return Number.isFinite(parsed) ? parsed : null
}

const getRunIdFromJobId = (jobId: string): string | null => {
  const match = jobId.match(/:run:([^:]+):part:/)
  return match?.[1] || null
}

const isSchedulerJobId = (jobId: string): boolean =>
  /^docling:[^:]+:part:\d+:attempt:[^:]+$/.test(jobId)

const normalizeResult = (result: PdfProcessingResult): PdfProcessingResult => ({
  ...result,
  toc_chunks: result.toc_chunks || [],
  processingMethod: result.processingMethod || PDF_PROCESSING_METHOD.DOCLING,
})

const submitNextDoclingAsyncPartInBackground = (fileId: string) => {
  setTimeout(() => {
    submitNextDoclingAsyncPart(fileId).catch((error) => {
      Logger.error(
        {
          fileId,
          errorMessage: getErrorMessage(error),
        },
        "Failed to submit next async Docling part in background",
      )
    })
  }, 0)
}

const markFileFailed = async (
  fileId: string,
  errorMessage: string,
  options?: { parentId?: string | null; collectionId?: string | null },
) => {
  await db
    .update(collectionItems)
    .set({
      uploadStatus: UploadStatus.FAILED,
      statusMessage: errorMessage,
      updatedAt: new Date(),
    })
    .where(eq(collectionItems.id, fileId))

  if (options?.collectionId) {
    if (options.parentId) {
      await updateParentStatus(db, options.parentId, false)
    } else {
      await updateParentStatus(db, options.collectionId, true)
    }
  }

  await patchDoclingAsyncFileState(fileId, {
    status: "failed",
  })
  await releaseDoclingActiveFile(fileId).catch((error) => {
    Logger.error(
      {
        fileId,
        error: getErrorMessage(error),
      },
      "Failed to release async Docling active-file slot after file failure",
    )
  })
}

const storePartResultFromRawPayload = async (
  fileId: string,
  partIndex: number,
  partState: Partial<DoclingAsyncPartState>,
) => {
  const resultKey = partState.resultKey
  if (!resultKey) {
    return null
  }

  const redis = await getRedisClient()
  const payload = await redis.get(resultKey)
  if (!payload) {
    return null
  }

  const doclingResponse = JSON.parse(payload) as DoclingResponse
  const result = normalizeResult(
    (await processingResultFromDoclingResponse(
      doclingResponse,
      partState.docId || "",
      { fileName: partState.fileName },
    )) as PdfProcessingResult,
  )
  await putDoclingAsyncPartResult(fileId, partIndex, result)
  return result
}

const loadAndStoreSuccessfulPart = async (
  message: RedisStreamEntry,
  fileId: string,
  partIndex: number,
): Promise<boolean> => {
  const resultKey = message.fields.result_key
  if (!resultKey) {
    throw new Error(`Missing result_key for Redis event ${message.id}`)
  }

  const existingPart = await getDoclingAsyncPartState(fileId, partIndex)
  if (!existingPart) {
    Logger.warn(
      {
        fileId,
        partIndex,
        messageId: message.id,
        jobId: message.fields.job_id,
      },
      "Ignoring stale Docling result event for missing async part state",
    )
    return false
  }

  if (existingPart.jobId && existingPart.jobId !== message.fields.job_id) {
    Logger.warn(
      {
        fileId,
        partIndex,
        messageId: message.id,
        eventJobId: message.fields.job_id,
        currentJobId: existingPart.jobId,
      },
      "Ignoring stale Docling result event for superseded async part job",
    )
    return false
  }

  const eventRunId = getRunIdFromJobId(message.fields.job_id)
  if (existingPart.runId && eventRunId !== existingPart.runId) {
    Logger.warn(
      {
        fileId,
        partIndex,
        messageId: message.id,
        eventRunId,
        currentRunId: existingPart.runId,
      },
      "Ignoring stale Docling result event for superseded async run",
    )
    return false
  }

  if (
    existingPart?.status === "applied" ||
    existingPart?.status === "completed"
  ) {
    return true
  }
  if (
    existingPart?.status === "ready" &&
    (await getDoclingAsyncPartResult<PdfProcessingResult>(fileId, partIndex))
  ) {
    return true
  }

  const redis = await getRedisClient()
  const payload = await redis.get(resultKey)
  if (!payload) {
    throw new Error(`Missing Docling result payload at ${resultKey}`)
  }

  const doclingResponse = JSON.parse(payload) as DoclingResponse
  const result = normalizeResult(
    (await processingResultFromDoclingResponse(
      doclingResponse,
      message.fields.doc_id,
      { fileName: existingPart?.fileName },
    )) as PdfProcessingResult,
  )

  await putDoclingAsyncPartResult(fileId, partIndex, result)
  await patchDoclingAsyncPartState(fileId, partIndex, {
    status: "ready",
    resultKey,
    eventId: message.id,
  })
  return true
}

const applyReadyParts = async (fileId: string) => {
  const redis = await getRedisClient()
  const lockKey = doclingAsyncApplyLockKey(fileId)
  const lockToken = randomUUID()
  const lockAcquired = await redis.set(lockKey, lockToken, {
    NX: true,
    PX: config.doclingAsyncApplyLockTtlMs,
  })

  if (!lockAcquired) {
    return
  }

  try {
    const state = await getDoclingAsyncFileState(fileId)
    if (!state) {
      throw new Error(`Missing Docling async file state for ${fileId}`)
    }

    const totalParts = numberFromRedis(state.totalParts)
    const totalPages = numberFromRedis(state.totalPages)
    const collectionId = state.collectionId || null
    const parentId = nullableFromRedis(state.parentId)
    const fileName = state.fileName || fileId
    const vespaDocId = state.vespaDocId
    if (!vespaDocId) {
      throw new Error(`Missing vespaDocId in Docling async state for ${fileId}`)
    }
    const baseMetadata = parseJsonFromRedis<Record<string, unknown>>(
      state.metadataJson,
      {},
    )

    let nextPartToApply = numberFromRedis(state.nextPartToApply)
    let textChunksCount = numberFromRedis(state.textChunksCount)
    let imageChunksCount = numberFromRedis(state.imageChunksCount)
    let tocChunksCount = numberFromRedis(state.tocChunksCount)
    let advancedApplyCursor = false

    await patchDoclingAsyncFileState(fileId, {
      status: "applying",
    })

    while (nextPartToApply < totalParts) {
      const partState = await getDoclingAsyncPartState(fileId, nextPartToApply)

      if (
        partState?.status === "applied" ||
        partState?.status === "completed"
      ) {
        nextPartToApply += 1
        advancedApplyCursor = true
        await patchDoclingAsyncFileState(fileId, {
          nextPartToApply: String(nextPartToApply),
        })
        continue
      }

      if (partState?.status !== "ready") {
        break
      }

      let partResult = await getDoclingAsyncPartResult<PdfProcessingResult>(
        fileId,
        nextPartToApply,
      )
      if (!partResult) {
        if (state.runId && partState.runId === state.runId) {
          partResult = await storePartResultFromRawPayload(
            fileId,
            nextPartToApply,
            partState,
          )
        }

        if (!partResult) {
          Logger.warn(
            {
              fileId,
              partIndex: nextPartToApply,
              status: partState.status,
              fileRunId: state.runId,
              partRunId: partState.runId,
              resultKey: partState.resultKey,
            },
            "Resetting async Docling part because ready state has no trusted normalized result",
          )
          await deleteDoclingAsyncPartResult(fileId, nextPartToApply)
          await patchDoclingAsyncPartState(fileId, nextPartToApply, {
            status: "queued",
            resultKey: "",
            eventId: "",
            error: "Ready state had no trusted normalized result; queued for resubmission",
            submitCount: "0",
            jobId: state.runId
              ? `docling:${fileId}:${vespaDocId}:run:${state.runId}:part:${nextPartToApply}:v2`
              : "",
          })
          await patchDoclingAsyncFileState(fileId, {
            status: "submitted",
            nextPartToSubmit: String(nextPartToApply),
          })
          submitNextDoclingAsyncPartInBackground(fileId)
          return
        }
      }

      const startPage = numberFromRedis(partState.startPage)
      const endPage = numberFromRedis(partState.endPage)
      const nextTextChunksCount = textChunksCount + partResult.chunks.length
      const nextImageChunksCount =
        imageChunksCount + partResult.image_chunks.length
      const nextTocChunksCount =
        tocChunksCount + (partResult.toc_chunks || []).length
      const partMetadata = mergeCollectionItemMetadata(baseMetadata, {
        originalFileName: state.originalName || fileName,
        uploadedBy: state.uploadedByEmail || "system",
        chunksCount: nextTextChunksCount + nextImageChunksCount,
        imageChunksCount: nextImageChunksCount,
        tocChunksCount: nextTocChunksCount,
        processingMethod: state.baseMimeType || "application/pdf",
        pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
        doclingStreaming: true,
        doclingAsync: true,
        doclingPageChunkSize: numberFromRedis(state.pageChunkSize),
        doclingPartsProcessed: nextPartToApply + 1,
        doclingTotalPages: totalPages,
        doclingLastPageProcessed: endPage,
        ...(state.pageTitle && { pageTitle: state.pageTitle }),
        lastModified: Date.now(),
      })

      await patchDoclingAsyncPartState(fileId, nextPartToApply, {
        status: "applying",
      })
      await appendDoclingPartToKbItem(
        vespaDocId,
        normalizeResult(partResult),
        partMetadata,
        textChunksCount,
        imageChunksCount,
        startPage,
      )

      textChunksCount = nextTextChunksCount
      imageChunksCount = nextImageChunksCount
      tocChunksCount = nextTocChunksCount
      nextPartToApply += 1

      await patchDoclingAsyncPartState(fileId, nextPartToApply - 1, {
        status: "completed",
        appliedAt: new Date().toISOString(),
      })
      await PdfProcessor.deleteStagedPartPath(partState.partPath)
      await deleteDoclingAsyncPartResult(fileId, nextPartToApply - 1)
      await patchDoclingAsyncFileState(fileId, {
        nextPartToApply: String(nextPartToApply),
        textChunksCount: String(textChunksCount),
        imageChunksCount: String(imageChunksCount),
        tocChunksCount: String(tocChunksCount),
      })
      advancedApplyCursor = true
    }

    if (nextPartToApply < totalParts) {
      await patchDoclingAsyncFileState(fileId, {
        status: "submitted",
      })
      if (advancedApplyCursor) {
        submitNextDoclingAsyncPartInBackground(fileId)
      }
      return
    }

    const dbMetadata = mergeCollectionItemMetadata(baseMetadata, {
      chunksCount: textChunksCount + imageChunksCount,
      imageChunksCount,
      tocChunksCount,
      pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
      doclingStreaming: true,
      doclingAsync: true,
      doclingPageChunkSize: numberFromRedis(state.pageChunkSize),
      doclingPartsProcessed: totalParts,
      doclingTotalPages: totalPages,
    })

    await db
      .update(collectionItems)
      .set({
        vespaDocId,
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: `Successfully processed: ${textChunksCount + imageChunksCount} chunks extracted from ${fileName}`,
        metadata: dbMetadata,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))

    if (collectionId) {
      if (parentId) {
        await updateParentStatus(db, parentId, false)
      } else {
        await updateParentStatus(db, collectionId, true)
      }
    }

    await PdfProcessor.cleanupStagedDoclingDir(state.stageDir, {
      fileId,
      fileName,
    })
    await patchDoclingAsyncFileState(fileId, {
      status: "completed",
    })
    await releaseDoclingActiveFile(fileId).catch((error) => {
      Logger.error(
        {
          fileId,
          error: getErrorMessage(error),
        },
        "Failed to release async Docling active-file slot after file completion",
      )
    })

    const totalChunks = textChunksCount + imageChunksCount
    const completionDetails = {
      fileId,
      fileName,
      vespaDocId,
      collectionId,
      parentId,
      totalParts,
      totalPages,
      textChunksCount,
      imageChunksCount,
      tocChunksCount,
      totalChunks,
      statusEmoji: "✅",
    }
    recordWorkerPhase("async_docling_pdf_completed", completionDetails)
    Logger.info(
      completionDetails,
      `✅ Async Docling PDF completed successfully: ${fileName}`,
    )
  } finally {
    const currentToken = await redis.get(lockKey)
    if (currentToken === lockToken) {
      await redis.del(lockKey)
    }
  }
}

const handleDoclingResultEvent = async (message: RedisStreamEntry) => {
  const fileId = message.fields.file_id
  const jobId = message.fields.job_id
  const status = message.fields.status

  if (!fileId || !jobId) {
    throw new Error(`Malformed Docling result event ${message.id}`)
  }

  if (isSchedulerJobId(jobId)) {
    Logger.info(
      { fileId, jobId, messageId: message.id },
      "Ignoring Docling scheduler result event in legacy Redis result worker",
    )
    return
  }

  const partIndex = getPartIndexFromJobId(jobId)
  if (partIndex === null) {
    throw new Error(`Unable to infer part index from job_id=${jobId}`)
  }

  await releaseDoclingAsyncSubmitPermit(jobId)

  if (status === "failed") {
    const state = await getDoclingAsyncFileState(fileId)
    const errorMessage = `Docling async part failed: ${message.fields.error || "unknown error"}`
    await patchDoclingAsyncPartState(fileId, partIndex, {
      status: "failed",
      eventId: message.id,
      error: errorMessage,
    })
    await markFileFailed(fileId, errorMessage, {
      parentId: nullableFromRedis(state?.parentId),
      collectionId: state?.collectionId || null,
    })
    return
  }

  if (status !== "ok") {
    throw new Error(`Unsupported Docling result status=${status}`)
  }

  const shouldApply = await loadAndStoreSuccessfulPart(message, fileId, partIndex)
  if (!shouldApply) {
    return
  }
  await applyReadyParts(fileId)
}

const processMessages = async (messages: RedisStreamEntry[]) => {
  await Promise.allSettled(
    messages.map(async (message) => {
      try {
        await handleDoclingResultEvent(message)
        await ackRedisMessage(message.id)
      } catch (error) {
        Logger.error(
          {
            messageId: message.id,
            fields: message.fields,
            errorMessage: getErrorMessage(error),
          },
          "Failed to process Docling Redis result event",
        )
      }
    }),
  )
}

const ensureConsumerGroup = async () => {
  const redis = await getRedisClient()
  try {
    await redis.sendCommand([
      "XGROUP",
      "CREATE",
      config.doclingResultsStream,
      config.doclingResultGroup,
      "0",
      "MKSTREAM",
    ])
  } catch (error) {
    if (!getErrorMessage(error).includes("BUSYGROUP")) {
      throw error
    }
  }
}

export const startDoclingRedisResultWorker = async () => {
  await ensureConsumerGroup()
  const redis = await getRedisClient()
  const consumerName = `${process.env.HOSTNAME || "app-sync"}-${process.pid}`

  Logger.info(
    {
      stream: config.doclingResultsStream,
      group: config.doclingResultGroup,
      consumerName,
      concurrency: config.doclingResultConcurrency,
    },
    "Starting Docling Redis result worker",
  )

  while (true) {
    const claimed = parseXAutoClaimResponse(
      await redis.sendCommand([
        "XAUTOCLAIM",
        config.doclingResultsStream,
        config.doclingResultGroup,
        consumerName,
        String(config.doclingResultMinIdleMs),
        "0-0",
        "COUNT",
        String(config.doclingResultReadCount),
      ]),
    )

    if (claimed.length > 0) {
      await processMessages(claimed)
      continue
    }

    const messages = parseXReadResponse(
      await redis.sendCommand([
        "XREADGROUP",
        "GROUP",
        config.doclingResultGroup,
        consumerName,
        "COUNT",
        String(config.doclingResultReadCount),
        "BLOCK",
        String(config.doclingResultBlockMs),
        "STREAMS",
        config.doclingResultsStream,
        ">",
      ]),
    )

    if (messages.length > 0) {
      await processMessages(messages)
    }
  }
}
