import path from "node:path"
import config from "@/config"
import { db } from "@/db/client"
import { collectionItems } from "@/db/schema"
import { getBaseMimeType } from "@/integrations/dataSource/config"
import { buildDoclingSchedulerSourceReference } from "@/lib/doclingSchedulerStorage"
import {
  inferDoclingSourcePriority,
  upsertDoclingAsyncFileForSplit,
} from "@/lib/doclingSchedulerStore"
import { UploadStatus } from "@/shared/types"
import { eq } from "drizzle-orm"

const DOCLING_PDF_PROCESSING_METHOD = "docling"

export function resolveRuntimeStoragePath(storagePath: string): string {
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

export type QueuePdfForDoclingSchedulerInput = {
  fileId: string
  vespaDocId: string | null
  collectionId: string
  parentId?: string | null
  collectionName: string
  fileName: string
  originalName?: string | null
  storagePath: string | null
  path: string
  mimeType?: string | null
  fileSize?: number | null
  uploadedByEmail?: string | null
  pageTitle?: string
  metadata?: unknown
}

export const queuePdfForDoclingScheduler = async (
  input: QueuePdfForDoclingSchedulerInput,
) => {
  if (!input.storagePath) {
    throw new Error(`No storage path for file: ${input.fileId}`)
  }

  if (!input.vespaDocId) {
    throw new Error(`No vespaDocId for file: ${input.fileId}`)
  }

  const runtimeStoragePath = resolveRuntimeStoragePath(input.storagePath)
  const baseMimeType = getBaseMimeType(input.mimeType || "application/pdf")
  const { sourceKind, basePriority } = inferDoclingSourcePriority({
    collectionId: input.collectionId,
    parentId: input.parentId,
    metadata: input.metadata,
  })
  const schedulerSource =
    buildDoclingSchedulerSourceReference(runtimeStoragePath)
  const metadata =
    typeof input.metadata === "object" && input.metadata !== null
      ? (input.metadata as Record<string, unknown>)
      : {}

  const schedulerFile = await upsertDoclingAsyncFileForSplit({
    fileId: input.fileId,
    vespaDocId: input.vespaDocId,
    collectionId: input.collectionId,
    parentId: input.parentId || null,
    collectionName: input.collectionName,
    fileName: input.fileName,
    originalName: input.originalName || null,
    sourcePath: schedulerSource.sourcePath,
    sourceStorageKey: schedulerSource.sourceStorageKey,
    path: input.path,
    mimeType: input.mimeType || "application/pdf",
    baseMimeType,
    fileSize: input.fileSize || 0,
    uploadedByEmail: input.uploadedByEmail || null,
    pageTitle: input.pageTitle || "",
    metadata,
    sourceKind,
    basePriority,
    priorityOverride: null,
    totalPages: 0,
    totalParts: 0,
    pageChunkSize: config.doclingPageChunkSize,
  })

  if (!schedulerFile) {
    return {
      schedulerFile: null,
      runtimeStoragePath,
      sourceKind,
      basePriority,
    }
  }

  await db
    .update(collectionItems)
    .set({
      uploadStatus: UploadStatus.PROCESSING,
      statusMessage: `Queued PDF for async Docling scheduler: ${input.fileName}`,
      metadata: mergeCollectionItemMetadata(input.metadata, {
        pdfProcessingMethod: DOCLING_PDF_PROCESSING_METHOD,
        doclingAsyncScheduler: true,
        doclingPageChunkSize: config.doclingPageChunkSize,
      }),
      updatedAt: new Date(),
    })
    .where(eq(collectionItems.id, input.fileId))

  return {
    schedulerFile,
    runtimeStoragePath,
    sourceKind,
    basePriority,
  }
}
