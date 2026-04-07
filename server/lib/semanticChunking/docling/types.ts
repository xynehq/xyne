/**
 * Complete Docling JSON type definitions
 * Based on real Docling output structure
 */

// Bounding box with coordinates
export interface BBox {
  l: number
  t: number
  r: number
  b: number
  coord_origin: "BOTTOMLEFT" | "TOPLEFT"
}

// Common provenance info
export interface ProvItem {
  page_no: number
  bbox: BBox
  charspan: [number, number]
}

// Reference pointer ($ref)
export interface DoclingRef {
  $ref: string
}

// Parent reference
export interface DoclingParent {
  $ref: string
}

// Table cell structure
export interface TableCell {
  text: string
  start_row_offset_idx: number
  end_row_offset_idx: number
  start_col_offset_idx: number
  end_col_offset_idx: number
  row_span: number
  col_span: number
  column_header: boolean
  row_header: boolean
  row_section: boolean
  fillable: boolean
  bbox?: BBox
  // Optional fallbacks for row/col indexing
  row?: number
  col?: number
}

// Table data
export interface TableData {
  table_cells: TableCell[]
  num_rows: number
  num_cols: number
}

// Base item properties shared across all docling items
export interface DoclingBaseItem {
  self_ref: string
  content_layer?: "body" | "furniture"
  parent?: DoclingParent
  prov?: ProvItem[]
}

// Text item (paragraphs, list items, captions, etc.)
export interface DoclingTextItem extends DoclingBaseItem {
  label: string
  text?: string
  orig?: string  // Original OCR text if different
  marker?: string  // List numbering like "1.", "[1]"
  enumerated?: boolean
  level?: number  // Heading level
  children?: DoclingRef[]
  hyperlink?: string  // URL for linked text
}

// Table structure
export interface DoclingTableItem extends DoclingBaseItem {
  label: "table"
  data: TableData
  captions: DoclingRef[]  // References to caption text items
  references: DoclingRef[]
  footnotes: DoclingRef[]
  annotations: unknown[]
}

// Image data
export interface ImageData {
  mimetype: string
  dpi: number
  size: { width: number; height: number }
  uri: string  // data:image/png;base64,... or path
}

// Picture/image
export interface DoclingPictureItem extends DoclingBaseItem {
  label: "picture"
  children?: DoclingRef[]  // May contain text annotations
  annotations: unknown[]
  image: ImageData
}

// Group container (for lists, forms, etc.)
export interface DoclingGroupItem extends DoclingBaseItem {
  label: string  // e.g., "list", "key_value_area", "ordered_list"
  name: string
  children: DoclingRef[]
}

// Key-value item (form fields)
export interface DoclingKeyValueItem extends DoclingBaseItem {
  label: "key_value_region"
  children: DoclingRef[]
  key?: DoclingTextItem  // Inline key definition (rare)
  value?: DoclingTextItem  // Inline value definition (rare)
}

// Form item
export interface DoclingFormItem extends DoclingBaseItem {
  label: string
}

// Document body/furniture root
export interface DoclingRoot {
  self_ref: string
  children: DoclingRef[]
  content_layer: "body" | "furniture"
  name: "_root_"
  label: "unspecified"
}

// Page metadata
export interface PageInfo {
  size: { width: number; height: number }
  page_no: number
}

// Main document structure
export interface DoclingDocument {
  schema_name: "DoclingDocument"
  version: string
  name: string
  origin: {
    mimetype: string
    binary_hash: number
    filename: string
  }
  furniture: DoclingRoot
  body: DoclingRoot
  groups: DoclingGroupItem[]
  texts: DoclingTextItem[]
  pictures: DoclingPictureItem[]
  tables: DoclingTableItem[]
  key_value_items: DoclingKeyValueItem[]
  form_items: DoclingFormItem[]
  pages: Record<string, PageInfo>
}

// Union type for all Docling nodes
export type DoclingNode =
  | DoclingTextItem
  | DoclingTableItem
  | DoclingPictureItem
  | DoclingGroupItem
  | DoclingKeyValueItem
  | DoclingFormItem
  | DoclingRoot

// Type guards
export function hasProv(node: DoclingNode): node is DoclingNode & { prov: ProvItem[] } {
  return Array.isArray((node as DoclingBaseItem).prov) && (node as DoclingBaseItem).prov!.length > 0
}

export function getPageNo(node: DoclingNode): number | undefined {
  return hasProv(node) ? node.prov[0].page_no : undefined
}

export function getPageNumbers(node: DoclingNode): number[] {
  if (!hasProv(node)) return []
  return Array.from(new Set(node.prov.map((p) => p.page_no)))
}

export function getBBox(node: DoclingNode): BBox | undefined {
  return hasProv(node) ? node.prov[0].bbox : undefined
}
