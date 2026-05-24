import { ReasoningSteps } from "@/api/chat/reasoning-steps"
import type {
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent"

import type { ToolCallContext, ToolHandler } from "../types"

interface LsKnowledgeBaseDetails {
  target?: {
    type?: string
    collectionId?: string
    folderId?: string
    fileId?: string
    path?: string
  }
  entries?: Array<{
    type?: string
    name?: string
    path?: string
  }>
  total?: number
}

export const lsKnowledgeBaseHandler: ToolHandler = {
  toolName: "lsKnowledgeBase",

  async onToolCall(
    event: ToolCallEvent,
    context: ToolCallContext,
  ): Promise<undefined> {
    const input = event.input as Record<string, unknown> | undefined
    const target = input?.target as { type?: string; path?: string } | undefined

    let description = "Browsing knowledge base"
    if (target?.type) {
      switch (target.type) {
        case "collection":
          description = "Listing accessible collections"
          break
        case "folder":
          description = `Browsing folder contents`
          break
        case "file":
          description = "Inspecting file details"
          break
        case "path":
          description = `Browsing path: ${target.path || "/"}`
          break
      }
    } else {
      description = "Discovering available knowledge bases"
    }

    await context.emitReasoningStep(
      ReasoningSteps.logMessage(
        description,
        "gathering",
        undefined,
        "lsKnowledgeBase",
      ),
    )

    return undefined
  },

  async onToolResult(
    event: ToolResultEvent,
    context: ToolCallContext,
  ): Promise<void> {
    const details = (event.details ?? {}) as LsKnowledgeBaseDetails
    const entries = details.entries || []
    const total = details.total ?? entries.length

    const target = details.target
    let resultDescription: string

    if (!target) {
      resultDescription = `Found ${total} accessible collection${total === 1 ? "" : "s"}`
    } else if (target.type === "collection") {
      resultDescription = `Listed ${total} item${total === 1 ? "" : "s"} in collection`
    } else if (target.type === "folder") {
      resultDescription = `Found ${total} item${total === 1 ? "" : "s"} in folder`
    } else if (target.type === "file") {
      resultDescription = "Retrieved file information"
    } else if (target.type === "path") {
      resultDescription = `Found ${total} item${total === 1 ? "" : "s"} at path ${target.path || "/"}`
    } else {
      resultDescription = `Browsing complete: ${total} item${total === 1 ? "" : "s"} found`
    }

    await context.emitReasoningStep(
      ReasoningSteps.logMessage(
        resultDescription,
        "gathering",
        undefined,
        "lsKnowledgeBase",
      ),
    )
  },
}
