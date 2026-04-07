/**
 * Docling label categorization and mapping
 *
 * Based on all label types found in docling test data:
 * - text, paragraph, list_item, caption, formula, code, footnote, inline
 * - key, value (from key-value pairs)
 * - section_header, title, subtitle (section boundaries)
 * - picture, table, image (non-text items)
 * - Various form/structural elements (ignored)
 */

import type { DoclingTextItem } from "./types"

// Labels that contain actual text content
export const TEXT_LIKE_LABELS = new Set([
  // Basic text content
  "text",
  "paragraph",
  "list_item",
  "caption",
  "formula",
  "code",
  "reference",
  "handwritten_text",
  "footnote",
  // Inline text elements
  "inline",
  // Key-value pair content
  "key",
  "value",
  "key_value_region",
])

// Labels that indicate section boundaries
export const SECTION_LABELS = new Set([
  "section_header",
  "title",
  "subtitle",
])

// Labels to ignore (structural containers, not content)
export const IGNORE_LABELS = new Set([
  // Page furniture
  "page_header",
  "page_footer",
  // TOC/Index
  "document_index",
  // List containers (list_items are separate)
  "list",
  "ordered_list",
  // Group containers
  "key_value_area",
  "form_area",
  // Form structural elements
  "form",
  "grading_scale",
  "empty_value",
  "checkbox_selected",
  "checkbox_unselected",
  "field_region",
  "field_heading",
  "field_item",
  "field_key",
  "field_value",
  "field_hint",
  "marker",
  // Relationship markers
  "to_child",
  "to_value",
  // Generic containers
  "unspecified",
  // Section containers (section_header is the content)
  "section",
  // Picture containers
  "picture_area",
])

// Labels that are comments/annotations (attached to context, not standalone)
export const COMMENT_LABELS = new Set([
  "comment_section",
])

// Mapping from Docling labels to semantic types
export type SemanticType = "text" | "section" | "table" | "image" | "comment" | "ignore" | "unknown"

/**
 * Map a Docling label to its semantic type
 */
export function mapDoclingLabel(label: string): SemanticType {
  if (TEXT_LIKE_LABELS.has(label)) return "text"
  if (SECTION_LABELS.has(label)) return "section"
  if (label === "table") return "table"
  if (label === "picture" || label === "chart" || label === "image") return "image"
  if (COMMENT_LABELS.has(label)) return "comment"
  if (IGNORE_LABELS.has(label)) return "ignore"
  return "unknown"
}

/**
 * Type guard: Check if label is text-like content
 */
export function isTextLike(label: string): boolean {
  return TEXT_LIKE_LABELS.has(label)
}

/**
 * Type guard: Check if label is a section header
 */
export function isSection(label: string): boolean {
  return SECTION_LABELS.has(label)
}

/**
 * Type guard: Check if label should be ignored
 */
export function isIgnorable(label: string): boolean {
  return IGNORE_LABELS.has(label)
}

/**
 * Check if content layer is body (not furniture/header/footer)
 */
export function isBodyContent(node: DoclingTextItem): boolean {
  return !node.content_layer || node.content_layer === "body"
}
