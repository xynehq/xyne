import { randomUUID } from "node:crypto"
import path from "node:path"
import config, { NAMESPACE } from "@/config"
import { updateParentStatus } from "@/db/knowledgeBase"
import {
  type DoclingResponse,
  processingResultFromDoclingResponse,
} from "@/lib/chunkByDocling"
import {
  releaseDoclingSchedulerPermit,
  tryAcquireDoclingSchedulerPermit,
} from "@/lib/doclingSchedulerPermits"
import {
  cleanupDoclingSchedulerStageDir,
  getDoclingSchedulerResultPath,
  getDoclingSchedulerResultsDir,
  getDoclingSchedulerStorageRoot,
  resolveDoclingSchedulerSourcePath,
  readDoclingSchedulerJson,
  writeDoclingSchedulerJson,
} from "@/lib/doclingSchedulerStorage"
import {
  admitDoclingOcrFiles,
  claimNextDoclingFileToSplit,
  claimNextDoclingFileToWrite,
  claimNextDoclingPartForSubmit,
  DOCLING_FILE_STATUS,
  DOCLING_PART_STATUS,
  failDoclingFile,
  failDoclingFileIfOwned,
  getDoclingFile,
  getDoclingPartByJobId,
  getDoclingPartsForFile,
  listExpiredSubmittingDoclingParts,
  listTimedOutSubmittedDoclingParts,
  markDoclingFileCompleted,
  markDoclingFileSplitComplete,
  markDoclingFileSplitRetry,
  markDoclingFileWriteRetry,
  markDoclingPartReady,
  markDoclingPartSubmitted,
  markDoclingPartSubmitRetry,
  requeueExpiredDoclingLeases,
} from "@/lib/doclingSchedulerStore"
import { submitDoclingAsyncJob } from "@/lib/doclingAsyncClient"
import { getRedisClient } from "@/lib/redisClient"
import {
  PDF_PROCESSING_METHOD,
  PdfProcessor,
  type ProcessingResult as PdfProcessingResult,
} from "@/lib/pdfProcessor"
import { getLogger } from "@/logger"
import { Subsystem, type ChunkMetadata } from "@/types"
import { getErrorMessage } from "@/utils"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { db } from "@/db/client"

const Logger = getLogger(Subsystem.Queue).child({
  module: "doclingSchedulerWorkers",
})

type RedisStreamEntry = {
  id: string
  fields: Record<string, string>
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const retryDelay = (attempt: number) =>
  Math.min(
    config.doclingSchedulerRetryMaxMs,
    config.doclingSchedulerRetryBaseMs * Math.max(attempt, 1),
  )

const submittedPartTimeoutMs = () =>
  Math.max(
    config.doclingAsyncSubmitPermitLeaseTtlMs,
    config.doclingSchedulerLeaseMs,
  )

const workerId = (role: string) =>
  `${role}:${process.env.HOSTNAME || "local"}:${process.pid}:${randomUUID()}`

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
      entries.push({ id: message[0], fields: parseStreamFields(message[1]) })
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

const ensureSchedulerConsumerGroup = async () => {
  const redis = await getRedisClient()
  try {
    await redis.sendCommand([
      "XGROUP",
      "CREATE",
      config.doclingResultsStream,
      config.doclingSchedulerResultGroup,
      "0",
      "MKSTREAM",
    ])
  } catch (error) {
    if (!getErrorMessage(error).includes("BUSYGROUP")) {
      throw error
    }
  }
}

const ackSchedulerMessage = async (messageId: string) => {
  const redis = await getRedisClient()
  await redis.sendCommand([
    "XACK",
    config.doclingResultsStream,
    config.doclingSchedulerResultGroup,
    messageId,
  ])
}

const offsetChunkMetadata = (
  meta: ChunkMetadata,
  chunkIndex: number,
  pageOffset: number,
): ChunkMetadata => ({
  ...meta,
  chunk_index: chunkIndex,
  page_numbers: (meta.page_numbers || []).map((page) => page + pageOffset),
  bboxes: meta.bboxes?.map((bbox) =>
    typeof bbox.page_no === "number"
      ? { ...bbox, page_no: bbox.page_no + pageOffset }
      : bbox,
  ),
})

const mapChunkMeta = (
  meta: ChunkMetadata,
  includeHeadings = false,
): Record<string, unknown> => {
  const mapped: Record<string, unknown> = {
    chunk_index: meta.chunk_index,
    page_numbers: meta.page_numbers || [],
    block_labels: meta.block_labels || [],
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bbox_l: null,
    bbox_t: null,
    bbox_r: null,
    bbox_b: null,
    bboxes_json: null,
  }

  if (
    meta.bbox &&
    typeof meta.bbox.l === "number" &&
    typeof meta.bbox.t === "number" &&
    typeof meta.bbox.r === "number" &&
    typeof meta.bbox.b === "number"
  ) {
    mapped.bbox_l = meta.bbox.l
    mapped.bbox_t = meta.bbox.t
    mapped.bbox_r = meta.bbox.r
    mapped.bbox_b = meta.bbox.b
  }

  if (Array.isArray(meta.bboxes) && meta.bboxes.length > 0) {
    mapped.bboxes_json = JSON.stringify(meta.bboxes)
  }

  if (includeHeadings) {
    mapped.headings = meta.headings || []
  }

  return mapped
}

const mergeMetadata = (
  existingMetadata: unknown,
  updates: Record<string, unknown>,
) => ({
  ...(typeof existingMetadata === "object" && existingMetadata !== null
    ? (existingMetadata as Record<string, unknown>)
    : {}),
  ...updates,
})

const buildVespaFileName = (file: {
  path: string
  fileName: string
  collectionName: string
}) => {
  const targetPath = file.path
  const reconstructedFilePath =
    targetPath === "/" ? file.fileName : targetPath.substring(1) + file.fileName

  return targetPath === "/"
    ? file.collectionName + targetPath + reconstructedFilePath
    : file.collectionName + targetPath + file.fileName
}

const aggregatePartResults = async (
  parts: Awaited<ReturnType<typeof getDoclingPartsForFile>>,
) => {
  const chunks: string[] = []
  const imageChunks: string[] = []
  const tocChunks: string[] = []
  const chunksMap: Record<string, unknown>[] = []
  const imageChunksMap: Record<string, unknown>[] = []

  for (const part of parts) {
    if (!part.resultPath) {
      throw new Error(
        `Missing result path for file=${part.fileId} part=${part.partIndex}`,
      )
    }

    const result = await readDoclingSchedulerJson<PdfProcessingResult>(
      part.resultPath,
    )
    const textOffset = chunks.length
    const imageOffset = imageChunks.length

    chunks.push(...result.chunks)
    imageChunks.push(...result.image_chunks)
    tocChunks.push(...(result.toc_chunks || []))
    chunksMap.push(
      ...(result.chunks_map || []).map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(meta, textOffset + index, part.startPage),
          true,
        ),
      ),
    )
    imageChunksMap.push(
      ...(result.image_chunks_map || []).map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(meta, imageOffset + index, part.startPage),
          false,
        ),
      ),
    )
  }

  return {
    chunks,
    chunks_pos: chunks.map((_, index) => index),
    image_chunks: imageChunks,
    image_chunks_pos: imageChunks.map((_, index) => index),
    toc_chunks: tocChunks,
    chunks_map: chunksMap,
    image_chunks_map: imageChunksMap,
  }
}

const isRetryableVespaError = (error: unknown) => {
  const message = getErrorMessage(error).toLowerCase()
  return (
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("503") ||
    message.includes("502") ||
    message.includes("504")
  )
}

const putKbItemInVespa = async (vespaDoc: Record<string, unknown>) => {
  const docId = String(vespaDoc.docId || "")
  if (!docId) {
    throw new Error("Missing Vespa docId for scheduler write")
  }

  const url = `${config.vespaEndpoint.feedEndpoint}/document/v1/${NAMESPACE}/${KbItemsSchema}/docid/${encodeURIComponent(docId)}?timeout=${encodeURIComponent(config.vespaDocumentUpdateTimeout)}`
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(config.doclingSchedulerVespaWriteTimeoutMs),
    body: JSON.stringify({ fields: vespaDoc }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText)
    throw new Error(
      `Vespa write failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`,
    )
  }
}

const releaseOcrPermitsForFile = async (fileId: string) => {
  const parts = await getDoclingPartsForFile(fileId)
  const permitIds = new Set(
    parts
      .map((part) => part.submitPermitId)
      .filter((permitId): permitId is string => Boolean(permitId)),
  )

  for (const permitId of permitIds) {
    await releaseDoclingSchedulerPermit({
      kind: "ocr-submit",
      permitId,
    })
  }
}

const failDoclingSchedulerFile = async (
  fileId: string,
  errorMessage: string,
) => {
  await releaseOcrPermitsForFile(fileId)
  await failDoclingFile(fileId, errorMessage)
}

export const startDoclingSchedulerSplitter = async () => {
  const concurrency = Math.max(config.doclingSchedulerSplitConcurrency, 1)
  await Promise.all(
    Array.from({ length: concurrency }, async (_, index) => {
      const id = workerId(`splitter-${index}`)
      while (true) {
        const file = await claimNextDoclingFileToSplit(
          id,
          config.doclingSchedulerLeaseMs,
        )
        if (!file) {
          await sleep(config.doclingSchedulerPollMs)
          continue
        }

        try {
          const sourcePath = resolveDoclingSchedulerSourcePath(
            file.sourcePath,
            file.sourceStorageKey,
          )
          const stagedParts = await PdfProcessor.stageDoclingPagePartsFromFile({
            fileId: file.fileId,
            sourcePath,
            fileName: file.fileName,
            vespaDocId: file.vespaDocId,
            pageChunkSize: config.doclingPageChunkSize,
            stageRootPath: getDoclingSchedulerStorageRoot(),
          })
          const committed = await markDoclingFileSplitComplete(
            file,
            stagedParts,
            getDoclingSchedulerResultsDir(
              file.fileId,
              path.basename(stagedParts.stageDir),
            ),
          )
          if (!committed) {
            Logger.warn(
              {
                fileId: file.fileId,
                leaseOwner: file.leaseOwner,
                leaseToken: file.leaseToken,
              },
              "Ignoring stale Docling split completion after lease changed",
            )
          }
        } catch (error) {
          Logger.error(
            { fileId: file.fileId, error: getErrorMessage(error) },
            "Docling scheduler split failed",
          )
          await markDoclingFileSplitRetry(
            file,
            getErrorMessage(error),
            new Date(Date.now() + retryDelay(1)),
          )
        }
      }
    }),
  )
}

export const startDoclingSchedulerSubmitter = async () => {
  const id = workerId("submitter")
  while (true) {
    await admitDoclingOcrFiles(config.doclingSchedulerActiveOcrFiles)

    const permit = await tryAcquireDoclingSchedulerPermit({
      kind: "ocr-submit",
      capacity: config.doclingAsyncSubmitPermits,
      ttlMs: config.doclingAsyncSubmitPermitLeaseTtlMs,
      owner: id,
    })
    if (!permit) {
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    const part = await claimNextDoclingPartForSubmit({
      workerId: id,
      permitId: permit.permitId,
      leaseMs: config.doclingSchedulerLeaseMs,
      perFileInflightLimit: config.doclingSchedulerPerFileInflightParts,
    })
    if (!part) {
      await releaseDoclingSchedulerPermit(permit)
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    const jobId = part.currentJobId
    if (!jobId) {
      await releaseDoclingSchedulerPermit(permit)
      await failDoclingSchedulerFile(
        part.fileId,
        "Claimed OCR part without job id",
      )
      continue
    }

    try {
      const file = await getDoclingFile(part.fileId)
      if (!file) {
        throw new Error(`Missing scheduler file for ${part.fileId}`)
      }
      const buffer = await PdfProcessor.readStagedPartBuffer({
        partIndex: part.partIndex,
        startPage: part.startPage,
        endPage: part.endPage,
        totalPages: file.totalPages,
        partDocId: part.docId,
        partFileName: `${file.fileName}.part-${part.partIndex}.pdf`,
        partPath: part.partPath,
        partSizeBytes: part.partSizeBytes,
      })
      await submitDoclingAsyncJob({
        buffer,
        fileName: `${file.fileName}.part-${part.partIndex}.pdf`,
        jobId,
        fileId: part.fileId,
        docId: part.docId,
        vespaDocId: file.vespaDocId,
        skipInternalPermit: true,
      })
      await markDoclingPartSubmitted(part.fileId, part.partIndex, jobId)
    } catch (error) {
      await releaseDoclingSchedulerPermit(permit)
      const message = getErrorMessage(error)
      if (part.attemptCount >= config.doclingSchedulerMaxPartAttempts) {
        await failDoclingSchedulerFile(
          part.fileId,
          `OCR submit failed for part ${part.partIndex} after ${part.attemptCount} attempts: ${message}`,
        )
      } else {
        await markDoclingPartSubmitRetry({
          fileId: part.fileId,
          partIndex: part.partIndex,
          jobId,
          errorMessage: message,
          availableAt: new Date(Date.now() + retryDelay(part.attemptCount)),
        })
      }
    }
  }
}

const handleSchedulerResultEvent = async (message: RedisStreamEntry) => {
  const jobId = message.fields.job_id
  const status = message.fields.status
  if (!jobId) {
    return
  }

  const part = await getDoclingPartByJobId(jobId)
  if (!part) {
    return
  }

  if (
    part.status !== DOCLING_PART_STATUS.Submitting &&
    part.status !== DOCLING_PART_STATUS.Submitted
  ) {
    if (part.submitPermitId) {
      await releaseDoclingSchedulerPermit({
        kind: "ocr-submit",
        permitId: part.submitPermitId,
      })
    }
    Logger.info(
      {
        jobId,
        fileId: part.fileId,
        partIndex: part.partIndex,
        status: part.status,
        messageId: message.id,
      },
      "Ignoring duplicate or stale scheduler Docling result event",
    )
    return
  }

  if (status === "failed") {
    if (part.submitPermitId) {
      await releaseDoclingSchedulerPermit({
        kind: "ocr-submit",
        permitId: part.submitPermitId,
      })
    }
    const errorMessage = message.fields.error || "unknown OCR failure"
    if (part.attemptCount >= config.doclingSchedulerMaxPartAttempts) {
      await failDoclingSchedulerFile(
        part.fileId,
        `OCR failed for part ${part.partIndex} after ${part.attemptCount} attempts: ${errorMessage}`,
      )
    } else {
      await markDoclingPartSubmitRetry({
        fileId: part.fileId,
        partIndex: part.partIndex,
        jobId,
        errorMessage,
        availableAt: new Date(Date.now() + retryDelay(part.attemptCount)),
      })
    }
    return
  }

  if (status !== "ok") {
    throw new Error(`Unsupported Docling result status=${status}`)
  }

  const resultKey = message.fields.result_key
  if (!resultKey) {
    throw new Error(`Missing result_key for Docling event ${message.id}`)
  }

  const redis = await getRedisClient()
  const payload = await redis.get(resultKey)
  if (!payload) {
    throw new Error(`Missing Docling result payload at ${resultKey}`)
  }

  const file = await getDoclingFile(part.fileId)
  if (!file) {
    throw new Error(`Missing scheduler file for ${part.fileId}`)
  }

  const doclingResponse = JSON.parse(payload) as DoclingResponse
  const result = await processingResultFromDoclingResponse(
    doclingResponse,
    part.docId,
    { fileName: file.fileName },
  )
  const resultPath = file.resultsDir
    ? path.join(
        file.resultsDir,
        `${String(part.partIndex).padStart(5, "0")}.json`,
      )
    : getDoclingSchedulerResultPath(
        part.fileId,
        path.basename(file.stageDir || ""),
        part.partIndex,
      )
  await writeDoclingSchedulerJson(resultPath, {
    ...result,
    processingMethod: result.processingMethod || PDF_PROCESSING_METHOD.DOCLING,
  })
  await markDoclingPartReady({
    fileId: part.fileId,
    partIndex: part.partIndex,
    jobId,
    resultPath,
  })
  await redis.del(resultKey).catch((error) => {
    Logger.warn(
      {
        resultKey,
        jobId,
        fileId: part.fileId,
        partIndex: part.partIndex,
        error: getErrorMessage(error),
      },
      "Failed to delete raw Docling result from Redis after durable store",
    )
  })
  if (part.submitPermitId) {
    await releaseDoclingSchedulerPermit({
      kind: "ocr-submit",
      permitId: part.submitPermitId,
    })
  }
}

export const startDoclingSchedulerResultWorker = async () => {
  await ensureSchedulerConsumerGroup()
  const redis = await getRedisClient()
  const consumerName = workerId("result")

  while (true) {
    const claimed = parseXAutoClaimResponse(
      await redis.sendCommand([
        "XAUTOCLAIM",
        config.doclingResultsStream,
        config.doclingSchedulerResultGroup,
        consumerName,
        String(config.doclingResultMinIdleMs),
        "0-0",
        "COUNT",
        String(config.doclingResultReadCount),
      ]),
    )

    const messages =
      claimed.length > 0
        ? claimed
        : parseXReadResponse(
            await redis.sendCommand([
              "XREADGROUP",
              "GROUP",
              config.doclingSchedulerResultGroup,
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

    for (const message of messages) {
      try {
        await handleSchedulerResultEvent(message)
        await ackSchedulerMessage(message.id)
      } catch (error) {
        Logger.error(
          {
            messageId: message.id,
            fields: message.fields,
            error: getErrorMessage(error),
          },
          "Failed to process scheduler Docling result event",
        )
      }
    }
  }
}

export const startDoclingSchedulerWriter = async () => {
  const id = workerId("writer")
  while (true) {
    const file = await claimNextDoclingFileToWrite(
      id,
      config.doclingSchedulerLeaseMs,
    )
    if (!file) {
      await sleep(config.doclingSchedulerPollMs)
      continue
    }

    let permit:
      | Awaited<ReturnType<typeof tryAcquireDoclingSchedulerPermit>>
      | null = null
    try {
      const parts = await getDoclingPartsForFile(file.fileId)
      if (parts.length !== file.totalParts) {
        throw new Error(
          `Expected ${file.totalParts} parts, found ${parts.length}`,
        )
      }
      const aggregate = await aggregatePartResults(parts)
      const sourcePath = resolveDoclingSchedulerSourcePath(
        file.sourcePath,
        file.sourceStorageKey,
      )
      const metadata = mergeMetadata(file.metadata, {
        originalFileName: file.originalName || file.fileName,
        uploadedBy: file.uploadedByEmail || "system",
        chunksCount: aggregate.chunks.length + aggregate.image_chunks.length,
        imageChunksCount: aggregate.image_chunks.length,
        tocChunksCount: aggregate.toc_chunks.length,
        processingMethod: file.baseMimeType,
        pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
        doclingAsyncScheduler: true,
        doclingPageChunkSize: file.pageChunkSize,
        doclingTotalPages: file.totalPages,
        doclingTotalParts: file.totalParts,
        lastModified: Date.now(),
      })
      const vespaDoc = {
        docId: file.vespaDocId,
        clId: file.collectionId,
        itemId: file.fileId,
        fileName: buildVespaFileName(file),
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.File,
        description: "",
        storagePath: sourcePath,
        chunks: aggregate.chunks,
        chunks_pos: aggregate.chunks_pos,
        image_chunks: aggregate.image_chunks,
        image_chunks_pos: aggregate.image_chunks_pos,
        toc_chunks: aggregate.toc_chunks,
        chunks_map: aggregate.chunks_map,
        image_chunks_map: aggregate.image_chunks_map,
        pageTitle: file.pageTitle,
        metadata: JSON.stringify(metadata),
        createdBy: file.uploadedByEmail || "system",
        duration: 0,
        mimeType: file.baseMimeType,
        fileSize: file.fileSize,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clFd: file.parentId,
      }

      const payloadBytes = Buffer.byteLength(
        JSON.stringify({ fields: vespaDoc }),
        "utf8",
      )
      if (payloadBytes > config.doclingSchedulerMaxVespaPayloadBytes) {
        await failDoclingFileIfOwned(
          file,
          DOCLING_FILE_STATUS.Writing,
          `Vespa payload for ${file.fileName} is ${payloadBytes} bytes, exceeding limit ${config.doclingSchedulerMaxVespaPayloadBytes}`,
        )
        continue
      }

      while (!permit) {
        permit = await tryAcquireDoclingSchedulerPermit({
          kind: "vespa-write",
          capacity: config.doclingSchedulerVespaWritePermits,
          ttlMs: config.doclingSchedulerVespaWritePermitTtlMs,
          owner: id,
          metadata: { fileId: file.fileId, vespaDocId: file.vespaDocId },
        })
        if (!permit) {
          await sleep(config.doclingSchedulerPollMs)
        }
      }

      await putKbItemInVespa(vespaDoc)
      await releaseDoclingSchedulerPermit(permit)
      permit = null

      const completed = await markDoclingFileCompleted({
        fileId: file.fileId,
        vespaDocId: file.vespaDocId,
        metadata,
        statusMessage: `Successfully processed: ${aggregate.chunks.length + aggregate.image_chunks.length} chunks extracted from ${file.fileName}`,
        leaseOwner: file.leaseOwner,
        leaseToken: file.leaseToken,
      })
      if (!completed) {
        Logger.warn(
          {
            fileId: file.fileId,
            leaseOwner: file.leaseOwner,
            leaseToken: file.leaseToken,
          },
          "Ignoring stale Docling write completion after lease changed",
        )
        continue
      }

      try {
        if (file.collectionId) {
          if (file.parentId) {
            await updateParentStatus(db, file.parentId, false)
          } else {
            await updateParentStatus(db, file.collectionId, true)
          }
        }
      } catch (error) {
        Logger.error(
          {
            fileId: file.fileId,
            collectionId: file.collectionId,
            parentId: file.parentId,
            error: getErrorMessage(error),
          },
          "Docling scheduler completed file but failed to update parent status",
        )
      }

      if (!config.doclingKeepTempResults) {
        await cleanupDoclingSchedulerStageDir(file.stageDir).catch((error) => {
          Logger.warn(
            {
              fileId: file.fileId,
              stageDir: file.stageDir,
              error: getErrorMessage(error),
            },
            "Docling scheduler completed file but failed to clean staged storage",
          )
        })
      }
    } catch (error) {
      if (permit) {
        await releaseDoclingSchedulerPermit(permit)
      }
      const message = getErrorMessage(error)
      if (
        !isRetryableVespaError(error) ||
        file.writeAttemptCount >= config.doclingSchedulerMaxWriteAttempts
      ) {
        await failDoclingFileIfOwned(
          file,
          DOCLING_FILE_STATUS.Writing,
          `Vespa write failed for ${file.fileName} after ${file.writeAttemptCount} attempts: ${message}`,
        )
      } else {
        await markDoclingFileWriteRetry(
          file,
          message,
          new Date(Date.now() + retryDelay(file.writeAttemptCount)),
        )
      }
    }
  }
}

export const startDoclingSchedulerReaper = async () => {
  while (true) {
    try {
      const expiredSubmittingParts = await listExpiredSubmittingDoclingParts(50)
      for (const part of expiredSubmittingParts) {
        if (part.submitPermitId) {
          await releaseDoclingSchedulerPermit({
            kind: "ocr-submit",
            permitId: part.submitPermitId,
          })
        }
      }
      await requeueExpiredDoclingLeases()
      const timedOutParts = await listTimedOutSubmittedDoclingParts(
        submittedPartTimeoutMs(),
        50,
      )
      for (const part of timedOutParts) {
        if (part.submitPermitId) {
          await releaseDoclingSchedulerPermit({
            kind: "ocr-submit",
            permitId: part.submitPermitId,
          })
        }
        if (
          part.currentJobId &&
          part.attemptCount >= config.doclingSchedulerMaxPartAttempts
        ) {
          await failDoclingSchedulerFile(
            part.fileId,
            `OCR timed out for part ${part.partIndex} after ${part.attemptCount} attempts`,
          )
        } else if (part.currentJobId) {
          await markDoclingPartSubmitRetry({
            fileId: part.fileId,
            partIndex: part.partIndex,
            jobId: part.currentJobId,
            errorMessage: `OCR timed out after ${submittedPartTimeoutMs()}ms`,
            availableAt: new Date(Date.now() + retryDelay(part.attemptCount)),
          })
        }
      }
    } catch (error) {
      Logger.error(
        { error: getErrorMessage(error) },
        "Docling scheduler reaper failed",
      )
    }
    await sleep(config.doclingSchedulerPollMs)
  }
}

export const startDoclingSchedulerRole = async (role: string) => {
  if (!config.doclingAsyncSchedulerEnabled) {
    throw new Error(
      "DOCLING_ASYNC_SCHEDULER_ENABLED must be true to start scheduler roles",
    )
  }

  if (role === "splitter") return startDoclingSchedulerSplitter()
  if (role === "submitter") return startDoclingSchedulerSubmitter()
  if (role === "result") return startDoclingSchedulerResultWorker()
  if (role === "writer") return startDoclingSchedulerWriter()
  if (role === "reaper") return startDoclingSchedulerReaper()

  throw new Error(
    `Unknown DOCLING_SCHEDULER_ROLE=${role}. Expected splitter, submitter, result, writer, or reaper.`,
  )
}
