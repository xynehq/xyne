import type { MinimalAgentFragment } from "@/api/chat/types"
import { expandSheetIds } from "@/search/utils"
import { prepareInitialAttachmentContext } from "../helpers"

export interface ProcessAttachmentsOptions {
  fileIds: string[]
  threadIds: string[]
  message: string
  email: string
  userTimezone: string
  dateForAI: string
  userId: number
  workspaceId: number
}

export interface ProcessedAttachments {
  fragments: MinimalAgentFragment[]
  summary: string
}

export async function processAttachments(
  options: ProcessAttachmentsOptions,
): Promise<ProcessedAttachments> {
  // Expand sheet IDs (handles Google Sheets tab references)
  const referencedFileIds = Array.from(
    new Set(options.fileIds.flatMap((fileId) => expandSheetIds(fileId))),
  )

  if (referencedFileIds.length === 0 && options.threadIds.length === 0) {
    return {
      fragments: [],
      summary: "",
    }
  }

  // Prepare user metadata for the helper function
  const userMetadata = {
    userId: options.userId,
    workspaceId: options.workspaceId,
    userTimezone: options.userTimezone,
    dateForAI: options.dateForAI,
  }

  // Call the existing helper function
  const ctx = await prepareInitialAttachmentContext(
    referencedFileIds,
    options.threadIds,
    userMetadata,
    options.message,
    options.email,
    true, // allowChunkCitations
  )

  if (!ctx) {
    return {
      fragments: [],
      summary: "",
    }
  }

  return {
    fragments: ctx.fragments,
    summary: ctx.summary,
  }
}
