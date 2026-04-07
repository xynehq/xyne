/**
 * Semantic node type definitions
 * Clean, linear representation of document content
 */

// Bounding box for spatial deduplication
export interface BBox {
  l: number
  t: number
  r: number
  b: number
  coord_origin?: "BOTTOMLEFT" | "TOPLEFT"
}

// Base semantic node
export interface SemanticNodeBase {
  type: SemanticNodeType
  ref: string
  pageNo?: number
  pageNumbers?: number[]
  sectionPath: string[]
  sourceRefs: string[]  // All Docling refs that contributed to this node
  bbox?: BBox  // Spatial bounding box for deduplication
}

// Node type union
export type SemanticNodeType = "section" | "paragraph" | "table" | "image" | "comment"

// Section header node
export interface SemanticSectionNode extends SemanticNodeBase {
  type: "section"
  title: string
  level: number
}

// Paragraph/text node (merged from multiple fragments)
export interface SemanticParagraphNode extends SemanticNodeBase {
  type: "paragraph"
  text: string
}

// Table cell structure
export interface TableCell {
  text: string
  row: number
  col: number
  columnHeader?: boolean
}

// Table node
export interface SemanticTableNode extends SemanticNodeBase {
  type: "table"
  text: string
  header?: string[]  // Header row cells
  rows?: string[][]  // Data rows (for splitting with header repetition)
  rawText?: string   // OCR fallback text from overlapping image
}

// Image/picture node
export interface SemanticImageNode extends SemanticNodeBase {
  type: "image"
  description?: string
}

// Comment/annotation node
export interface SemanticCommentNode extends SemanticNodeBase {
  type: "comment"
  text: string
}

// Union type
export type SemanticNode =
  | SemanticSectionNode
  | SemanticParagraphNode
  | SemanticTableNode
  | SemanticImageNode
  | SemanticCommentNode

// Type guards
export function isSectionNode(node: SemanticNode): node is SemanticSectionNode {
  return node.type === "section"
}

export function isParagraphNode(node: SemanticNode): node is SemanticParagraphNode {
  return node.type === "paragraph"
}

export function isTableNode(node: SemanticNode): node is SemanticTableNode {
  return node.type === "table"
}

export function isImageNode(node: SemanticNode): node is SemanticImageNode {
  return node.type === "image"
}

export function isCommentNode(node: SemanticNode): node is SemanticCommentNode {
  return node.type === "comment"
}