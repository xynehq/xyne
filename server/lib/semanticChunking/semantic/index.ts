/**
 * Semantic processing module
 * Converts Docling documents to clean, deduplicated semantic streams
 */

// Types
export type {
  SemanticNode,
  SemanticNodeType,
  SemanticNodeBase,
  SemanticSectionNode,
  SemanticParagraphNode,
  SemanticTableNode,
  SemanticImageNode,
  SemanticCommentNode,
  BBox,
  TableCell,
} from "./types"

// Type guards
export {
  isSectionNode,
  isParagraphNode,
  isTableNode,
  isImageNode,
  isCommentNode,
} from "./types"

// Iterator
export { semanticIterator, type IteratorOptions } from "./iterator"

// Deduplicator
export {
  deduplicateNodes,
  deduplicatedSemanticIterator,
  calculateIoU,
} from "./deduplicator"

// Merger
export { TextBuffer, mergeText } from "./merger"
