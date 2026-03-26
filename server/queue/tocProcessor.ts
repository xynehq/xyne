import { readFile } from "node:fs/promises"
import { db } from "@/db/client"
import {
  claimCollectionItemTocProcessing,
  getCollectionItemTocRecord,
  setCollectionItemTocCompleted,
  setCollectionItemTocNotFound,
  setCollectionItemTocPending,
  setCollectionItemTocProcessingFailed,
} from "@/db/knowledgeBaseToc"
import { generatePdfToc } from "@/lib/pdfToc"
import { TOC_QUEUE_RETRY_LIMIT, TocInfoSchema } from "@/knowledgeBase/toc"
import { getLogger } from "@/logger"
import { UploadStatus } from "@/shared/types"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { TocGenerationJob } from "./toc-generation"

const Logger = getLogger(Subsystem.Queue).child({ module: "tocProcessor" })

function isTocEligibleRow(
  row: Awaited<ReturnType<typeof getCollectionItemTocRecord>>,
) {
  return (
    !!row &&
    row.deletedAt === null &&
    row.type === "file" &&
    row.mimeType === "application/pdf" &&
    row.uploadStatus === UploadStatus.COMPLETED
  )
}

export async function processTocJob(job: { data: TocGenerationJob }) {
  const { fileId, force = false } = job.data

  const preflightRow = await getCollectionItemTocRecord(db, fileId)
  if (!isTocEligibleRow(preflightRow)) {
    Logger.info({ fileId }, "Skipping TOC job because file is no longer eligible")
    return
  }

  const claimedRow = await claimCollectionItemTocProcessing(db, fileId, force)
  if (!claimedRow) {
    Logger.info({ fileId, force }, "TOC job was not claimed")
    return
  }

  const tocInfo = TocInfoSchema.parse(claimedRow.tocInfo)
  const attempts = tocInfo.attempts

  if (!claimedRow.storagePath) {
    await setCollectionItemTocProcessingFailed(
      db,
      fileId,
      attempts,
      "PDF file is missing a storage path",
    )
    return
  }

  let fileBuffer: Buffer
  try {
    fileBuffer = await readFile(claimedRow.storagePath)
  } catch (error) {
    await setCollectionItemTocProcessingFailed(
      db,
      fileId,
      attempts,
      `Failed to read PDF from disk: ${getErrorMessage(error)}`,
    )
    return
  }

  try {
    const result = await generatePdfToc(fileBuffer)

    if (result.outcome === "completed" && result.toc) {
      await setCollectionItemTocCompleted(db, fileId, attempts, result.toc)
      return
    }

    await setCollectionItemTocNotFound(db, fileId, attempts)
  } catch (error) {
    const errorMessage = getErrorMessage(error)

    if (attempts >= TOC_QUEUE_RETRY_LIMIT) {
      await setCollectionItemTocProcessingFailed(
        db,
        fileId,
        attempts,
        errorMessage,
      )
    } else {
      await setCollectionItemTocPending(db, fileId, attempts, errorMessage)
    }

    throw error
  }
}
