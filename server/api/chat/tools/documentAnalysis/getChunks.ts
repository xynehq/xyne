import { ToolResponse, ToolErrorCodes } from "@xynehq/jaf"
import type { Tool } from "@xynehq/jaf"
import { GetDocumentsByDocIds } from "@/search/vespa"
import type { ToolRawDocument, RawChunkWithScore } from "@/api/chat/agent-schemas"
import type { AgentRunContext } from "@/api/chat/agent-schemas"
import { getTracer, type Span } from "@/tracer"
import { Apps } from "@xyne/vespa-ts/types"
import type { GetChunksInput } from "./types"
import { z } from "zod"

/**
 * Schema for get_chunks tool parameters
 */
const getChunksInputSchema = z.object({
  docId: z.string().describe("Document ID to read from"),
  offset: z.number().int().min(0).describe("Starting chunk index (0-based)"),
  limit: z.number().int().min(1).max(20).describe("Number of chunks to fetch (5-10 recommended)"),
})

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

      
      const doc = result?.root?.children?.[0]
      if (!doc) {
        return ToolResponse.error(
          ToolErrorCodes.NOT_FOUND,
          "Document not found",
          { toolName: "read_document", docId }
        )
      }

      // Extract chunks from the document.
      // Direct doc-id fetch commonly returns full `chunks`; fall back to summary/text shapes.
      const fields = doc.fields as
        | {
            chunks?: Array<string | { chunk?: string; score?: number }>
            chunks_summary?: Array<string | { chunk?: string; score?: number }>
            text?: string
            body?: string
            title?: string
          }
        | undefined
      const toChunkText = (
        value: string | { chunk?: string; score?: number },
      ): string => (typeof value === "string" ? value : value?.chunk ?? "")
      const directChunks = Array.isArray(fields?.chunks)
        ? fields.chunks.map(toChunkText)
        : []
      const summaryChunks = Array.isArray(fields?.chunks_summary)
        ? fields.chunks_summary.map(toChunkText)
        : []
      const fallbackText =
        typeof fields?.text === "string"
          ? fields.text
          : typeof fields?.body === "string"
            ? fields.body
            : ""
      const chunksSummary =
        directChunks.length > 0
          ? directChunks
          : summaryChunks.length > 0
            ? summaryChunks
            : fallbackText
              ? [fallbackText]
              : []
      const title = fields?.title || "Untitled"
      const totalChunks = chunksSummary.length

      // Validate offset
      if (offset >= totalChunks) {
        return ToolResponse.error(
          ToolErrorCodes.INVALID_INPUT,
          `Offset ${offset} is beyond document length (${totalChunks} chunks)`,
          { toolName: "read_document", docId, offset, totalChunks }
        )
      }

      // Slice chunks based on offset and limit
      const endOffset = Math.min(offset + limit, totalChunks)
      const slicedChunks = chunksSummary.slice(offset, endOffset)

      // Build raw chunks with sequential keys
      const chunks: RawChunkWithScore[] = slicedChunks.map((content: string, idx: number) => ({
        chunkKey: `seq:${offset + idx}`,
        content,
        score: 1.0, // Deterministic fetch - no scoring
      }))

      // Build citation source (minimal version)
      const source = {
        docId,
        title,
        url: "",
        app: Apps.Xyne,
        entity: "document" as any,
      }

      // Build the raw document
      const rawDocument: ToolRawDocument = {
        docId,
        relevance: 1.0,
        source,
        chunks,
        vespaHit: doc as any,
      }

      const hasMore = endOffset < totalChunks

      return ToolResponse.success(
        {
          rawDocuments: [rawDocument],
          chunksFetched: chunks.length,
          totalChunks,
          hasMore,
          nextOffset: hasMore ? endOffset : null,
          summary: `Fetched ${chunks.length} chunks from offset ${offset} to ${endOffset - 1}. Total document: ${totalChunks} chunks.`,
        },
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
