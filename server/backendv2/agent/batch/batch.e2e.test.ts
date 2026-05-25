// End-to-end test for v2 batch processing: service → DB → worker → result
// file. pi-mono is mocked so the test runs without LLM credentials.
//
// Requires a reachable Postgres (env DATABASE_URL or the .env defaults). It
// is hermetic in the sense that it creates a brand-new workspace + user per
// run and cleans up afterwards.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import { createId } from "@paralleldrive/cuid2"
import { readFileSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as XLSX from "xlsx"

// ─── pi-mono stub ───────────────────────────────────────────────────────────
// Replace runQuestion's pi-mono dependency before importing anything that
// transitively pulls in the runner — otherwise the real runner tries to wire
// up vespa/litellm clients on import.
mock.module("../pi-mono/runner", () => ({
  // The wrapper drops sessions in `finally`; provide a no-op so it doesn't
  // throw.
  dropSession: (_: string): void => {},
  runPiMonoTurn: async (args: { message: string }) => {
    // Deterministic fake — answer mirrors the question so we can assert on it.
    const answer = `[stub-answer] ${args.message}`
    return {
      text: answer,
      stopReason: "end_turn",
      stats: {
        tokenUsage: { input: 5, output: 10, cacheRead: 0, cacheWrite: 0 },
        cacheHitRatio: 0,
        compactionRounds: 0,
        retryAttempts: 0,
        durationMs: 12,
      },
    }
  },
}))

// Also stub agent-scope so we don't need a v1 agent row in the DB.
mock.module("../agent-scope", () => ({
  loadAgentScope: async () => null,
}))

// Stub the pg-boss queue — the test drives handleRow directly, no need for a
// running pg-boss instance.
mock.module("./queue", () => ({
  V2_BATCH_ROW_QUEUE: "v2-batch-row",
  startBatchQueue: async (): Promise<void> => {},
  stopBatchQueue: async (): Promise<void> => {},
  enqueueRows: async (): Promise<void> => {},
  workRows: async (): Promise<void> => {},
}))

import { db } from "@/db/client"
import { workspaces, users, v2BatchJobs, v2BatchRows } from "@/db/schema"
import { eq } from "drizzle-orm"

import { BatchService } from "./service"
import { handleRow } from "./worker"

// ─── Fixtures ──────────────────────────────────────────────────────────────

const makeCsv = (rows: string[][]): Buffer =>
  Buffer.from(rows.map((r) => r.join(",")).join("\n"), "utf8")

const tmpStorage = mkdtempSync(join(tmpdir(), "batch-e2e-"))
process.env["BACKENDV2_BATCH_STORAGE_DIR"] = tmpStorage
// Keep concurrency at 2 for the test so it matches production defaults.
process.env["BACKENDV2_BATCH_PER_BATCH_CONCURRENCY"] = "2"

let workspaceId = 0
let testEmail = ""

beforeAll(async () => {
  const workspaceExternalId = createId()
  testEmail = `batch-${workspaceExternalId.slice(0, 8)}@test.local`
  const [ws] = await db
    .insert(workspaces)
    .values({
      name: "batch-test-ws",
      domain: `batch-${workspaceExternalId.slice(0, 6)}.test`,
      externalId: workspaceExternalId,
      createdBy: testEmail,
    })
    .returning()
  if (!ws) throw new Error("could not seed workspace")
  workspaceId = ws.id
  await db
    .insert(users)
    .values({
      externalId: createId(),
      workspaceId,
      email: testEmail,
      name: "Batch Tester",
      photoLink: "",
      workspaceExternalId,
      role: "User" as never,
      lastLogin: new Date(),
    })
    .returning()
})

afterAll(async () => {
  // Cascades drop dependent batch_rows + the workspace's batches.
  await db.delete(v2BatchJobs).where(eq(v2BatchJobs.ownerId, testEmail))
  await db.delete(users).where(eq(users.email, testEmail))
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  rmSync(tmpStorage, { recursive: true, force: true })
})

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("BatchService end-to-end", () => {
  test("create → drain rows → result file mirrors DB state", async () => {
    const service = new BatchService()
    const csv = makeCsv([
      ["question", "tag"],
      ["What is RAG?", "t1"],
      ["What is pi-mono?", "t2"],
      ["What is batch processing?", "t3"],
    ])
    const created = await service.createBatch(
      { userId: testEmail, workspaceId: String(workspaceId) },
      {
        fileBuffer: csv,
        fileName: "qs.csv",
        fileMime: "text/csv",
        model: "Auto",
      },
    )
    expect(created.batch.totalRows).toBe(3)
    expect(created.preview.questionColumn).toBe("question")

    // Drive the worker manually so we don't need pg-boss running. Iterate
    // through the rows in DB order, calling handleRow once per row. This is
    // what the queue worker would do under real load.
    const rows = await db
      .select()
      .from(v2BatchRows)
      .where(eq(v2BatchRows.batchId, created.batch.id))
    expect(rows.length).toBe(3)

    for (const r of rows) {
      await handleRow({ batchId: created.batch.id, rowId: r.id })
    }

    // All rows should be done with the stub's deterministic answer.
    const after = await db
      .select()
      .from(v2BatchRows)
      .where(eq(v2BatchRows.batchId, created.batch.id))
    for (const r of after) {
      expect(r.status).toBe("done")
      expect(r.answer).toBe(`[stub-answer] ${r.question}`)
      expect(r.tokensIn).toBe(5)
      expect(r.tokensOut).toBe(10)
    }

    // Job should be marked completed with finishedAt set.
    const [job] = await db
      .select()
      .from(v2BatchJobs)
      .where(eq(v2BatchJobs.id, created.batch.id))
    expect(job!.status).toBe("completed")
    expect(job!.completedRows).toBe(3)
    expect(job!.erroredRows).toBe(0)
    expect(job!.finishedAt).not.toBeNull()

    // Result file exists, has the right shape, and the answer column is
    // populated for every row.
    const buf = readFileSync(job!.resultFilePath)
    const wb = XLSX.read(buf)
    const sheet = wb.Sheets[wb.SheetNames[0]!]!
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
    expect(data.length).toBe(3)
    expect(data[0]!["question"]).toBe("What is RAG?")
    expect(data[0]!["answer"]).toBe("[stub-answer] What is RAG?")
    expect(data[0]!["status"]).toBe("done")
    expect(data[0]!["model"]).toBe("Auto")
    // Original column carried through.
    expect(data[1]!["tag"]).toBe("t2")
  })

  test("partial download mid-run reflects DB state at time of read", async () => {
    const service = new BatchService()
    const csv = makeCsv([
      ["question"],
      ["q1"],
      ["q2"],
      ["q3"],
    ])
    const created = await service.createBatch(
      { userId: testEmail, workspaceId: String(workspaceId) },
      {
        fileBuffer: csv,
        fileName: "partial.csv",
        fileMime: "text/csv",
      },
    )

    // Process only the first row.
    const rows = await db
      .select()
      .from(v2BatchRows)
      .where(eq(v2BatchRows.batchId, created.batch.id))
    await handleRow({ batchId: created.batch.id, rowId: rows[0]!.id })

    // Download — should succeed because at least one row finished, and
    // partial=true because the rest are still pending.
    const dl = await service.openDownload(
      { userId: testEmail, workspaceId: String(workspaceId) },
      created.batch.id,
    )
    expect(dl.partial).toBe(true)

    // Consume the stream so the file handle is read fully (sanity check —
    // we already read the file via readFileSync in the previous test).
    const chunks: Buffer[] = []
    for await (const chunk of dl.stream as AsyncIterable<Buffer>) {
      chunks.push(chunk)
    }
    expect(chunks.length).toBeGreaterThan(0)
    const wb = XLSX.read(Buffer.concat(chunks))
    const data = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      wb.Sheets[wb.SheetNames[0]!]!,
    )
    expect(data.length).toBe(3)
    expect(data[0]!["status"]).toBe("done")
    expect(data[1]!["status"]).toBe("pending")
    expect(data[2]!["status"]).toBe("pending")
  })

  test("cancellation short-circuits remaining rows", async () => {
    const service = new BatchService()
    const csv = makeCsv([
      ["question"],
      ["x1"],
      ["x2"],
    ])
    const created = await service.createBatch(
      { userId: testEmail, workspaceId: String(workspaceId) },
      { fileBuffer: csv, fileName: "cx.csv", fileMime: "text/csv" },
    )
    await service.cancelBatch(
      { userId: testEmail, workspaceId: String(workspaceId) },
      created.batch.id,
    )
    const rows = await db
      .select()
      .from(v2BatchRows)
      .where(eq(v2BatchRows.batchId, created.batch.id))
    // After cancel, even if handleRow gets called, it must no-op.
    for (const r of rows) {
      await handleRow({ batchId: created.batch.id, rowId: r.id })
    }
    const after = await db
      .select()
      .from(v2BatchRows)
      .where(eq(v2BatchRows.batchId, created.batch.id))
    // All rows stay pending (worker short-circuited because batch is
    // cancelled).
    expect(after.every((r) => r.status === "pending")).toBe(true)
  })
})
