/**
 * Export database table rows to CSV for Knowledge Base ingestion.
 * Uses RFC 4180-style escaping so FileProcessorService (sheet/CSV path) can chunk it.
 */

import type { ColumnInfo, DbRow } from "./types"

function escapeCsvCell(value: unknown): string {
  if (value == null) return ""
  if (Buffer.isBuffer(value)) return "[binary]"
  if (typeof value === "object") {
    const s = value instanceof Date ? value.toISOString() : JSON.stringify(value)
    if (/[,\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const s = String(value)
  if (/[,\n"]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Build a CSV buffer from column names and rows (header row + data rows).
 * Column order follows columnNames; row values are taken by key.
 */
export function tableRowsToCsvBuffer(
  columnNames: string[],
  rows: DbRow[],
): Buffer {
  const header = columnNames.map(escapeCsvCell).join(",")
  const lines = [header]
  for (const row of rows) {
    const cells = columnNames.map((col) => escapeCsvCell(row[col]))
    lines.push(cells.join(","))
  }
  return Buffer.from(lines.join("\n"), "utf-8")
}

/**
 * Get ordered column names from ColumnInfo (for consistent CSV columns).
 */
export function getColumnNames(columns: ColumnInfo[]): string[] {
  return columns.map((c) => c.name)
}

/**
 * Returns the CSV header line (column names escaped). Use for streaming write.
 */
export function csvHeader(columnNames: string[]): string {
  return columnNames.map(escapeCsvCell).join(",")
}

/**
 * Returns CSV data lines for a batch of rows (no header). Ends with a newline if rows exist.
 * Use for streaming: write header first, then call this per batch and write to stream.
 */
export function rowsToCsvLines(columnNames: string[], rows: DbRow[]): string {
  if (rows.length === 0) return ""
  const lines = rows.map((row) =>
    columnNames.map((col) => escapeCsvCell(row[col])).join(","),
  )
  return lines.join("\n") + "\n"
}
