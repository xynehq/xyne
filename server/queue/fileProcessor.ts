import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import config, { IMAGE_CONTEXT_CONFIG } from "@/config"
import { db } from "@/db/client"
import { updateParentStatus } from "@/db/knowledgeBase"
import { collectionItems, collections } from "@/db/schema"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { recordWorkerPhase } from "@/lib/appSyncDiagnostics"
import {
  inferDoclingSourcePriority,
  upsertDoclingAsyncFileForSplit,
} from "@/lib/doclingSchedulerStore"
import { buildDoclingSchedulerSourceReference } from "@/lib/doclingSchedulerStorage"
import {
  acquireDoclingActiveFile,
  releaseDoclingActiveFile,
} from "@/lib/doclingAsyncActiveFiles"
import { submitDoclingAsyncJob } from "@/lib/doclingAsyncClient"
import {
  type DoclingAsyncFileState,
  type DoclingAsyncPartState,
  deleteDoclingAsyncPartState,
  expireDoclingAsyncKeys,
  getDoclingAsyncFileState,
  getDoclingAsyncPartState,
  listDoclingAsyncPartIndexes,
  numberFromRedis,
  patchDoclingAsyncFileState,
  patchDoclingAsyncPartState,
  setDoclingAsyncFileState,
} from "@/lib/doclingAsyncState"
import {
  type DoclingStagedPart,
  type DoclingStagedParts,
  type LoadedPdfDocument,
  PDF_PROCESSING_METHOD,
  type ProcessingResult as PdfProcessingResult,
  PdfProcessor,
} from "@/lib/pdfProcessor"
import { getLogger } from "@/logger"
import { insert, updateDocumentWithOperations } from "@/search/vespa"
import {
  FileProcessorService,
  type SheetProcessingResult,
} from "@/services/fileProcessor"
import { UploadStatus } from "@/shared/types"
import { type ChunkMetadata, ProcessingJobType, Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@xyne/vespa-ts/types"
import { and, eq, isNull } from "drizzle-orm"

const Logger = getLogger(Subsystem.Queue)

function resolveRuntimeStoragePath(storagePath: string): string {
  const runtimeServerRoot =
    process.env.XYNE_CONTAINER_SERVER_ROOT || process.cwd()
  const hostServerRoot = process.env.XYNE_HOST_SERVER_ROOT

  if (hostServerRoot && storagePath.startsWith(hostServerRoot + path.sep)) {
    return path.join(
      runtimeServerRoot,
      path.relative(hostServerRoot, storagePath),
    )
  }

  const marker = "/server/storage/"
  const markerIndex = storagePath.indexOf(marker)
  if (
    markerIndex >= 0 &&
    !storagePath.startsWith(runtimeServerRoot + path.sep)
  ) {
    return path.join(
      runtimeServerRoot,
      storagePath.slice(markerIndex + "/server/".length),
    )
  }

  return storagePath
}

export function mergeCollectionItemMetadata(
  existingMetadata: unknown,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const baseMetadata =
    typeof existingMetadata === "object" && existingMetadata !== null
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {}

  return {
    ...baseMetadata,
    ...updates,
  }
}

function extractMarkdownTitle(content: string): string {
  const lines = content.split("\n")
  let inFrontmatter = false

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine) {
      continue
    }

    if (trimmedLine === "---") {
      inFrontmatter = !inFrontmatter
      continue
    }

    // Look for page_title inside frontmatter
    if (inFrontmatter) {
      if (trimmedLine.startsWith("page_title:")) {
        const title = trimmedLine.substring("page_title:".length).trim()
        if (title) {
          // Remove quotes if present
          return title.replace(/^["']|["']$/g, "").trim()
        }
      }
      continue
    }

    // If we're past frontmatter, stop looking
    break
  }

  return ""
}

export interface FileProcessingJob {
  fileId: string
  type?: ProcessingJobType.FILE // Default type for backward compatibility
  useOCR?: boolean // Whether to use OCR for PDF processing (default: true)
}

export interface CollectionProcessingJob {
  collectionId: string
  type: ProcessingJobType.COLLECTION
}

export interface FolderProcessingJob {
  folderId: string
  type: ProcessingJobType.FOLDER
}

export type ProcessingJob =
  | FileProcessingJob
  | CollectionProcessingJob
  | FolderProcessingJob

// Common retry handling function
async function handleRetryFailure(
  entityType: ProcessingJobType,
  entityId: string,
  currentRetryCount: number,
  errorMessage: string,
  parentId?: string | null,
  collectionId?: string,
) {
  const newRetryCount = currentRetryCount + 1
  const maxRetries = 3 // Match pg-boss retryLimit

  if (newRetryCount >= maxRetries) {
    // Final attempt failed - mark as failed
    const updateData = {
      uploadStatus: UploadStatus.FAILED,
      statusMessage: `Processing failed after ${newRetryCount} attempts: ${errorMessage}`,
      retryCount: newRetryCount,
      updatedAt: new Date(),
    }

    if (entityType === ProcessingJobType.COLLECTION) {
      await db
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, entityId))
    } else {
      await db
        .update(collectionItems)
        .set(updateData)
        .where(eq(collectionItems.id, entityId))

      // If it's a file that failed, trigger parent status update
      if (
        entityType === ProcessingJobType.FILE &&
        parentId !== undefined &&
        collectionId
      ) {
        if (parentId) {
          await updateParentStatus(db, parentId, false)
        } else {
          await updateParentStatus(db, collectionId, true)
        }
      }
    }
  } else {
    // Update retry count but keep status as 'processing' for retries
    const updateData = {
      statusMessage: `Processing attempt ${newRetryCount} failed: ${errorMessage} (will retry)`,
      retryCount: newRetryCount,
      updatedAt: new Date(),
    }

    if (entityType === ProcessingJobType.COLLECTION) {
      await db
        .update(collections)
        .set(updateData)
        .where(eq(collections.id, entityId))
    } else {
      await db
        .update(collectionItems)
        .set(updateData)
        .where(eq(collectionItems.id, entityId))
    }
  }
}

export async function processJob(job: { data: ProcessingJob }) {
  const startTime = Date.now()

  // Debug logging to see what we receive
  Logger.info(`Raw job data: ${JSON.stringify(job.data)}`)

  const jobData = job.data
  const jobType = jobData.type || ProcessingJobType.FILE // Default to file for backward compatibility
  const entityId =
    "fileId" in jobData
      ? jobData.fileId
      : "collectionId" in jobData
        ? jobData.collectionId
        : "folderId" in jobData
          ? jobData.folderId
          : null

  recordWorkerPhase("process_job_dispatch", {
    jobType,
    entityId,
    jobData,
  })

  try {
    switch (jobType) {
      case ProcessingJobType.FILE:
        return await processFileJob(jobData as FileProcessingJob, startTime)
      case ProcessingJobType.COLLECTION:
        return await processCollectionJob(
          jobData as CollectionProcessingJob,
          startTime,
        )
      case ProcessingJobType.FOLDER:
        return await processFolderJob(jobData as FolderProcessingJob, startTime)
      default:
        throw new Error(`Unknown job type: ${jobType}`)
    }
  } finally {
    recordWorkerPhase("process_job_finished", {
      jobType,
      entityId,
      elapsedMs: Date.now() - startTime,
    })
  }
}

type MappedChunkMeta = {
  chunk_index: number
  page_numbers: number[]
  block_labels: string[]
  width: number
  height: number
  bbox_l: number | null
  bbox_t: number | null
  bbox_r: number | null
  bbox_b: number | null
  bboxes_json: string | null
  headings?: string[]
}

const mapChunkMeta = (
  meta: ChunkMetadata,
  includeHeadings = false,
): MappedChunkMeta => {
  const result: MappedChunkMeta = {
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
    result.bbox_l = meta.bbox.l
    result.bbox_t = meta.bbox.t
    result.bbox_r = meta.bbox.r
    result.bbox_b = meta.bbox.b
  }

  if (Array.isArray(meta.bboxes) && meta.bboxes.length > 0) {
    try {
      result.bboxes_json = JSON.stringify(meta.bboxes)
    } catch {
      result.bboxes_json = null
    }
  }

  if (includeHeadings) {
    result.headings = meta.headings || []
  }

  return result
}

export function buildVespaFileName(file: {
  path: string
  fileName: string
  collectionName: string
}): string {
  const targetPath = file.path
  const reconstructedFilePath =
    targetPath === "/" ? file.fileName : targetPath.substring(1) + file.fileName

  return targetPath === "/"
    ? file.collectionName + targetPath + reconstructedFilePath
    : file.collectionName + targetPath + file.fileName
}

function offsetChunkMetadata(
  meta: ChunkMetadata,
  chunkIndex: number,
  pageOffset: number,
): ChunkMetadata {
  return {
    ...meta,
    chunk_index: chunkIndex,
    page_numbers: (meta.page_numbers || []).map((page) => page + pageOffset),
    bboxes: meta.bboxes?.map((bbox) =>
      typeof bbox.page_no === "number"
        ? { ...bbox, page_no: bbox.page_no + pageOffset }
        : bbox,
    ),
  }
}

export async function appendDoclingPartToKbItem(
  docId: string,
  result: PdfProcessingResult,
  metadata: Record<string, unknown>,
  textChunkOffset: number,
  imageChunkOffset: number,
  pageOffset: number,
) {
  const chunkPositions = result.chunks.map(
    (_, index) => textChunkOffset + index,
  )
  const imageChunkPositions = result.image_chunks.map(
    (_, index) => imageChunkOffset + index,
  )

  const fields: Parameters<typeof updateDocumentWithOperations>[2] = {
    metadata: { assign: JSON.stringify(metadata) },
    updatedAt: { assign: Date.now() },
  }

  if (result.chunks.length > 0) {
    fields.chunks = { add: result.chunks }
    fields.chunks_pos = { add: chunkPositions }
    fields.chunks_map = {
      add: result.chunks_map.map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(meta, chunkPositions[index] ?? index, pageOffset),
          true,
        ),
      ),
    }
  }

  if (result.image_chunks.length > 0) {
    fields.image_chunks = { add: result.image_chunks }
    fields.image_chunks_pos = { add: imageChunkPositions }
    fields.image_chunks_map = {
      add: result.image_chunks_map.map((meta, index) =>
        mapChunkMeta(
          offsetChunkMetadata(
            meta,
            imageChunkPositions[index] ?? index,
            pageOffset,
          ),
          false,
        ),
      ),
    }
  }

  if (result.toc_chunks.length > 0) {
    fields.toc_chunks = { add: result.toc_chunks }
  }

  await updateDocumentWithOperations(KbItemsSchema, docId, fields)
}

async function processPdfWithStreamingDocling(
  file: {
    id: string
    storagePath: string
    vespaDocId: string
    fileName: string
    path: string
    parentId: string | null
    mimeType: string | null
    fileSize: number | null
    originalName: string | null
    collectionId: string
    uploadedByEmail: string | null
    collectionName: string
    metadata: unknown
  },
  stagedParts: DoclingStagedParts,
  pageTitle: string,
) {
  const baseMimeType = getBaseMimeType(file.mimeType || "text/plain")
  const vespaFileName = buildVespaFileName(file)
  const totalPages = stagedParts.totalPages
  let chunksCount = 0
  let imageChunksCount = 0
  let tocChunksCount = 0
  let partCount = 0

  const initialMetadata = mergeCollectionItemMetadata(file.metadata, {
    originalFileName: file.originalName || file.fileName,
    uploadedBy: file.uploadedByEmail || "system",
    chunksCount,
    imageChunksCount,
    tocChunksCount,
    processingMethod: baseMimeType,
    pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
    doclingStreaming: true,
    doclingPageChunkSize: config.doclingPageChunkSize,
    ...(pageTitle && { pageTitle }),
    lastModified: Date.now(),
  })

  const vespaDoc = {
    docId: file.vespaDocId,
    clId: file.collectionId,
    itemId: file.id,
    fileName: vespaFileName,
    app: Apps.KnowledgeBase as const,
    entity: KnowledgeBaseEntity.File,
    description: "",
    storagePath: file.storagePath,
    chunks: [],
    chunks_pos: [],
    image_chunks: [],
    image_chunks_pos: [],
    toc_chunks: [],
    chunks_map: [],
    image_chunks_map: [],
    pageTitle,
    metadata: JSON.stringify(initialMetadata),
    createdBy: file.uploadedByEmail || "system",
    duration: 0,
    mimeType: baseMimeType,
    fileSize: file.fileSize || 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    clFd: file.parentId,
  }

  Logger.info(
    {
      fileId: file.id,
      vespaDocId: file.vespaDocId,
      fileName: file.fileName,
      totalPages,
      pageChunkSize: config.doclingPageChunkSize,
    },
    "Streaming Docling initial Vespa document insert starting",
  )
  await insert(vespaDoc, KbItemsSchema)
  Logger.info(
    {
      fileId: file.id,
      vespaDocId: file.vespaDocId,
      fileName: file.fileName,
    },
    "Streaming Docling initial Vespa document insert completed",
  )

  Logger.info(
    {
      fileId: file.id,
      fileName: file.fileName,
      totalPages,
      pageChunkSize: config.doclingPageChunkSize,
    },
    "Streaming Docling page part processing starting",
  )
  try {
    for (const stagedPart of stagedParts.parts) {
      const part = await PdfProcessor.processStagedDoclingPart(stagedPart)
      Logger.info(
        {
          fileId: file.id,
          vespaDocId: file.vespaDocId,
          fileName: file.fileName,
          partIndex: part.partIndex,
          startPage: part.startPage,
          endPage: part.endPage,
          totalPages: part.totalPages,
          textChunks: part.result.chunks.length,
          imageChunks: part.result.image_chunks.length,
          tocChunks: part.result.toc_chunks.length,
          chunksOffset: chunksCount,
          imageChunksOffset: imageChunksCount,
          pageOffset: part.startPage,
        },
        "Streaming Docling part result received; appending to Vespa",
      )

      const nextTextChunksCount = chunksCount + part.result.chunks.length
      const nextImageChunksCount =
        imageChunksCount + part.result.image_chunks.length
      const partMetadata = mergeCollectionItemMetadata(file.metadata, {
        originalFileName: file.originalName || file.fileName,
        uploadedBy: file.uploadedByEmail || "system",
        chunksCount: nextTextChunksCount + nextImageChunksCount,
        imageChunksCount: nextImageChunksCount,
        tocChunksCount: tocChunksCount + part.result.toc_chunks.length,
        processingMethod: baseMimeType,
        pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
        doclingStreaming: true,
        doclingPageChunkSize: config.doclingPageChunkSize,
        doclingPartsProcessed: part.partIndex + 1,
        doclingTotalPages: part.totalPages,
        doclingLastPageProcessed: part.endPage,
        ...(pageTitle && { pageTitle }),
        lastModified: Date.now(),
      })

      await appendDoclingPartToKbItem(
        file.vespaDocId,
        part.result,
        partMetadata,
        chunksCount,
        imageChunksCount,
        part.startPage,
      )
      await PdfProcessor.deleteStagedPart(stagedPart)

      chunksCount += part.result.chunks.length
      imageChunksCount += part.result.image_chunks.length
      tocChunksCount += part.result.toc_chunks.length
      partCount = part.partIndex + 1

      Logger.info(
        {
          fileId: file.id,
          vespaDocId: file.vespaDocId,
          fileName: file.fileName,
          partIndex: part.partIndex,
          partsProcessed: partCount,
          chunksCount,
          imageChunksCount,
          tocChunksCount,
        },
        "Streaming Docling part appended to Vespa",
      )
    }
  } finally {
    await PdfProcessor.cleanupStagedDoclingParts(stagedParts)
  }

  Logger.info(
    {
      fileId: file.id,
      vespaDocId: file.vespaDocId,
      fileName: file.fileName,
      partCount,
      chunksCount,
      imageChunksCount,
      tocChunksCount,
    },
    "Streaming Docling page part processing completed",
  )

  return {
    chunksCount: chunksCount + imageChunksCount,
    imageChunksCount,
    tocChunksCount,
    partCount,
  }
}

async function insertInitialAsyncDoclingVespaDocument(
  file: {
    id: string
    storagePath: string
    vespaDocId: string
    fileName: string
    path: string
    parentId: string | null
    mimeType: string | null
    fileSize: number | null
    originalName: string | null
    collectionId: string
    uploadedByEmail: string | null
    collectionName: string
    metadata: unknown
  },
  pageTitle: string,
  totalPages: number,
  totalParts: number,
) {
  const baseMimeType = getBaseMimeType(file.mimeType || "text/plain")
  const initialMetadata = mergeCollectionItemMetadata(file.metadata, {
    originalFileName: file.originalName || file.fileName,
    uploadedBy: file.uploadedByEmail || "system",
    chunksCount: 0,
    imageChunksCount: 0,
    tocChunksCount: 0,
    processingMethod: baseMimeType,
    pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
    doclingStreaming: true,
    doclingAsync: true,
    doclingPageChunkSize: config.doclingPageChunkSize,
    doclingTotalPages: totalPages,
    doclingTotalParts: totalParts,
    ...(pageTitle && { pageTitle }),
    lastModified: Date.now(),
  })

  const vespaDoc = {
    docId: file.vespaDocId,
    clId: file.collectionId,
    itemId: file.id,
    fileName: buildVespaFileName(file),
    app: Apps.KnowledgeBase as const,
    entity: KnowledgeBaseEntity.File,
    description: "",
    storagePath: file.storagePath,
    chunks: [],
    chunks_pos: [],
    image_chunks: [],
    image_chunks_pos: [],
    toc_chunks: [],
    chunks_map: [],
    image_chunks_map: [],
    pageTitle,
    metadata: JSON.stringify(initialMetadata),
    createdBy: file.uploadedByEmail || "system",
    duration: 0,
    mimeType: baseMimeType,
    fileSize: file.fileSize || 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    clFd: file.parentId,
  }

  await insert(vespaDoc, KbItemsSchema)
}

const isAsyncPartDone = (status?: string) =>
  status === "applied" || status === "completed"

const shouldSkipAsyncPartSubmit = (status?: string) =>
  status === "pending" ||
  status === "submitted" ||
  status === "ready" ||
  status === "applying" ||
  isAsyncPartDone(status)

const hashDoclingAsyncIdentity = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)

export const buildDoclingAsyncRunId = (
  file: {
    id: string
    storagePath: string
    vespaDocId: string
    fileSize: number | null
  },
  stagedParts: DoclingStagedParts,
): string =>
  hashDoclingAsyncIdentity({
    fileId: file.id,
    vespaDocId: file.vespaDocId,
    storagePath: file.storagePath,
    fileSize: file.fileSize ?? stagedParts.sourceSize ?? null,
    sourceSize: stagedParts.sourceSize,
    totalPages: stagedParts.totalPages,
    pageChunkSize: stagedParts.pageChunkSize,
    partsTotal: stagedParts.partsTotal,
    parts: stagedParts.parts.map((part) => ({
      partIndex: part.partIndex,
      startPage: part.startPage,
      endPage: part.endPage,
      totalPages: part.totalPages,
      partSizeBytes: part.partSizeBytes,
    })),
  })

export const buildDoclingAsyncPartFingerprint = (
  runId: string,
  part: DoclingStagedPart,
): string =>
  hashDoclingAsyncIdentity({
    runId,
    partIndex: part.partIndex,
    startPage: part.startPage,
    endPage: part.endPage,
    totalPages: part.totalPages,
    partSizeBytes: part.partSizeBytes,
  })

const partStateMatchesCurrentSplit = (
  partState: Partial<DoclingAsyncPartState> | null,
  runId: string,
  splitFingerprint: string,
) =>
  partState?.runId === runId &&
  partState?.splitFingerprint === splitFingerprint

const stagedPartFromState = (
  state: Partial<DoclingAsyncFileState>,
  partState: Partial<DoclingAsyncPartState>,
  partIndex: number,
): DoclingStagedPart => {
  const partPath = partState.partPath
  if (!partPath) {
    throw new Error(
      `Missing staged part path for file=${state.fileId} part=${partIndex}`,
    )
  }

  const vespaDocId = state.vespaDocId || partState.vespaDocId
  if (!vespaDocId) {
    throw new Error(
      `Missing vespaDocId for file=${state.fileId} part=${partIndex}`,
    )
  }

  return {
    partIndex,
    startPage: numberFromRedis(partState.startPage),
    endPage: numberFromRedis(partState.endPage),
    totalPages: numberFromRedis(
      partState.totalPages,
      numberFromRedis(state.totalPages),
    ),
    partDocId: partState.docId || `${vespaDocId}__docling_part_${partIndex}`,
    partFileName:
      partState.fileName ||
      `${state.fileName || state.fileId}.part-${partIndex}.pdf`,
    partPath,
    partSizeBytes: numberFromRedis(partState.partSizeBytes),
  }
}

export async function submitNextDoclingAsyncPart(
  fileId: string,
): Promise<boolean> {
  const state = await getDoclingAsyncFileState(fileId)
  if (!state) {
    throw new Error(`Missing Docling async file state for ${fileId}`)
  }

  const totalParts = numberFromRedis(state.totalParts)
  const nextPartToSubmit = numberFromRedis(
    state.nextPartToSubmit,
    numberFromRedis(state.nextPartToApply),
  )

  if (nextPartToSubmit >= totalParts) {
    return false
  }

  if (nextPartToSubmit > 0) {
    const previousPart = await getDoclingAsyncPartState(
      fileId,
      nextPartToSubmit - 1,
    )
    if (!isAsyncPartDone(previousPart?.status)) {
      Logger.info(
        {
          fileId,
          nextPartToSubmit,
          previousPartStatus: previousPart?.status,
        },
        "Skipping async Docling part submit until previous part is completed",
      )
      return false
    }
  }

  const partState = await getDoclingAsyncPartState(fileId, nextPartToSubmit)
  if (!partState) {
    throw new Error(
      `Missing Docling async part state for file=${fileId} part=${nextPartToSubmit}`,
    )
  }

  if (shouldSkipAsyncPartSubmit(partState.status)) {
    Logger.info(
      {
        fileId,
        partIndex: nextPartToSubmit,
        status: partState.status,
      },
      "Skipping async Docling part submit because part is already active or done",
    )
    return false
  }

  const stagedPart = stagedPartFromState(state, partState, nextPartToSubmit)
  const submitCount = numberFromRedis(partState.submitCount) + 1
  const vespaDocId = stagedPart.partDocId.split("__docling_part_")[0]
  const jobId =
    partState.jobId ||
    (state.runId
      ? `docling:${fileId}:${vespaDocId}:run:${state.runId}:part:${nextPartToSubmit}:v2`
      : `docling:${fileId}:${vespaDocId}:part:${nextPartToSubmit}:v1`)

  const isInitialPart = nextPartToSubmit === 0
  let activeFileSlotAcquired = false

  try {
    if (isInitialPart) {
      await acquireDoclingActiveFile({
        fileId,
        fileName: state.fileName || stagedPart.partFileName,
      })
      activeFileSlotAcquired = true
    }

    await patchDoclingAsyncPartState(fileId, nextPartToSubmit, {
      status: "pending",
      submitCount: String(submitCount),
      jobId,
      error: "",
    })

    const partBuffer = await PdfProcessor.readStagedPartBuffer(stagedPart)
    await submitDoclingAsyncJob({
      buffer: partBuffer,
      fileName: stagedPart.partFileName,
      jobId,
      fileId,
      docId: stagedPart.partDocId,
      vespaDocId: state.vespaDocId || partState.vespaDocId || "",
    })

    await patchDoclingAsyncPartState(fileId, nextPartToSubmit, {
      status: "submitted",
      submitCount: String(submitCount),
      error: "",
    })
    await patchDoclingAsyncFileState(fileId, {
      status: "submitted",
      nextPartToSubmit: String(nextPartToSubmit + 1),
    })

    recordWorkerPhase("async_docling_part_submitted", {
      fileId,
      fileName: state.fileName,
      jobId,
      partIndex: nextPartToSubmit,
      startPage: stagedPart.startPage,
      endPage: stagedPart.endPage,
      totalParts,
    })

    return true
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    await patchDoclingAsyncPartState(fileId, nextPartToSubmit, {
      status: "queued",
      submitCount: String(submitCount),
      jobId,
      error: errorMessage,
    }).catch((patchError) => {
      Logger.error(
        {
          fileId,
          partIndex: nextPartToSubmit,
          error: getErrorMessage(patchError),
        },
        "Failed to reset async Docling part after submit failure",
      )
    })

    if (activeFileSlotAcquired) {
      await releaseDoclingActiveFile(fileId).catch((releaseError) => {
        Logger.error(
          {
            fileId,
            error: getErrorMessage(releaseError),
          },
          "Failed to release async Docling active-file slot after submit failure",
        )
      })
    }

    throw error
  }
}

async function processPdfWithAsyncSplitDocling(
  file: {
    id: string
    storagePath: string
    vespaDocId: string
    fileName: string
    path: string
    parentId: string | null
    mimeType: string | null
    fileSize: number | null
    originalName: string | null
    collectionId: string
    uploadedByEmail: string | null
    collectionName: string
    metadata: unknown
  },
  stagedParts: DoclingStagedParts,
  pageTitle: string,
) {
  const totalPages = stagedParts.totalPages
  const totalParts = stagedParts.partsTotal
  const now = new Date().toISOString()
  const existingState = await getDoclingAsyncFileState(file.id)
  const runId = buildDoclingAsyncRunId(file, stagedParts)
  const splitFingerprint = hashDoclingAsyncIdentity({
    runId,
    totalPages,
    totalParts,
    pageChunkSize: stagedParts.pageChunkSize,
  })
  const isSameRun =
    existingState?.runId === runId &&
    existingState?.splitFingerprint === splitFingerprint
  const fileState: DoclingAsyncFileState = {
    fileId: file.id,
    vespaDocId: file.vespaDocId,
    runId,
    splitFingerprint,
    fileName: file.fileName,
    collectionId: file.collectionId,
    collectionName: file.collectionName,
    parentId: file.parentId || "",
    path: file.path,
    storagePath: file.storagePath,
    mimeType: file.mimeType || "",
    baseMimeType: getBaseMimeType(file.mimeType || "text/plain"),
    fileSize: String(file.fileSize || 0),
    originalName: file.originalName || "",
    uploadedByEmail: file.uploadedByEmail || "",
    metadataJson: JSON.stringify(file.metadata || {}),
    pageTitle,
    totalPages: String(totalPages),
    totalParts: String(totalParts),
    pageChunkSize: String(stagedParts.pageChunkSize),
    stageDir: stagedParts.stageDir,
    partsDir: stagedParts.partsDir,
    nextPartToApply: isSameRun ? existingState?.nextPartToApply || "0" : "0",
    nextPartToSubmit: isSameRun
      ? existingState?.nextPartToSubmit || existingState?.nextPartToApply || "0"
      : "0",
    textChunksCount: isSameRun ? existingState?.textChunksCount || "0" : "0",
    imageChunksCount: isSameRun ? existingState?.imageChunksCount || "0" : "0",
    tocChunksCount: isSameRun ? existingState?.tocChunksCount || "0" : "0",
    status: "submitting",
    initialVespaInserted: isSameRun
      ? existingState?.initialVespaInserted || "false"
      : "false",
    createdAt: existingState?.createdAt || now,
    updatedAt: now,
  }

  await setDoclingAsyncFileState(fileState)

  if (fileState.initialVespaInserted !== "true") {
    recordWorkerPhase("async_docling_initial_vespa_insert_start", {
      fileId: file.id,
      fileName: file.fileName,
      vespaDocId: file.vespaDocId,
      totalPages,
      totalParts,
    })
    await insertInitialAsyncDoclingVespaDocument(
      file,
      pageTitle,
      totalPages,
      totalParts,
    )
    await patchDoclingAsyncFileState(file.id, {
      initialVespaInserted: "true",
    })
    recordWorkerPhase("async_docling_initial_vespa_insert_done", {
      fileId: file.id,
      fileName: file.fileName,
      vespaDocId: file.vespaDocId,
    })
  }

  const currentPartIndexes = new Set(
    stagedParts.parts.map((part) => part.partIndex),
  )
  for (const partIndex of await listDoclingAsyncPartIndexes(file.id)) {
    if (!currentPartIndexes.has(partIndex)) {
      await deleteDoclingAsyncPartState(file.id, partIndex)
    }
  }

  for (const part of stagedParts.parts) {
    const existingPart = await getDoclingAsyncPartState(file.id, part.partIndex)
    const partFingerprint = buildDoclingAsyncPartFingerprint(runId, part)
    const canReusePart = partStateMatchesCurrentSplit(
      existingPart,
      runId,
      partFingerprint,
    )
    const jobId = canReusePart
      ? existingPart?.jobId ||
        `docling:${file.id}:${file.vespaDocId}:run:${runId}:part:${part.partIndex}:v2`
      : `docling:${file.id}:${file.vespaDocId}:run:${runId}:part:${part.partIndex}:v2`
    if (!canReusePart) {
      await deleteDoclingAsyncPartState(file.id, part.partIndex)
    }
    await patchDoclingAsyncPartState(file.id, part.partIndex, {
      fileId: file.id,
      vespaDocId: file.vespaDocId,
      runId,
      splitFingerprint: partFingerprint,
      jobId,
      docId: part.partDocId,
      partIndex: String(part.partIndex),
      startPage: String(part.startPage),
      endPage: String(part.endPage),
      totalPages: String(part.totalPages),
      totalParts: String(totalParts),
      fileName: part.partFileName,
      partPath: part.partPath,
      partSizeBytes: String(part.partSizeBytes),
      status: canReusePart ? existingPart?.status || "queued" : "queued",
      resultKey: canReusePart ? existingPart?.resultKey || "" : "",
      eventId: canReusePart ? existingPart?.eventId || "" : "",
      error: canReusePart ? existingPart?.error || "" : "",
      submitCount: canReusePart ? existingPart?.submitCount || "0" : "0",
      createdAt: canReusePart
        ? existingPart?.createdAt || new Date().toISOString()
        : new Date().toISOString(),
      appliedAt: canReusePart ? existingPart?.appliedAt || "" : "",
    })
  }

  let submittedNextPart = false
  try {
    submittedNextPart = await submitNextDoclingAsyncPart(file.id)
  } catch (error) {
    await PdfProcessor.cleanupStagedDoclingParts(stagedParts)
    throw error
  }
  await expireDoclingAsyncKeys(file.id, totalParts)

  const dbMetadata = mergeCollectionItemMetadata(file.metadata, {
    pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
    doclingStreaming: true,
    doclingAsync: true,
    doclingPageChunkSize: stagedParts.pageChunkSize,
    doclingTotalPages: totalPages,
    doclingTotalParts: totalParts,
    doclingSubmittedParts: submittedNextPart ? 1 : 0,
  })

  await db
    .update(collectionItems)
    .set({
      uploadStatus: UploadStatus.PROCESSING,
      statusMessage: `Submitted next PDF part to Docling async for ${file.fileName}`,
      metadata: dbMetadata,
      updatedAt: new Date(),
    })
    .where(eq(collectionItems.id, file.id))
}

async function processFileJob(jobData: FileProcessingJob, startTime: number) {
  const { fileId } = jobData

  // Get file details for processing with collection info (outside try block for error handling access)
  const fileDetails = await db
    .select({
      id: collectionItems.id,
      type: collectionItems.type,
      storagePath: collectionItems.storagePath,
      vespaDocId: collectionItems.vespaDocId,
      uploadStatus: collectionItems.uploadStatus,
      fileName: collectionItems.name,
      path: collectionItems.path,
      parentId: collectionItems.parentId,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
      originalName: collectionItems.originalName,
      collectionId: collectionItems.collectionId,
      uploadedByEmail: collectionItems.uploadedByEmail,
      uploadedById: collectionItems.uploadedById,
      retryCount: collectionItems.retryCount,
      collectionName: collections.name,
      metadata: collectionItems.metadata,
    })
    .from(collectionItems)
    .innerJoin(collections, eq(collectionItems.collectionId, collections.id))
    .where(eq(collectionItems.id, fileId))
    .limit(1)

  if (!fileDetails.length) {
    Logger.warn(`File not found: ${fileId}`)
    return
  }

  const file = fileDetails[0]
  recordWorkerPhase("file_details_loaded", {
    fileId,
    fileName: file.fileName,
    storagePath: file.storagePath,
    mimeType: file.mimeType,
    fileSize: file.fileSize,
    uploadStatus: file.uploadStatus,
    vespaDocId: file.vespaDocId,
  })

  // Guard: only process real files
  if (file.type !== "file") {
    Logger.warn(`Item is not a file: ${fileId}`)
    return
  }

  try {
    Logger.info(`Processing file job: ${fileId}`)

    // Skip if already processed
    if (file.uploadStatus === UploadStatus.COMPLETED) {
      Logger.info(`File already processed: ${fileId}`)
      recordWorkerPhase("file_already_completed", {
        fileId,
        fileName: file.fileName,
      })
      return
    }

    recordWorkerPhase("file_status_update_start", {
      fileId,
      fileName: file.fileName,
    })
    // Update status to processing
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing file: ${file.fileName}`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
    recordWorkerPhase("file_status_update_done", {
      fileId,
      fileName: file.fileName,
    })

    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        storagePath: file.storagePath,
      },
      "File job status set to PROCESSING",
    )
    Logger.info(`Processing file: ${file.fileName} at ${file.storagePath}`)

    // Check required fields
    if (!file.storagePath) {
      throw new Error(`No storage path for file: ${fileId}`)
    }

    if (!file.vespaDocId) {
      throw new Error(`No vespaDocId for file: ${fileId}`)
    }

    const runtimeStoragePath = resolveRuntimeStoragePath(file.storagePath)
    if (runtimeStoragePath !== file.storagePath) {
      Logger.warn(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
        },
        "Remapped storage path for container runtime",
      )
    }
    const baseMimeType = getBaseMimeType(file.mimeType || "text/plain")
    const useOCR = jobData.useOCR !== false
    const asyncDoclingPdfPath =
      baseMimeType === "application/pdf" &&
      useOCR &&
      config.doclingEnabled &&
      config.doclingAsyncEnabled

    let fileBuffer: Buffer | null = null
    if (asyncDoclingPdfPath) {
      recordWorkerPhase("read_file_skipped", {
        fileId,
        fileName: file.fileName,
        runtimeStoragePath,
        reason: "async_docling_qpdf_staging_uses_file_path",
      })
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
          expectedSizeBytes: file.fileSize,
        },
        "Skipping full PDF read before async Docling qpdf staging",
      )
    } else {
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          expectedSizeBytes: file.fileSize,
        },
        "Reading file from disk for processing",
      )
      recordWorkerPhase("read_file_start", {
        fileId,
        fileName: file.fileName,
        storagePath: file.storagePath,
        runtimeStoragePath,
        expectedSizeBytes: file.fileSize,
      })
      fileBuffer = await readFile(runtimeStoragePath)
      recordWorkerPhase("read_file_done", {
        fileId,
        fileName: file.fileName,
        runtimeStoragePath,
        fileBufferBytes: fileBuffer.length,
      })
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
          fileBufferBytes: fileBuffer.length,
        },
        "File read completed",
      )
    }

    // Extract title for markdown files
    let pageTitle: string = ""
    if (baseMimeType === "text/markdown" && fileBuffer) {
      try {
        const fileContent = fileBuffer.toString("utf-8")
        pageTitle = extractMarkdownTitle(fileContent)
      } catch (error) {
        Logger.warn(
          `Failed to extract title from markdown file ${file.fileName}: ${getErrorMessage(error)}`,
        )
      }

      // If we failed to get pageTitle from content, use filename as fallback
      if (!pageTitle) {
        pageTitle = ""
        Logger.info(
          `Using empty string as pageTitle for ${file.fileName}: ${pageTitle}`,
        )
      }
    }

    // Process file to extract content
    // Get useOCR from job data (default to true for backward compatibility)
    let fallbackUseOCR = useOCR
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        baseMimeType,
        useOCR,
        doclingEnabled: config.doclingEnabled,
        doclingPageChunkSize: config.doclingPageChunkSize,
        imageContextEnabled: IMAGE_CONTEXT_CONFIG.enabled,
      },
      "File processing mode selected",
    )
    if (baseMimeType === "application/pdf" && useOCR && config.doclingEnabled) {
      if (config.doclingAsyncEnabled && config.doclingAsyncSchedulerEnabled) {
        const { sourceKind, basePriority } = inferDoclingSourcePriority({
          collectionId: file.collectionId,
          parentId: file.parentId,
          metadata: file.metadata,
        })
        const schedulerSource = buildDoclingSchedulerSourceReference(
          runtimeStoragePath,
        )

        const schedulerFile = await upsertDoclingAsyncFileForSplit({
          fileId,
          vespaDocId: file.vespaDocId,
          collectionId: file.collectionId,
          parentId: file.parentId,
          collectionName: file.collectionName,
          fileName: file.fileName,
          originalName: file.originalName,
          sourcePath: schedulerSource.sourcePath,
          sourceStorageKey: schedulerSource.sourceStorageKey,
          path: file.path,
          mimeType: file.mimeType || "application/pdf",
          baseMimeType,
          fileSize: file.fileSize || 0,
          uploadedByEmail: file.uploadedByEmail,
          pageTitle,
          metadata:
            typeof file.metadata === "object" && file.metadata !== null
              ? (file.metadata as Record<string, unknown>)
              : {},
          sourceKind,
          basePriority,
          priorityOverride: null,
          totalPages: 0,
          totalParts: 0,
          pageChunkSize: config.doclingPageChunkSize,
        })

        if (!schedulerFile) {
          recordWorkerPhase("async_docling_scheduler_duplicate_ignored", {
            fileId,
            fileName: file.fileName,
          })
          Logger.info(
            { fileId, fileName: file.fileName },
            "Skipped async Docling scheduler enqueue because file is already active or completed",
          )
          return
        }

        await db
          .update(collectionItems)
          .set({
            uploadStatus: UploadStatus.PROCESSING,
            statusMessage: `Queued PDF for async Docling scheduler: ${file.fileName}`,
            metadata: mergeCollectionItemMetadata(file.metadata, {
              pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
              doclingAsyncScheduler: true,
              doclingPageChunkSize: config.doclingPageChunkSize,
            }),
            updatedAt: new Date(),
          })
          .where(eq(collectionItems.id, fileId))

        recordWorkerPhase("async_docling_scheduler_queued", {
          fileId,
          fileName: file.fileName,
          sourceKind,
          basePriority,
        })
        Logger.info(
          { fileId, fileName: file.fileName, sourceKind, basePriority },
          "Queued PDF for async Docling scheduler",
        )
        return
      }

      const fileBufferBytes = fileBuffer?.length ?? file.fileSize ?? null
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          fileBufferBytes,
          runtimeStoragePath,
          asyncDoclingPdfPath,
        },
        "Counting PDF pages for Docling streaming eligibility check",
      )
      recordWorkerPhase("pdf_page_count_start", {
        fileId,
        fileName: file.fileName,
        fileBufferBytes,
        pageChunkSize: config.doclingPageChunkSize,
        doclingStreamingMinPages: config.doclingStreamingMinPages,
      })
      const loadedPdfMetadata = await PdfProcessor.loadDocumentMetadataFromFile(
        runtimeStoragePath,
        {
          fileId,
          fileName: file.fileName,
        },
      )
      const pageCount = loadedPdfMetadata?.pageCount ?? null
      const shouldStream =
        loadedPdfMetadata && PdfProcessor.shouldStreamWithDocling(pageCount)
      recordWorkerPhase("pdf_page_count_done", {
        fileId,
        fileName: file.fileName,
        pageCount,
        pageChunkSize: config.doclingPageChunkSize,
        doclingStreamingMinPages: config.doclingStreamingMinPages,
        shouldStream,
      })

      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          pageCount,
          pageChunkSize: config.doclingPageChunkSize,
          doclingStreamingMinPages: config.doclingStreamingMinPages,
          shouldStream,
        },
        "PDF Docling streaming eligibility check completed",
      )

      if (!loadedPdfMetadata && config.doclingAsyncEnabled) {
        throw new Error(
          `Failed to load PDF for async Docling processing: ${file.fileName}`,
        )
      }

      if (loadedPdfMetadata && config.doclingAsyncEnabled) {
        Logger.info(
          {
            fileId,
            fileName: file.fileName,
            pageCount,
            pageChunkSize: config.doclingPageChunkSize,
          },
          "Using async split Docling PDF ingestion",
        )
        recordWorkerPhase("async_docling_split_start", {
          fileId,
          fileName: file.fileName,
          pageCount,
          pageChunkSize: config.doclingPageChunkSize,
        })
        fileBuffer = null
        recordWorkerPhase("docling_stage_start", {
          fileId,
          fileName: file.fileName,
          pageCount,
          pageChunkSize: config.doclingPageChunkSize,
          mode: "async",
        })
        const stagedParts = await PdfProcessor.stageDoclingPagePartsFromFile({
          fileId,
          sourcePath: runtimeStoragePath,
          fileName: file.fileName,
          vespaDocId: file.vespaDocId,
          pageChunkSize: config.doclingPageChunkSize,
          knownTotalPages: pageCount,
        })
        recordWorkerPhase("docling_stage_done", {
          fileId,
          fileName: file.fileName,
          pageCount,
          pageChunkSize: config.doclingPageChunkSize,
          partsTotal: stagedParts.partsTotal,
          stageDir: stagedParts.stageDir,
          mode: "async",
        })
        await processPdfWithAsyncSplitDocling(
          {
            ...file,
            storagePath: runtimeStoragePath,
            vespaDocId: file.vespaDocId,
          },
          stagedParts,
          pageTitle,
        )
        recordWorkerPhase("async_docling_split_submitted", {
          fileId,
          fileName: file.fileName,
          pageCount,
          pageChunkSize: config.doclingPageChunkSize,
        })
        const endTime = Date.now()
        Logger.info(
          `Submitted async split Docling file: ${fileId} in ${endTime - startTime}ms`,
        )
        return
      }

      let resolvedPdfDocumentForStreaming: LoadedPdfDocument | null = null
      if (shouldStream && !config.doclingAsyncEnabled) {
        if (!fileBuffer) {
          throw new Error(`Missing PDF buffer for streaming Docling: ${fileId}`)
        }
        resolvedPdfDocumentForStreaming = await PdfProcessor.loadDocument(
          fileBuffer,
          {
            fileId,
            fileName: file.fileName,
          },
        )
      }

      if (resolvedPdfDocumentForStreaming && shouldStream) {
        try {
          Logger.info(
            {
              fileId,
              fileName: file.fileName,
              pageCount,
              pageChunkSize: config.doclingPageChunkSize,
            },
            "Using streaming Docling PDF ingestion",
          )
          recordWorkerPhase("streaming_docling_start", {
            fileId,
            fileName: file.fileName,
            pageCount,
            pageChunkSize: config.doclingPageChunkSize,
          })

          fileBuffer = null
          Logger.info(
            {
              fileId,
              fileName: file.fileName,
              pageCount,
            },
            "Released original PDF buffer before streaming Docling processing",
          )
          recordWorkerPhase("docling_stage_start", {
            fileId,
            fileName: file.fileName,
            pageCount,
            pageChunkSize: config.doclingPageChunkSize,
            mode: "streaming",
          })
          const stagedParts = await PdfProcessor.stageDoclingPageParts({
            fileId,
            source: resolvedPdfDocumentForStreaming,
            sourcePath: runtimeStoragePath,
            fileName: file.fileName,
            vespaDocId: file.vespaDocId,
            pageChunkSize: config.doclingPageChunkSize,
            knownTotalPages: pageCount,
          })
          recordWorkerPhase("docling_stage_done", {
            fileId,
            fileName: file.fileName,
            pageCount,
            pageChunkSize: config.doclingPageChunkSize,
            partsTotal: stagedParts.partsTotal,
            stageDir: stagedParts.stageDir,
            mode: "streaming",
          })
          const streamResult = await processPdfWithStreamingDocling(
            {
              ...file,
              storagePath: runtimeStoragePath,
              vespaDocId: file.vespaDocId,
            },
            stagedParts,
            pageTitle,
          )
          recordWorkerPhase("streaming_docling_done", {
            fileId,
            fileName: file.fileName,
            chunksCount: streamResult.chunksCount,
            imageChunksCount: streamResult.imageChunksCount,
            tocChunksCount: streamResult.tocChunksCount,
            partCount: streamResult.partCount,
          })

          const dbMetadata = mergeCollectionItemMetadata(file.metadata, {
            chunksCount: streamResult.chunksCount,
            imageChunksCount: streamResult.imageChunksCount,
            tocChunksCount: streamResult.tocChunksCount,
            pdfProcessingMethod: PDF_PROCESSING_METHOD.DOCLING,
            doclingStreaming: true,
            doclingPageChunkSize: config.doclingPageChunkSize,
            doclingPartsProcessed: streamResult.partCount,
          })

          recordWorkerPhase("streaming_completion_update_start", {
            fileId,
            fileName: file.fileName,
            chunksCount: streamResult.chunksCount,
            imageChunksCount: streamResult.imageChunksCount,
            partCount: streamResult.partCount,
          })
          await db
            .update(collectionItems)
            .set({
              vespaDocId: file.vespaDocId,
              uploadStatus: UploadStatus.COMPLETED,
              statusMessage: `Successfully processed: ${streamResult.chunksCount} chunks extracted from ${file.fileName}`,
              metadata: dbMetadata,
              processedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(collectionItems.id, fileId))
          recordWorkerPhase("streaming_completion_update_done", {
            fileId,
            fileName: file.fileName,
            chunksCount: streamResult.chunksCount,
            imageChunksCount: streamResult.imageChunksCount,
            partCount: streamResult.partCount,
          })

          if (file.parentId) {
            await updateParentStatus(db, file.parentId, false)
          } else {
            await updateParentStatus(db, file.collectionId, true)
          }

          const endTime = Date.now()
          Logger.info(
            `Successfully processed file with streaming Docling: ${fileId} in ${endTime - startTime}ms`,
          )
          return
        } catch (error) {
          resolvedPdfDocumentForStreaming = null
          recordWorkerPhase("streaming_docling_failed", {
            fileId,
            fileName: file.fileName,
            error,
            fallbackDisabled: config.pdfProcessingDisableFallbacks,
          })
          if (config.pdfProcessingDisableFallbacks) {
            throw error
          }

          Logger.warn(
            error,
            `Streaming Docling PDF processing failed for ${file.fileName}, falling back without OCR`,
          )
          fallbackUseOCR = false
          Logger.info(
            {
              fileId,
              fileName: file.fileName,
              storagePath: file.storagePath,
              runtimeStoragePath,
            },
            "Re-reading file from disk for non-streaming fallback processing",
          )
          recordWorkerPhase("fallback_read_file_start", {
            fileId,
            fileName: file.fileName,
            runtimeStoragePath,
          })
          fileBuffer = await readFile(runtimeStoragePath)
          recordWorkerPhase("fallback_read_file_done", {
            fileId,
            fileName: file.fileName,
            fileBufferBytes: fileBuffer.length,
          })
          Logger.info(
            {
              fileId,
              fileName: file.fileName,
              fileBufferBytes: fileBuffer.length,
            },
            "Fallback file read completed",
          )
        }
      }
    }

    if (!fileBuffer) {
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          storagePath: file.storagePath,
          runtimeStoragePath,
        },
        "Re-reading file from disk for standard processing",
      )
      recordWorkerPhase("standard_read_file_start", {
        fileId,
        fileName: file.fileName,
        runtimeStoragePath,
      })
      fileBuffer = await readFile(runtimeStoragePath)
      recordWorkerPhase("standard_read_file_done", {
        fileId,
        fileName: file.fileName,
        fileBufferBytes: fileBuffer.length,
      })
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          fileBufferBytes: fileBuffer.length,
        },
        "Standard processing file read completed",
      )
    }

    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        baseMimeType,
        fallbackUseOCR,
        extractImages: IMAGE_CONTEXT_CONFIG.enabled,
        describeImages: IMAGE_CONTEXT_CONFIG.enabled,
        fileBufferBytes: fileBuffer.length,
      },
      "Standard file processor starting",
    )
    recordWorkerPhase("standard_processor_start", {
      fileId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      baseMimeType,
      fallbackUseOCR,
      fileBufferBytes: fileBuffer.length,
    })
    const processingResults = await FileProcessorService.processFile(
      fileBuffer,
      file.mimeType || "application/octet-stream",
      file.fileName,
      file.vespaDocId || "",
      runtimeStoragePath,
      IMAGE_CONTEXT_CONFIG.enabled, // extractImages
      IMAGE_CONTEXT_CONFIG.enabled, // describeImages
      fallbackUseOCR, // useOCR option
    )
    recordWorkerPhase("standard_processor_done", {
      fileId,
      fileName: file.fileName,
      resultsCount: processingResults.length,
    })
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        resultsCount: processingResults.length,
      },
      "Standard file processor completed",
    )

    // Handle multiple processing results (e.g., for spreadsheets with multiple sheets)
    let totalChunksCount = 0
    let newVespaDocId = ""
    if (processingResults.length > 0 && "totalSheets" in processingResults[0]) {
      newVespaDocId = `${file.vespaDocId}_sheet_${(processingResults[0] as SheetProcessingResult).totalSheets}`
    } else {
      newVespaDocId = file.vespaDocId
    }
    for (const [resultIndex, processingResult] of processingResults.entries()) {
      // Create Vespa document with proper fileName (matching original logic)
      const targetPath = file.path

      // Reconstruct the original filePath (full path from collection root)
      const reconstructedFilePath =
        targetPath === "/"
          ? file.fileName
          : targetPath.substring(1) + file.fileName // Remove leading "/" and add filename

      let vespaFileName =
        targetPath === "/"
          ? file.collectionName + targetPath + reconstructedFilePath // Uses full path for root
          : file.collectionName + targetPath + file.fileName // Uses filename for nested

      // For sheet processing results, append sheet information to fileName
      let docId = file.vespaDocId
      if ("sheetName" in processingResult) {
        const sheetResult = processingResult as SheetProcessingResult
        vespaFileName =
          processingResults.length > 1
            ? `${vespaFileName} / ${sheetResult.sheetName}`
            : vespaFileName
        docId = sheetResult.docId
      } else if (processingResults.length > 1) {
        // For non-sheet files with multiple results, append index
        vespaFileName = `${vespaFileName} (${resultIndex + 1})`
        docId = `${file.vespaDocId}_${resultIndex}`
      }

      const vespaDoc = {
        docId: docId,
        clId: file.collectionId,
        itemId: file.id,
        fileName: vespaFileName,
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.File,
        description: "",
        storagePath: file.storagePath,
        chunks: processingResult.chunks,
        chunks_pos: processingResult.chunks_pos,
        image_chunks: processingResult.image_chunks,
        image_chunks_pos: processingResult.image_chunks_pos,
        toc_chunks: processingResult.toc_chunks || [],
        chunks_map: processingResult.chunks_map?.map((meta) =>
          mapChunkMeta(meta, true),
        ),
        image_chunks_map: processingResult.image_chunks_map?.map((meta) =>
          mapChunkMeta(meta, false),
        ),
        pageTitle: pageTitle,
        documentOutline: processingResult.documentOutline,
        metadata: JSON.stringify(
          mergeCollectionItemMetadata(file.metadata, {
            originalFileName: file.originalName || file.fileName,
            uploadedBy: file.uploadedByEmail || "system",
            chunksCount:
              processingResult.chunks.length +
              processingResult.image_chunks.length,
            imageChunksCount: processingResult.image_chunks.length,
            tocChunksCount: (processingResult.toc_chunks || []).length,
            processingMethod: getBaseMimeType(file.mimeType || "text/plain"),
            ...(processingResult.processingMethod && {
              pdfProcessingMethod: processingResult.processingMethod,
            }),
            ...(pageTitle && { pageTitle }),
            lastModified: Date.now(),
            ...("sheetName" in processingResult && {
              sheetName: (processingResult as SheetProcessingResult).sheetName,
              sheetIndex: (processingResult as SheetProcessingResult)
                .sheetIndex,
              totalSheets: (processingResult as SheetProcessingResult)
                .totalSheets,
            }),
          }),
        ),
        createdBy: file.uploadedByEmail || "system",
        duration: 0,
        mimeType: getBaseMimeType(file.mimeType || "text/plain"),
        fileSize: file.fileSize || 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clFd: file.parentId,
      }

      // Insert into Vespa
      recordWorkerPhase("vespa_insert_start", {
        fileId,
        fileName: file.fileName,
        docId,
        resultIndex,
        chunksCount: processingResult.chunks.length,
        imageChunksCount: processingResult.image_chunks.length,
      })
      await insert(vespaDoc, KbItemsSchema)
      recordWorkerPhase("vespa_insert_done", {
        fileId,
        fileName: file.fileName,
        docId,
        resultIndex,
      })

      totalChunksCount +=
        processingResult.chunks.length + processingResult.image_chunks.length
    }

    // Update status to completed with processing method metadata
    const chunksCount = totalChunksCount

    // Prepare metadata for database record - use last processing result for method info
    const lastResult = processingResults[processingResults.length - 1]
    const dbMetadata = mergeCollectionItemMetadata(file.metadata, {
      chunksCount,
      imageChunksCount: processingResults.reduce(
        (sum, r) => sum + r.image_chunks.length,
        0,
      ),
      ...(lastResult.processingMethod && {
        pdfProcessingMethod: lastResult.processingMethod,
      }),
    })

    recordWorkerPhase("file_completion_update_start", {
      fileId,
      fileName: file.fileName,
      chunksCount,
      newVespaDocId,
    })
    await db
      .update(collectionItems)
      .set({
        vespaDocId: newVespaDocId,
        uploadStatus: UploadStatus.COMPLETED,
        statusMessage: `Successfully processed: ${chunksCount} chunks extracted from ${file.fileName}`,
        metadata: dbMetadata,
        processedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
    recordWorkerPhase("file_completion_update_done", {
      fileId,
      fileName: file.fileName,
      chunksCount,
      newVespaDocId,
    })

    // Trigger parent status update after file completion
    if (file.parentId) {
      await updateParentStatus(db, file.parentId, false)
    } else {
      await updateParentStatus(db, file.collectionId, true)
    }

    const endTime = Date.now()
    Logger.info(
      `Successfully processed file: ${fileId} in ${endTime - startTime}ms`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    recordWorkerPhase("file_processing_failed", {
      fileId,
      fileName: file.fileName,
      error,
      errorMessage,
      elapsedMs: Date.now() - startTime,
    })
    Logger.error(error, `Failed to process file: ${fileId} - ${errorMessage}`)

    // Use common retry handling function
    await handleRetryFailure(
      ProcessingJobType.FILE,
      fileId,
      file.retryCount || 0,
      errorMessage,
      file.parentId,
      file.collectionId,
    )

    throw error // Let pg-boss handle retries
  }
}

async function processCollectionJob(
  jobData: CollectionProcessingJob,
  startTime: number,
) {
  const { collectionId } = jobData

  // Get collection details first (outside try block for error handling access)
  const collection = await db
    .select({
      id: collections.id,
      name: collections.name,
      description: collections.description,
      vespaDocId: collections.vespaDocId,
      lastUpdatedByEmail: collections.lastUpdatedByEmail,
      metadata: collections.metadata,
      retryCount: collections.retryCount,
    })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1)

  if (!collection.length) {
    Logger.warn(`Collection not found: ${collectionId}`)
    return
  }

  const col = collection[0]

  try {
    Logger.info(`Processing collection Vespa insertion: ${collectionId}`)

    // Update status to processing
    await db
      .update(collections)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing collection: ${col.name}`,
        updatedAt: new Date(),
      })
      .where(eq(collections.id, collectionId))

    // Create Vespa document for collection
    const vespaDoc = {
      docId: col.vespaDocId,
      clId: col.id,
      itemId: col.id,
      fileName: col.name,
      app: Apps.KnowledgeBase as const,
      entity: KnowledgeBaseEntity.Collection,
      description: col.description || "",
      storagePath: "",
      chunks: [],
      image_chunks: [],
      chunks_pos: [],
      image_chunks_pos: [],
      chunks_map: [],
      image_chunks_map: [],
      metadata: JSON.stringify({
        version: "1.0",
        lastModified: Date.now(),
        ...(typeof col.metadata === "object" && col.metadata
          ? col.metadata
          : {}),
      }),
      createdBy: col.lastUpdatedByEmail || "system",
      duration: 0,
      mimeType: "knowledge_base",
      fileSize: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clFd: null,
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)

    // Keep collection in PROCESSING status
    // It will be updated to COMPLETED only when child files/folders complete
    // This prevents race condition where collection is marked complete before children are added

    const endTime = Date.now()
    Logger.info(
      `Successfully processed collection Vespa insertion: ${collectionId} in ${endTime - startTime}ms (waiting for children to complete)`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Failed to process collection Vespa insertion: ${collectionId} - ${errorMessage}`,
    )

    // Use common retry handling function with existing collection data
    await handleRetryFailure(
      ProcessingJobType.COLLECTION,
      collectionId,
      col.retryCount || 0,
      errorMessage,
    )

    throw error // Let pg-boss handle retries
  }
}

async function processFolderJob(
  jobData: FolderProcessingJob,
  startTime: number,
) {
  const { folderId } = jobData

  // Get folder details first (outside try block for error handling access)
  const folder = await db
    .select({
      id: collectionItems.id,
      name: collectionItems.name,
      type: collectionItems.type,
      vespaDocId: collectionItems.vespaDocId,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
      lastUpdatedByEmail: collectionItems.lastUpdatedByEmail,
      metadata: collectionItems.metadata,
      retryCount: collectionItems.retryCount,
    })
    .from(collectionItems)
    .where(eq(collectionItems.id, folderId))
    .limit(1)

  if (!folder.length) {
    Logger.warn(`Folder not found: ${folderId}`)
    return
  }

  const fol = folder[0]

  if (fol.type !== "folder") {
    Logger.warn(`Item is not a folder: ${folderId}`)
    return
  }

  try {
    Logger.info(`Processing folder Vespa insertion: ${folderId}`)

    // Check required fields
    if (!fol.vespaDocId) {
      throw new Error(`No vespaDocId for folder: ${folderId}`)
    }

    // Update status to processing
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing folder: ${fol.name}`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, folderId))

    // Create Vespa document for folder
    const vespaDoc = {
      docId: fol.vespaDocId,
      clId: fol.collectionId,
      itemId: fol.id,
      app: Apps.KnowledgeBase as const,
      fileName: fol.name,
      entity: KnowledgeBaseEntity.Folder,
      description: (fol.metadata as any)?.description || "",
      storagePath: "",
      chunks: [],
      image_chunks: [],
      chunks_pos: [],
      image_chunks_pos: [],
      chunks_map: [],
      image_chunks_map: [],
      metadata: JSON.stringify({
        version: "1.0",
        lastModified: Date.now(),
        tags: (fol.metadata as any)?.tags || [],
      }),
      createdBy: fol.lastUpdatedByEmail || "system",
      duration: 0,
      mimeType: "folder",
      fileSize: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      clFd: fol.parentId || null,
    }

    // Insert into Vespa
    await insert(vespaDoc, KbItemsSchema)
    const endTime = Date.now()
    Logger.info(
      `Successfully processed folder Vespa insertion: ${folderId} in ${endTime - startTime}ms (waiting for children to complete)`,
    )
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    Logger.error(
      error,
      `Failed to process folder Vespa insertion: ${folderId} - ${errorMessage}`,
    )

    // Use common retry handling function with existing folder data
    await handleRetryFailure(
      ProcessingJobType.FOLDER,
      folderId,
      fol.retryCount || 0,
      errorMessage,
    )

    throw error // Let pg-boss handle retries
  }
}
