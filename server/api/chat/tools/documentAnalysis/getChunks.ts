import { ToolResponse, ToolErrorCodes } from "@juspay-xyne-jaf/jaf"
import type { Tool } from "@juspay-xyne-jaf/jaf"
import { GetDocumentsByDocIds } from "@/search/vespa"
import type { AgentRunContext } from "@/api/chat/agent-schemas"
import { getTracer, type Span } from "@/tracer"
import type { VespaSearchResult } from "@xyne/vespa-ts"
import type { GetChunksInput } from "./types"
import { z } from "zod"
import {
  formatSearchToolResponse,
  formatSearchToolResponseAsRawDocuments,
} from "../utils"

/**
 * Schema for get_chunks tool parameters
 */
const getChunksInputSchema = z.object({
  docId: z.string().describe("Document ID to read from"),
  offset: z.number().int().min(0).describe("Starting chunk index (0-based)"),
  limit: z.number().int().min(1).max(10).describe("Number of chunks to fetch (2-5 recommended)"),
})

function getValidatedChunkFields(fields: Record<string, unknown>): {
  chunksSummary: string[]
  chunkPositions: number[]
} | null {
  const chunksSummaryRaw = fields.chunks_summary
  const chunkPositionsRaw = fields.chunks_pos_summary

  const chunksSummary =
    Array.isArray(chunksSummaryRaw) &&
    chunksSummaryRaw.every((chunk) => typeof chunk === "string")
      ? chunksSummaryRaw
      : null

  if (!chunksSummary) {
    return null
  }

  const chunkPositions =
    Array.isArray(chunkPositionsRaw) &&
    chunkPositionsRaw.every((pos) => typeof pos === "number")
      ? chunkPositionsRaw
      : null

  if (chunkPositions) {
    return { chunksSummary, chunkPositions }
  }

  return {
    chunksSummary,
    chunkPositions: chunksSummary.map((_, idx) => idx),
  }
}

function normalizeWindowedVespaHit(
  doc: VespaSearchResult,
  chunksSummary: string[],
  chunkPositions: number[],
  offset: number,
  endOffset: number,
): VespaSearchResult {
  const fields = doc.fields as Record<string, unknown>

  const windowedChunks = chunksSummary.slice(offset, endOffset)
  const windowedPositions: number[] = []
  for(let i = offset; i < endOffset; i++) {
    windowedPositions.push(chunkPositions[i] ?? i)
  }
  const chunkScoresCells: Record<string, number> = {}
  for (let i = 0; i < windowedChunks.length; i++) {
    chunkScoresCells[String(i)] = 1
  }

  const existingMatchfeatures =
    fields.matchfeatures && typeof fields.matchfeatures === "object"
      ? (fields.matchfeatures as Record<string, unknown>)
      : {}

  return {
    ...doc,
    fields: {
      ...fields,
      chunks_summary: windowedChunks,
      chunks_pos_summary: windowedPositions,
      matchfeatures: {
        ...existingMatchfeatures,
        chunk_scores: {
          cells: chunkScoresCells,
        },
      },
    },
  } as VespaSearchResult
}

/**
   * Get chunks tool - deterministic fetch of document chunks
   * 
   * This tool reads document chunks at specified offsets for exploration.
   * It supports both sparse scanning (at different positions) and focused reading.
   * 
   * IMPORTANT: This tool is ONLY available to agents with "read_document" in appIntegrations.
   */
  export const getChunksTool: Tool<GetChunksInput, AgentRunContext> = {
    schema: {
      name: "read_document",
      description: [
        "Read chunks of a document at specified offsets.",
        "Use this for both sparse exploration (scanning at different positions) and focused reading.",
        "For large documents: First explore sparse offsets to understand structure, then focus on relevant sections.",
        "For small documents (≤20 chunks): You may read sequentially from offset=0.",
        "Returns totalChunks so you can plan exploration strategy.",
      ].join(" "),
      parameters: getChunksInputSchema as any,
    },

  async execute(args, context) {
    const { docId, offset, limit } = args

    // Check if this agent has access to read_document tools via runtime tool state
    const hasDocumentAnalysisAccess = context.enabledTools?.has("read_document")
    
    if (!hasDocumentAnalysisAccess) {
      return ToolResponse.error(
        ToolErrorCodes.PERMISSION_DENIED,
        "This agent does not have access to document analysis tools.",
        { toolName: "read_document" }
      )
    }

    try {
      const directFetchSpan: Span = getTracer("chat").startSpan(
        "deep_document_direct_doc_fetch",
      )
      let result
      try {
        result = await GetDocumentsByDocIds([docId], directFetchSpan)
      } finally {
        directFetchSpan.end()
      }
      
      
      const doc = result?.root?.children?.[0] as VespaSearchResult
      if (!doc) {
        return ToolResponse.error(
          ToolErrorCodes.NOT_FOUND,
          "Document not found",
          { toolName: "read_document", docId }
        )
      }

      // Extract chunks from document fields to validate requested window.
      const fields = doc.fields as Record<string, unknown>
      const validatedChunkFields = getValidatedChunkFields(fields)
      if (!validatedChunkFields) {
        return ToolResponse.error(
          ToolErrorCodes.INVALID_INPUT,
          "Document has invalid or missing chunk summaries",
          { toolName: "read_document", docId }
        )
      }
      const { chunksSummary, chunkPositions } = validatedChunkFields
      const totalChunks = chunksSummary.length

      // Validate offset
      if (offset >= totalChunks) {
        return ToolResponse.error(
          ToolErrorCodes.INVALID_INPUT,
          `Offset ${offset} is beyond document length (${totalChunks} chunks)`,
          { toolName: "read_document", docId, offset, totalChunks }
        )
      }

      const endOffset = Math.min(offset + limit, totalChunks)
      const updatedDoc = normalizeWindowedVespaHit(
        doc,
        chunksSummary,
        chunkPositions,
        offset,
        endOffset,
      )
      result.root.children[0] = updatedDoc


      const rawDocuments = await formatSearchToolResponseAsRawDocuments(
        result,
        { email: context.user.email },
      )
      const fragments = await formatSearchToolResponse(result, {
        email: context.user.email,
        query: `read_document docId=${docId} offset=${offset} limit=${limit}`,
        userId: context.user?.numericId,
        workspaceId: context.user?.workspaceNumericId,
      })
      const hasMore = endOffset < totalChunks
      const windowDetails = `Read window: chunks ${offset}-${endOffset - 1} of ${totalChunks} (fetched ${endOffset - offset}, hasMore=${hasMore ? "yes" : "no"}${hasMore ? `, nextOffset=${endOffset}` : ""}).`
      const enrichedFragments = fragments.map((fragment, idx) =>
        idx === 0
          ? {
              ...fragment,
              content: `${windowDetails}\n\n${fragment.content}`,
            }
          : fragment,
      )

      return ToolResponse.success(
        { fragments: enrichedFragments, rawDocuments },
        {
          toolName: "read_document",
          estimatedCostUsd: 0.001, // Minimal cost for read operation
        }
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Failed to fetch chunks: ${errorMessage}`,
        { toolName: "read_document", docId }
      )
    }
  },
}
