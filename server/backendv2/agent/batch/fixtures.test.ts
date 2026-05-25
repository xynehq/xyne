// Sanity tests over the real fixtures under `evals/` so we know they parse
// cleanly through the same code path the upload route uses. Pure parse — no
// DB, no pi-mono.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parseSource } from "./sheet"

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "..", "..", "evals")

describe("fixtures parse via the real parser", () => {
  test("batch-test-small.csv — header match", () => {
    const buf = readFileSync(join(FIXTURE_DIR, "batch-test-small.csv"))
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("question")
    expect(r.rows.length).toBe(10)
    expect(r.rows[0]!.question).toContain("Regulation 17")
    // Source has no clash with our default result columns.
    expect(r.resultColumns.answer).toBe("answer")
  })

  test("batch-test-edges.csv — header match + dropped blanks", () => {
    const buf = readFileSync(join(FIXTURE_DIR, "batch-test-edges.csv"))
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("prompt")
    // 10 rows in the source, e07 has a blank prompt → dropped → 9 ingested.
    expect(r.rows.length).toBe(9)
    // Source has 'answer' + 'model' headers → result columns must suffix.
    expect(r.resultColumns.answer).toBe("answer_xyne")
    expect(r.resultColumns.model).toBe("model_xyne")
  })

  test("batch-test-small.xlsx — XLSX path, header match", () => {
    const buf = readFileSync(join(FIXTURE_DIR, "batch-test-small.xlsx"))
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("Question")
    expect(r.rows.length).toBe(10)
    // Confirms we don't bleed into the second sheet.
    const allQs = r.rows.map((row) => row.question).join(" ")
    expect(allQs).not.toContain("This sheet should NOT")
  })

  test("batch-test-edges.xlsx — clash suffixing + blank-row drop", () => {
    const buf = readFileSync(join(FIXTURE_DIR, "batch-test-edges.xlsx"))
    const r = parseSource(buf)
    expect(r.questionColumn).toBe("prompt")
    expect(r.resultColumns.answer).toBe("answer_xyne")
    expect(r.resultColumns.model).toBe("model_xyne")
    // Blank-question row is dropped; ordinals stay contiguous.
    const ordinals = r.rows.map((x) => x.ordinal)
    expect(ordinals).toEqual([...Array(r.rows.length)].map((_, i) => i + 1))
    // Multi-line question survives the round-trip with embedded newlines.
    expect(
      r.rows.some((row) => row.question.includes("Multi-line question")),
    ).toBe(true)
  })

  test("batch-test-fallback.xlsx — no header match, falls back to first dense column", () => {
    const buf = readFileSync(join(FIXTURE_DIR, "batch-test-fallback.xlsx"))
    const r = parseSource(buf)
    // No "question"/"query"/"prompt" header → fallback should pick "Topic".
    expect(r.questionColumn).toBe("Topic")
    expect(r.rows.length).toBe(5)
  })
})
