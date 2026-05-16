import { spawn } from "node:child_process"
import { readFile, unlink, writeFile } from "node:fs/promises"
import config, { IMAGE_CONTEXT_CONFIG, NAMESPACE } from "@/config"
import { db } from "@/db/client"
import { updateParentStatus } from "@/db/knowledgeBase"
import { collectionItems, collections } from "@/db/schema"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { getLogger } from "@/logger"
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
const VESPA_INSERT_TIMEOUT_MS = 120_000

type CurlResult = {
  stdout: string
  stderr: string
  exitCode: number | null
}

function runCurl(args: string[], timeoutMs: number): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    const child = spawn("curl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`curl timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (exitCode) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode,
      })
    })
  })
}

async function insertKbItemDocument(
  document: Record<string, unknown>,
  schema: string,
): Promise<void> {
  const docId = String(document.docId)
  const url = new URL(
    `${config.vespaEndpoint.feedEndpoint}/document/v1/${NAMESPACE}/${schema}/docid/${encodeURIComponent(docId)}`,
  )
  const requestStart = Date.now()
  const tempFilePath = `/tmp/xyne-vespa-${docId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}.json`
  const curlStatusMarker = "\nXYNE_CURL_STATUS:"

  Logger.info(
    {
      docId,
      schema,
      chunks: Array.isArray(document.chunks) ? document.chunks.length : 0,
      imageChunks: Array.isArray(document.image_chunks)
        ? document.image_chunks.length
        : 0,
      tocChunks: Array.isArray(document.toc_chunks)
        ? document.toc_chunks.length
        : 0,
    },
    "File processing stage: direct Vespa insert serialization starting",
  )
  const serializeStart = Date.now()
  const body = JSON.stringify({ fields: document })
  const bodyBytes = Buffer.byteLength(body)
  Logger.info(
    {
      docId,
      schema,
      bodyBytes,
      durationMs: Date.now() - serializeStart,
    },
    "File processing stage: direct Vespa insert serialization complete",
  )

  Logger.info(
    {
      docId,
      schema,
      url: url.toString(),
      bodyBytes,
      timeoutMs: VESPA_INSERT_TIMEOUT_MS,
    },
    "File processing stage: direct Vespa insert request starting",
  )

  await writeFile(tempFilePath, body)
  try {
    const curlResult = await runCurl(
      [
        "-sS",
        "--fail-with-body",
        "--max-time",
        String(Math.ceil(VESPA_INSERT_TIMEOUT_MS / 1000)),
        "-H",
        "Content-Type: application/json",
        "-H",
        "Connection: close",
        "--data-binary",
        `@${tempFilePath}`,
        "-w",
        `${curlStatusMarker}%{http_code}:%{content_type}:%{size_download}`,
        url.toString(),
      ],
      VESPA_INSERT_TIMEOUT_MS,
    )

    const markerIndex = curlResult.stdout.lastIndexOf(curlStatusMarker)
    const responseBody =
      markerIndex >= 0
        ? curlResult.stdout.slice(0, markerIndex)
        : curlResult.stdout
    const statusParts =
      markerIndex >= 0
        ? curlResult.stdout
            .slice(markerIndex + curlStatusMarker.length)
            .trim()
            .split(":")
        : []
    const status = Number.parseInt(statusParts[0] || "0", 10)
    const ok =
      curlResult.exitCode === 0 &&
      Number.isFinite(status) &&
      status >= 200 &&
      status < 300

    if (!ok) {
      throw new Error(
        `Vespa insert failed for ${docId}: status=${status} exit=${curlResult.exitCode} stderr=${curlResult.stderr.slice(0, 500)} body=${responseBody.slice(0, 500)}`,
      )
    }

    Logger.info(
      {
        docId,
        schema,
        status,
        responseBytes: responseBody.length,
        elapsedMs: Date.now() - requestStart,
        curlExitCode: curlResult.exitCode,
      },
      "File processing stage: direct Vespa insert response complete",
    )
  } finally {
    await unlink(tempFilePath).catch(() => undefined)
  }
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

async function processFileJob(jobData: FileProcessingJob, startTime: number) {
  const { fileId } = jobData
  let currentStage = "load-file-metadata"

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

  // Guard: only process real files
  if (file.type !== "file") {
    Logger.warn(`Item is not a file: ${fileId}`)
    return
  }

  try {
    Logger.info(`Processing file job: ${fileId}`)
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        uploadStatus: file.uploadStatus,
        storagePath: file.storagePath,
        useOCR: jobData.useOCR !== false,
      },
      "File processing stage: loaded metadata",
    )

    // Skip if already processed
    if (file.uploadStatus === UploadStatus.COMPLETED) {
      Logger.info(`File already processed: ${fileId}`)
      return
    }

    // Update status to processing
    await db
      .update(collectionItems)
      .set({
        uploadStatus: UploadStatus.PROCESSING,
        statusMessage: `Processing file: ${file.fileName}`,
        updatedAt: new Date(),
      })
      .where(eq(collectionItems.id, fileId))
    currentStage = "marked-processing"
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
      },
      "File processing stage: marked processing",
    )

    Logger.info(`Processing file: ${file.fileName} at ${file.storagePath}`)

    // Check required fields
    if (!file.storagePath) {
      throw new Error(`No storage path for file: ${fileId}`)
    }

    if (!file.vespaDocId) {
      throw new Error(`No vespaDocId for file: ${fileId}`)
    }

    currentStage = "read-file"
    const readStart = Date.now()
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        storagePath: file.storagePath,
      },
      "File processing stage: reading file from disk",
    )
    const fileBuffer = await readFile(file.storagePath)
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        bytesRead: fileBuffer.length,
        durationMs: Date.now() - readStart,
      },
      "File processing stage: file read complete",
    )

    // Process file to extract content
    // Get useOCR from job data (default to true for backward compatibility)
    const useOCR = jobData.useOCR !== false
    currentStage = "extract-content"
    const extractionStart = Date.now()
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        fileSize: file.fileSize,
        bufferSize: fileBuffer.length,
        useOCR,
      },
      "File processing stage: extracting content",
    )
    const processingResults = await FileProcessorService.processFile(
      fileBuffer,
      file.mimeType || "application/octet-stream",
      file.fileName,
      file.vespaDocId || "",
      file.storagePath,
      IMAGE_CONTEXT_CONFIG.enabled, // extractImages
      IMAGE_CONTEXT_CONFIG.enabled, // describeImages
      useOCR, // useOCR option
    )
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        resultCount: processingResults.length,
        totalTextChunks: processingResults.reduce(
          (sum, result) => sum + result.chunks.length,
          0,
        ),
        totalImageChunks: processingResults.reduce(
          (sum, result) => sum + result.image_chunks.length,
          0,
        ),
        durationMs: Date.now() - extractionStart,
      },
      "File processing stage: content extraction complete",
    )

    // Extract title for markdown files
    let pageTitle: string = ""
    if (getBaseMimeType(file.mimeType || "") === "text/markdown") {
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

    // Handle multiple processing results (e.g., for spreadsheets with multiple sheets)
    let totalChunksCount = 0
    let newVespaDocId = ""
    if (processingResults.length > 0 && "totalSheets" in processingResults[0]) {
      newVespaDocId = `${file.vespaDocId}_sheet_${(processingResults[0] as SheetProcessingResult).totalSheets}`
    } else {
      newVespaDocId = file.vespaDocId
    }
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        resultCount: processingResults.length,
      },
      "File processing stage: preparing Vespa documents",
    )
    for (const [resultIndex, processingResult] of processingResults.entries()) {
      const prepareStart = Date.now()
      currentStage = `vespa-prepare-${resultIndex + 1}`
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          resultIndex,
          resultCount: processingResults.length,
          chunks: processingResult.chunks.length,
          imageChunks: processingResult.image_chunks.length,
          tocChunks: processingResult.toc_chunks?.length || 0,
          chunkMaps: processingResult.chunks_map?.length || 0,
          imageChunkMaps: processingResult.image_chunks_map?.length || 0,
        },
        "File processing stage: preparing Vespa document",
      )
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

      const mapStart = Date.now()
      const chunksMap = processingResult.chunks_map?.map((meta) =>
        mapChunkMeta(meta, true),
      )
      const imageChunksMap = processingResult.image_chunks_map?.map((meta) =>
        mapChunkMeta(meta, false),
      )
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          resultIndex,
          durationMs: Date.now() - mapStart,
          chunkMaps: chunksMap?.length || 0,
          imageChunkMaps: imageChunksMap?.length || 0,
        },
        "File processing stage: mapped Vespa chunk metadata",
      )

      const metadataStart = Date.now()
      const vespaMetadata = JSON.stringify(
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
            sheetIndex: (processingResult as SheetProcessingResult).sheetIndex,
            totalSheets: (processingResult as SheetProcessingResult)
              .totalSheets,
          }),
        }),
      )
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          resultIndex,
          durationMs: Date.now() - metadataStart,
          metadataBytes: Buffer.byteLength(vespaMetadata),
        },
        "File processing stage: built Vespa metadata",
      )

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
        chunks_map: chunksMap,
        image_chunks_map: imageChunksMap,
        pageTitle: pageTitle,
        documentOutline: processingResult.documentOutline,
        metadata: vespaMetadata,
        createdBy: file.uploadedByEmail || "system",
        duration: 0,
        mimeType: getBaseMimeType(file.mimeType || "text/plain"),
        fileSize: file.fileSize || 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clFd: file.parentId,
      }
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          resultIndex,
          docId,
          durationMs: Date.now() - prepareStart,
        },
        "File processing stage: prepared Vespa document",
      )

      // Insert into Vespa
      currentStage = `vespa-insert-${resultIndex + 1}`
      const vespaInsertStart = Date.now()
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          resultIndex,
          resultCount: processingResults.length,
          docId,
          chunks: processingResult.chunks.length,
          imageChunks: processingResult.image_chunks.length,
          tocChunks: processingResult.toc_chunks?.length || 0,
        },
        "File processing stage: inserting Vespa document",
      )
      await insertKbItemDocument(vespaDoc, KbItemsSchema)
      Logger.info(
        {
          fileId,
          fileName: file.fileName,
          resultIndex,
          docId,
          durationMs: Date.now() - vespaInsertStart,
        },
        "File processing stage: Vespa insert complete",
      )

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

    currentStage = "mark-completed"
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
        chunksCount,
      },
      "File processing stage: marking completed",
    )
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
    Logger.info(
      {
        fileId,
        fileName: file.fileName,
      },
      "File processing stage: marked completed",
    )

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
    Logger.error(
      error,
      `Failed to process file: ${fileId} at stage ${currentStage} - ${errorMessage}`,
    )

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
    await insertKbItemDocument(vespaDoc, KbItemsSchema)

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
    await insertKbItemDocument(vespaDoc, KbItemsSchema)
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
