/**
 * Extract text from Docling nodes recursively
 */

import type {
  DoclingTextItem,
  DoclingTableItem,
  TableCell,
} from "./types"

/**
 * Extract text from a single node (NOT recursive)
 * The main traversal loop handles walking the tree to prevent double-processing
 *
 * This is a simple function that just formats a single text node's content
 * Includes hyperlink URL if present: "[text](url)" format
 */
export function extractNodeText(node: DoclingTextItem): string {
  const parts: string[] = []

  // Add marker if present (for lists)
  if (node.marker) {
    parts.push(node.marker)
  }

  let text = node.text ?? ""

  // Include hyperlink if present
  if (node.hyperlink && text) {
    text = `[${text}](${node.hyperlink})`
  }

  if (text) {
    parts.push(text)
  }

  return parts.join(" ").trim()
}

/**
 * Extract text from a table cell, preserving hyperlinks
 */
function extractTableCellText(cell: TableCell): string {
  let text = cell.text ?? ""

  // Handle hyperlinks in table cells if present
  // Docling may store hyperlink in cell metadata
  if ((cell as any).hyperlink && text) {
    text = `[${text}](${(cell as any).hyperlink})`
  }

  return text
}

/**
 * Extract table structure (header + data rows) from Docling table
 */
export function extractTableStructure(table: DoclingTableItem): {
  header: string[]
  rows: string[][]
  text: string
} {
  const cells = table.data?.table_cells || []

  if (cells.length === 0) {
    return { header: [], rows: [], text: "[empty table]" }
  }

  // Group cells by row
  const rowMap = new Map<number, string[]>()

  for (const cell of cells) {
    const rowIdx = cell.start_row_offset_idx ?? cell.row ?? 0
    const colIdx = cell.start_col_offset_idx ?? cell.col ?? 0

    if (!rowMap.has(rowIdx)) {
      rowMap.set(rowIdx, [])
    }

    const row = rowMap.get(rowIdx)!
    // Ensure array is large enough
    while (row.length <= colIdx) {
      row.push("")
    }
    row[colIdx] = extractTableCellText(cell)
  }

  // Find header row index (column_header === true)
  let headerRowIndex: number | null = null
  for (const cell of cells) {
    if (cell.column_header === true) {
      headerRowIndex = cell.start_row_offset_idx ?? cell.row ?? 0
      break
    }
  }

  // Sort rows by index
  const sortedEntries = Array.from(rowMap.entries()).sort((a, b) => a[0] - b[0])

  // If no header found, use first row as fallback
  if (headerRowIndex === null && sortedEntries.length > 0) {
    headerRowIndex = sortedEntries[0][0]
  }

  let header: string[] = []
  const dataRows: string[][] = []

  for (const [idx, row] of sortedEntries) {
    if (idx === headerRowIndex) {
      header = row
    } else if (headerRowIndex !== null && idx > headerRowIndex) {
      dataRows.push(row)
    }
  }

  // Build full text representation
  const allRows = [header, ...dataRows]
  const text = allRows.map(cells => cells.join(" | ")).join("\n")

  return { header, rows: dataRows, text }
}

/**
 * Check if text is just noise (page numbers, separators, etc.)
 */
export function isNoiseText(text: string): boolean {
  const trimmed = text.trim()
  
  if (trimmed.length === 0) return true
  if (trimmed.length < 3) return true
  if (/^-{3,}$/.test(trimmed)) return true
  if (/^_{3,}$/.test(trimmed)) return true
  if (/^(page\s+\d+|pg\.?\s*\d+|\d+\s*\/\s*\d+)$/i.test(trimmed)) return true
  
  return false
}