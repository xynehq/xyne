import type { ToolRawDocument } from "@/api/chat/agent-schemas"

/**
 * Input parameters for the get_chunks tool
 */
export interface GetChunksInput {
  /** Document ID to read from */
  docId: string
  /** Starting chunk index (0-based) */
  offset: number
  /** Number of chunks to fetch */
  limit: number
}

/**
 * Output from the get_chunks tool
 */
export interface GetChunksOutput {
  /** Raw documents with chunks */
  rawDocuments: ToolRawDocument[]
  /** Summary of what was fetched */
  summary?: string
}

/**
 * Zod schema for validation (will be used when creating the tool)
 */
export const GetChunksInputSchema = {
  type: "object",
  properties: {
    docId: {
      type: "string",
      description: "Document ID to read from",
    },
    offset: {
      type: "number",
      description: "Starting chunk index (0-based)",
    },
    limit: {
      type: "number",
      description: "Number of chunks to fetch (5-10 recommended)",
    },
  },
  required: ["docId", "offset", "limit"],
} as const
