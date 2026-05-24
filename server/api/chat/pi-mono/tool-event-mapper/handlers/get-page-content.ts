import { ReasoningSteps } from "@/api/chat/reasoning-steps"
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"

import type { ToolCallContext, ToolHandler } from "../types"

interface GetPageContentDetails {
  vespaDocId?: string
  pageNos?: number[]
  textChunksRead?: number
  imageChunksRead?: number
}

export const getPageContentHandler: ToolHandler = {
  toolName: "getPageContent",

  async onToolCall(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<undefined> {
    const input = event.input as Record<string, unknown> | undefined
    const vespaDocId = input?.vespaDocId as string | undefined
    const pageNos = input?.pageNos as number[] | undefined

    let description = "Fetching page content"
    if (vespaDocId && pageNos && pageNos.length > 0) {
      const pageList = pageNos.length <= 3 
        ? pageNos.join(", ")
        : `${pageNos.slice(0, 3).join(", ")}... (${pageNos.length} pages)`
      description = `Retrieving content from page${pageNos.length === 1 ? "" : "s"} ${pageList}`
    } else if (vespaDocId) {
      description = "Fetching document content"
    }

    await context.emitReasoningStep(
      ReasoningSteps.logMessage(
        description,
        "gathering",
        undefined,
        "getPageContent",
      ),
    )

    return undefined
  },

  async onToolResult(
    event: ToolResultEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const details = (event.details ?? {}) as GetPageContentDetails
    const textChunksRead = details.textChunksRead ?? 0
    const imageChunksRead = details.imageChunksRead ?? 0
    const pageNos = details.pageNos ?? []

    let resultDescription: string
    const pageCount = pageNos.length
    
    if (textChunksRead === 0 && imageChunksRead === 0) {
      resultDescription = pageCount === 1 
        ? "No content found on the requested page"
        : "No content found on the requested pages"
    } else {
      const parts: string[] = []
      if (textChunksRead > 0) {
        parts.push(`${textChunksRead} text chunk${textChunksRead === 1 ? "" : "s"}`)
      }
      if (imageChunksRead > 0) {
        parts.push(`${imageChunksRead} image${imageChunksRead === 1 ? "" : "s"}`)
      }
      resultDescription = `Retrieved ${parts.join(" and ")} from page${pageCount === 1 ? "" : "s"} ${pageNos.slice(0, 3).join(", ")}${pageCount > 3 ? `... (${pageCount} total)` : ""}`
    }

    await context.emitReasoningStep(
      ReasoningSteps.logMessage(
        resultDescription,
        "gathering",
        undefined,
        "getPageContent",
      ),
    )
  },
}
