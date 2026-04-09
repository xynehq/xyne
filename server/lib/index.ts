/**
 * Main exports for semantic chunking system
 */

// Docling module
export * from "./semanticChunking/docling/types"
export { buildLookup, resolveRef, isTextItem, isTableItem, isPictureItem, hasChildren } from "./semanticChunking/docling/lookup"
export { isNoiseText } from "./semanticChunking/docling/extractor"
export {
  TEXT_LIKE_LABELS,
  SECTION_LABELS,
  IGNORE_LABELS,
  mapDoclingLabel,
  isTextLike,
  isSection,
  isIgnorable,
  isBodyContent,
} from "./semanticChunking/docling/labels"

// Semantic module
export type {
  SemanticNodeBase,
  SemanticNodeType,
  SemanticSectionNode,
  SemanticParagraphNode,
  SemanticTableNode,
  SemanticImageNode,
  SemanticNode,
} from "./semanticChunking/semantic/types"
export {
  isSectionNode,
  isParagraphNode,
  isTableNode,
  isImageNode,
} from "./semanticChunking/semantic/types"
export type { TableCell as SemanticTableCell } from "./semanticChunking/semantic/types"
export { TextBuffer, mergeText } from "./semanticChunking/semantic/merger"
export { semanticIterator, type IteratorOptions } from "./semanticChunking/semantic/iterator"
export { deduplicateNodes, deduplicatedSemanticIterator, calculateIoU } from "./semanticChunking/semantic/deduplicator"

// Chunking module
export * from "./semanticChunking/chunking/types"
export { estimateTokens, splitIntoSentences, splitByLength, getUnique, generateChunkId } from "./semanticChunking/chunking/utils"
export { chunkSemanticStream } from "./semanticChunking/chunking/chunker"

// Convenience function
import type { DoclingDocument } from "./semanticChunking/docling/types"
import { semanticIterator } from "./semanticChunking/semantic/iterator"
import { deduplicateNodes } from "./semanticChunking/semantic/deduplicator"
import { chunkSemanticStream } from "./semanticChunking/chunking/chunker"
import type { ChunkingOptions, ChunkingResult } from "./semanticChunking/chunking/types"

/**
 * Process a Docling document end-to-end
 * Convenience function that combines iterator, spatial deduplication, and chunker
 *
 * Deduplication resolves table/image conflicts using spatial overlap (IoU > 0.9)
 * Overlapping OCR images are merged into tables as rawText fallback
 */
export async function processDoclingDocument(
  doc: DoclingDocument,
  chunkingOptions?: ChunkingOptions
): Promise<ChunkingResult> {
  const nodes = [...semanticIterator(doc)]
  const dedupedNodes = deduplicateNodes(nodes)
  return chunkSemanticStream(dedupedNodes, chunkingOptions)
}