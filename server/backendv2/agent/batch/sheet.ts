// Sheet parsing and progressive result writing for v2 batch processing.
//
// The source file (CSV / XLS / XLSX) is parsed once at upload time —
// `parseSource` returns the list of source rows + the picked question
// column + the names we'll use for the appended answer/status columns
// (suffixed when a clash exists, e.g. `answer_xyne`).
//
// `rebuildResult` is called after every row finishes and rewrites the entire
// result file from the current row state. The DB is the source of truth; the
// file is just a materialized view. The writer goes to a tmp path then
// `rename`s atomically so a concurrent download never sees a half-written
// file. Concurrent writers from the same batch are serialized by an advisory
// lock taken in the worker before this function is called.

import { rename, writeFile } from "node:fs/promises"
import * as XLSX from "xlsx"

// ─── Types ──────────────────────────────────────────────────────────────────

/** One row as parsed from the source sheet. `columns` is keyed by the source
 *  header — order is preserved by the parser via `columnOrder`. */
export type ParsedRow = {
  ordinal: number
  question: string
  columns: Record<string, unknown>
}

/** Column names actually used in the result file. Stored on the job row so
 *  the worker writes to the same headers on every rebuild. */
export type ResultColumns = {
  answer: string
  status: string
  error: string
  model: string
  agent: string
  tokensIn: string
  tokensOut: string
  durationMs: string
}

export type ParseResult = {
  /** Header names in their source order. Drives result column ordering. */
  columnOrder: string[]
  /** Detected (or user-supplied) question column header. */
  questionColumn: string
  /** Disambiguated names for appended columns. */
  resultColumns: ResultColumns
  rows: ParsedRow[]
}

// ─── Public API ─────────────────────────────────────────────────────────────

const DEFAULT_RESULT_COLUMNS: ResultColumns = {
  answer: "answer",
  status: "status",
  error: "error",
  model: "model",
  agent: "agent",
  tokensIn: "tokens_in",
  tokensOut: "tokens_out",
  durationMs: "duration_ms",
}

/** Header heuristics — case-insensitive, trimmed. First hit wins. */
const QUESTION_HEADER_CANDIDATES = ["question", "questions", "query", "prompt", "ask"]

/** Parse a CSV / XLSX buffer into the shape the worker needs. Throws on:
 *   - workbook with no sheets
 *   - sheet with no header row
 *   - no parseable question column (auto-detection failed AND no override)
 */
export function parseSource(
  buf: Buffer,
  opts?: { questionColumn?: string },
): ParseResult {
  const workbook = XLSX.read(buf, { type: "buffer" })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) {
    throw new ParseError("workbook has no sheets")
  }
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) {
    throw new ParseError(`sheet ${sheetName} is empty`)
  }

  // `header: 1` returns an array of arrays so we keep the source column order
  // (sheet_to_json with object output reorders keys alphabetically in some
  // sheets). We then materialize each data row into a Record keyed by the
  // header strings.
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  })
  if (matrix.length === 0) {
    throw new ParseError("sheet has no rows")
  }

  const headerRow = matrix[0]
  if (!Array.isArray(headerRow) || headerRow.length === 0) {
    throw new ParseError("sheet has no header row")
  }
  const columnOrder = headerRow.map((h, i) => normalizeHeader(h, i))

  const dataRows = matrix.slice(1)
  const questionColumn = resolveQuestionColumn(columnOrder, dataRows, opts?.questionColumn)
  const resultColumns = disambiguateResultColumns(columnOrder)

  const rows: ParsedRow[] = []
  let ordinal = 0
  for (const raw of dataRows) {
    if (!Array.isArray(raw)) continue
    const record: Record<string, unknown> = {}
    for (let i = 0; i < columnOrder.length; i++) {
      const key = columnOrder[i]!
      record[key] = raw[i] ?? ""
    }
    const q = String(record[questionColumn] ?? "").trim()
    if (q.length === 0) {
      // Skip blank-question rows — common at the bottom of user sheets. Not
      // an error; the parser silently drops them.
      continue
    }
    ordinal++
    rows.push({ ordinal, question: q, columns: record })
  }
  if (rows.length === 0) {
    throw new ParseError("no rows with a non-empty question were found")
  }
  return { columnOrder, questionColumn, resultColumns, rows }
}

/** RowState is the minimum shape `rebuildResult` needs — exactly what the
 *  repo selects out of v2_batch_rows + the job's model/agent labels. Kept
 *  separate from the storage type so the writer can be unit-tested without a
 *  DB. */
export type RowState = {
  ordinal: number
  originalColumns: Record<string, unknown>
  answer: string | null
  status: "pending" | "running" | "done" | "error"
  error: string | null
  tokensIn: number | null
  tokensOut: number | null
  durationMs: number | null
}

export type RebuildArgs = {
  columnOrder: string[]
  resultColumns: ResultColumns
  modelLabel: string
  agentLabel: string
  rows: RowState[]
  outPath: string
}

/** Write a fresh XLSX to `outPath` from the current row state. Writes to a
 *  sibling `.tmp` first then renames so partially-written files never appear
 *  at the public path. */
export async function rebuildResult(args: RebuildArgs): Promise<void> {
  const { columnOrder, resultColumns, modelLabel, agentLabel, rows, outPath } = args
  const finalHeaders = [
    ...columnOrder,
    resultColumns.answer,
    resultColumns.status,
    resultColumns.error,
    resultColumns.model,
    resultColumns.agent,
    resultColumns.tokensIn,
    resultColumns.tokensOut,
    resultColumns.durationMs,
  ]

  const sorted = rows.slice().sort((a, b) => a.ordinal - b.ordinal)
  const data: unknown[][] = [finalHeaders]
  for (const row of sorted) {
    const out: unknown[] = []
    for (const col of columnOrder) {
      out.push(row.originalColumns[col] ?? "")
    }
    out.push(row.answer ?? "")
    out.push(row.status)
    out.push(row.error ?? "")
    out.push(modelLabel)
    out.push(agentLabel)
    out.push(row.tokensIn ?? "")
    out.push(row.tokensOut ?? "")
    out.push(row.durationMs ?? "")
    data.push(out)
  }
  const sheet = XLSX.utils.aoa_to_sheet(data)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, "results")
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer

  const tmp = `${outPath}.tmp`
  await writeFile(tmp, new Uint8Array(buf))
  await rename(tmp, outPath)
}

// ─── Internals ──────────────────────────────────────────────────────────────

export class ParseError extends Error {
  public override readonly name = "ParseError"
}

const normalizeHeader = (raw: unknown, index: number): string => {
  const s = String(raw ?? "").trim()
  if (s.length > 0) return s
  // Blank header — XLSX would normally drop the column. We synthesize a name
  // so the column survives the round-trip (some users leave the first column
  // unnamed for indexes).
  return `column_${index + 1}`
}

const resolveQuestionColumn = (
  columnOrder: string[],
  dataRows: unknown[][],
  override: string | undefined,
): string => {
  if (override) {
    if (!columnOrder.includes(override)) {
      throw new ParseError(
        `questionColumn "${override}" is not a header in this sheet`,
      )
    }
    return override
  }
  // Header match wins if present.
  const byHeader = columnOrder.find((h) =>
    QUESTION_HEADER_CANDIDATES.includes(h.toLowerCase()),
  )
  if (byHeader) return byHeader

  // Fallback: first column whose body is >= 80% non-empty strings.
  if (dataRows.length > 0) {
    for (let i = 0; i < columnOrder.length; i++) {
      let nonEmpty = 0
      for (const r of dataRows) {
        const v = Array.isArray(r) ? r[i] : undefined
        if (v !== undefined && v !== null && String(v).trim().length > 0) {
          nonEmpty++
        }
      }
      if (nonEmpty / dataRows.length >= 0.8) {
        return columnOrder[i]!
      }
    }
  }
  throw new ParseError(
    "could not detect a question column — please select one in the form",
  )
}

const disambiguateResultColumns = (existing: string[]): ResultColumns => {
  const used = new Set(existing.map((h) => h.toLowerCase()))
  const pick = (preferred: string): string => {
    if (!used.has(preferred.toLowerCase())) {
      used.add(preferred.toLowerCase())
      return preferred
    }
    const suffixed = `${preferred}_xyne`
    used.add(suffixed.toLowerCase())
    return suffixed
  }
  return {
    answer: pick(DEFAULT_RESULT_COLUMNS.answer),
    status: pick(DEFAULT_RESULT_COLUMNS.status),
    error: pick(DEFAULT_RESULT_COLUMNS.error),
    model: pick(DEFAULT_RESULT_COLUMNS.model),
    agent: pick(DEFAULT_RESULT_COLUMNS.agent),
    tokensIn: pick(DEFAULT_RESULT_COLUMNS.tokensIn),
    tokensOut: pick(DEFAULT_RESULT_COLUMNS.tokensOut),
    durationMs: pick(DEFAULT_RESULT_COLUMNS.durationMs),
  }
}
