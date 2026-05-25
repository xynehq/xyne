// Unit tests for the sheet parser + result writer. Pure I/O — no DB, no LLM.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as XLSX from "xlsx"

import {
  parseSource,
  rebuildResult,
  ParseError,
  type RowState,
} from "./sheet"

const makeXlsx = (rows: unknown[][]): Buffer => {
  const sheet = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, sheet, "input")
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" }) as Buffer
}

const makeCsv = (rows: string[][]): Buffer =>
  Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8")

describe("parseSource", () => {
  test("detects 'question' header (case-insensitive)", () => {
    const buf = makeXlsx([
      ["Id", "Question", "Notes"],
      [1, "What is RAG?", "n1"],
      [2, "How does pi-mono work?", "n2"],
    ])
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("Question")
    expect(r.columnOrder).toEqual(["Id", "Question", "Notes"])
    expect(r.rows.length).toBe(2)
    expect(r.rows[0]!.question).toBe("What is RAG?")
    expect(r.rows[1]!.ordinal).toBe(2)
  })

  test("falls back to first mostly-non-empty column", () => {
    const buf = makeXlsx([
      ["Topic", "Misc"],
      ["What is RAG?", ""],
      ["What is pi-mono?", ""],
    ])
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("Topic")
  })

  test("user override wins over detection", () => {
    const buf = makeXlsx([
      ["id", "Question", "AltAsk"],
      [1, "skipped", "actual"],
    ])
    const r = parseSource(buf, { questionColumn: "AltAsk" })
    expect(r.questionColumn).toBe("AltAsk")
    expect(r.rows[0]!.question).toBe("actual")
  })

  test("invalid override throws", () => {
    const buf = makeXlsx([
      ["question"],
      ["x"],
    ])
    expect(() => parseSource(buf, { questionColumn: "nonexistent" })).toThrow(
      ParseError,
    )
  })

  test("skips blank-question rows but keeps ordinal contiguous", () => {
    const buf = makeXlsx([
      ["question", "n"],
      ["a", 1],
      ["", 2],
      ["b", 3],
    ])
    const r = parseSource(buf)
    expect(r.rows.map((x) => x.question)).toEqual(["a", "b"])
    expect(r.rows.map((x) => x.ordinal)).toEqual([1, 2])
  })

  test("disambiguates result columns when source clashes", () => {
    const buf = makeXlsx([
      ["question", "answer", "model"],
      ["q1", "expected-a1", "src-m1"],
    ])
    const r = parseSource(buf)
    expect(r.resultColumns.answer).toBe("answer_xyne")
    expect(r.resultColumns.model).toBe("model_xyne")
    expect(r.resultColumns.status).toBe("status")
  })

  test("CSV parses identically to XLSX", () => {
    const buf = makeCsv([
      ["question", "tag"],
      ["a", "t1"],
      ["b", "t2"],
    ])
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("question")
    expect(r.rows.length).toBe(2)
  })

  test("empty sheet throws", () => {
    const buf = makeXlsx([])
    expect(() => parseSource(buf)).toThrow(ParseError)
  })

  test("no question column detectable", () => {
    const buf = makeXlsx([
      ["a", "b"],
      ["", ""],
      ["", ""],
    ])
    expect(() => parseSource(buf)).toThrow(ParseError)
  })
})

describe("rebuildResult", () => {
  const tmp = mkdtempSync(join(tmpdir(), "batch-test-"))

  test("writes XLSX with original + appended columns, atomic via tmp", async () => {
    const outPath = join(tmp, "result.xlsx")
    const rows: RowState[] = [
      {
        ordinal: 1,
        originalColumns: { id: 1, question: "what?" },
        answer: "because.",
        status: "done",
        error: null,
        tokensIn: 100,
        tokensOut: 50,
        durationMs: 3500,
      },
      {
        ordinal: 2,
        originalColumns: { id: 2, question: "how?" },
        answer: null,
        status: "pending",
        error: null,
        tokensIn: null,
        tokensOut: null,
        durationMs: null,
      },
    ]
    await rebuildResult({
      columnOrder: ["id", "question"],
      resultColumns: {
        answer: "answer",
        status: "status",
        error: "error",
        model: "model",
        agent: "agent",
        tokensIn: "tokens_in",
        tokensOut: "tokens_out",
        durationMs: "duration_ms",
      },
      modelLabel: "TestModel",
      agentLabel: "",
      rows,
      outPath,
    })
    const wb = XLSX.read(readFileSync(outPath))
    const sheet = wb.Sheets[wb.SheetNames[0]!]!
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    expect(data.length).toBe(2)
    expect(data[0]!["answer"]).toBe("because.")
    expect(data[0]!["status"]).toBe("done")
    expect(data[0]!["model"]).toBe("TestModel")
    expect(data[0]!["tokens_in"]).toBe(100)
    expect(data[1]!["status"]).toBe("pending")
    // Pending rows render with empty answer (not literal "null").
    expect(data[1]!["answer"]).toBe("")
  })

  test("rows are sorted by ordinal regardless of input order", async () => {
    const outPath = join(tmp, "sorted.xlsx")
    const rows: RowState[] = [
      {
        ordinal: 3,
        originalColumns: { q: "third" },
        answer: "c",
        status: "done",
        error: null,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
      },
      {
        ordinal: 1,
        originalColumns: { q: "first" },
        answer: "a",
        status: "done",
        error: null,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
      },
      {
        ordinal: 2,
        originalColumns: { q: "second" },
        answer: "b",
        status: "done",
        error: null,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: 0,
      },
    ]
    await rebuildResult({
      columnOrder: ["q"],
      resultColumns: {
        answer: "answer",
        status: "status",
        error: "error",
        model: "model",
        agent: "agent",
        tokensIn: "tokens_in",
        tokensOut: "tokens_out",
        durationMs: "duration_ms",
      },
      modelLabel: "M",
      agentLabel: "A",
      rows,
      outPath,
    })
    const wb = XLSX.read(readFileSync(outPath))
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      wb.Sheets[wb.SheetNames[0]!]!,
    )
    expect(data.map((r) => r["q"])).toEqual(["first", "second", "third"])
  })

  // Cleanup after suite.
  test.skip("__cleanup__", () => {
    rmSync(tmp, { recursive: true, force: true })
  })
})
