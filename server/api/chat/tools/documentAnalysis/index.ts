/**
 * Document Analysis Tools Module
 * 
 * Provides tools for document analysis and exploration.
 * These tools are designed for agents that need to read documents
 * sequentially and build comprehensive understanding.
 * 
 * IMPORTANT: These tools are gated by appIntegrations.
 * Only agents with "read_document" in appIntegrations can use them.
 */

export { getChunksTool } from "./getChunks"
export type { GetChunksInput, GetChunksOutput } from "./types"
export { GetChunksInputSchema } from "./types"
