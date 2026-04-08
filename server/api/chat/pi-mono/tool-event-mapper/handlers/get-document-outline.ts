import { ReasoningSteps } from "@/api/chat/reasoning-steps"
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent"

import type { ToolCallContext, ToolHandler } from "../types"

interface GetDocumentOutlineDetails {
  fileIds?: string[]
  query?: string
  documentsSearched?: number
  outlinesReturned?: number
}

export const getDocumentOutlineHandler: ToolHandler = {
  toolName: "getDocumentOutline",

  async onToolCall(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<undefined> {
    const input = event.input as Record<string, unknown> | undefined
    const fileIds = input?.fileIds as string[] | undefined
    const query = input?.query as string | undefined

    let description = "Retrieving document outline"
    if (fileIds && fileIds.length > 0) {
      description = `Fetching outline for ${fileIds.length} document${fileIds.length === 1 ? "" : "s"}`
    } else if (query) {
      description = `Searching for documents matching "${query}"`
    } else {
      description = "Discovering document structure"
    }

    await context.emitReasoningStep(
      ReasoningSteps.logMessage(
        description,
        "gathering",
        undefined,
        "getDocumentOutline",
      ),
    )

    return undefined
  },

  async onToolResult(
    event: ToolResultEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const details = (event.details ?? {}) as GetDocumentOutlineDetails
    const documentsSearched = details.documentsSearched ?? 0
    const outlinesReturned = details.outlinesReturned ?? 0

    let resultDescription: string
    if (documentsSearched === 0) {
      resultDescription = "No documents found matching the criteria"
    } else if (outlinesReturned === 0) {
      resultDescription = `Found ${documentsSearched} document${documentsSearched === 1 ? "" : "s"} but no outlines available`
    } else {
      resultDescription = `Retrieved ${outlinesReturned} outline${outlinesReturned === 1 ? "" : "s"} from ${documentsSearched} document${documentsSearched === 1 ? "" : "s"}`
    }

    await context.emitReasoningStep(
      ReasoningSteps.logMessage(
        resultDescription,
        "gathering",
        undefined,
        "getDocumentOutline",
      ),
    )
  },
}
