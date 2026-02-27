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
