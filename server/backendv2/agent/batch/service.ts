// BatchService — owner-only business logic on top of the batch repo + queue.
// Auth checks live here, not in the routes.

import { createReadStream } from "node:fs"
import { join } from "node:path"
import { mkdir, stat, unlink } from "node:fs/promises"

import { baseLogger } from "../log"
import { loadAgentScope } from "../agent-scope"
import {
  bulkInsertRows,
  createJob,
  getJob,
  getRow,
  listJobsByOwner,
  listRowsByBatch,
  newBatchId,
  newRowId,
  patchJob,
  type BatchJob,
  type BatchRow,
} from "./repo"
import { parseSource, type ParseResult } from "./sheet"
import { enqueueRows } from "./queue"

const Logger = baseLogger("backendv2/batch/service")

// ─── Errors ─────────────────────────────────────────────────────────────────

export class BatchNotFoundError extends Error {
  public override readonly name = "BatchNotFoundError"
  public constructor(public readonly id: string) {
    super(`Batch ${id} not found`)
  }
}

export class BatchForbiddenError extends Error {
  public override readonly name = "BatchForbiddenError"
}

export class AgentNotAccessibleError extends Error {
  public override readonly name = "AgentNotAccessibleError"
}

export class BatchBadRequestError extends Error {
  public override readonly name = "BatchBadRequestError"
}

export class BatchConflictError extends Error {
  public override readonly name = "BatchConflictError"
}

// ─── Public types ───────────────────────────────────────────────────────────

export type Viewer = {
  userId: string
  workspaceId: string
}

export type CreateBatchInput = {
  fileBuffer: Buffer
  fileName: string
  fileMime: string
  model?: string
  agentId?: string
  questionColumn?: string
}

export type CreateBatchResult = {
  batch: BatchJob
  preview: {
    columns: string[]
    questionColumn: string
    sampleRows: Array<Record<string, unknown>>
    totalRows: number
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const STORAGE_ROOT =
  process.env["BACKENDV2_BATCH_STORAGE_DIR"] ??
  join(process.cwd(), "storage", "v2_batches")

const MAX_FILE_BYTES = Number.parseInt(
  process.env["BACKENDV2_BATCH_MAX_FILE_BYTES"] ?? String(25 * 1024 * 1024),
  10,
)
const MAX_ROWS = Number.parseInt(
  process.env["BACKENDV2_BATCH_MAX_ROWS"] ?? "5000",
  10,
)

const batchDir = (batchId: string, workspaceId: string): string =>
  join(STORAGE_ROOT, workspaceId, batchId)

const sanitizeFileName = (raw: string): string => {
  const base = raw.replace(/[^\w.\-]+/g, "_")
  return base.length > 0 ? base : "upload"
}

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, "")

const assertOwner = (job: BatchJob, viewer: Viewer): void => {
  if (job.ownerId !== viewer.userId) {
    throw new BatchForbiddenError("Not your batch")
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class BatchService {
  public async createBatch(
    viewer: Viewer,
    input: CreateBatchInput,
  ): Promise<CreateBatchResult> {
    if (!input.fileBuffer || input.fileBuffer.length === 0) {
      throw new BatchBadRequestError("file is empty")
    }
    if (input.fileBuffer.length > MAX_FILE_BYTES) {
      throw new BatchBadRequestError(
        `file too large (max ${String(MAX_FILE_BYTES / 1024 / 1024)} MB)`,
      )
    }

    // Parse first — fail fast if the sheet is malformed.
    let parsed: ParseResult
    try {
      parsed = parseSource(input.fileBuffer, {
        ...(input.questionColumn ? { questionColumn: input.questionColumn } : {}),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "could not parse sheet"
      throw new BatchBadRequestError(msg)
    }
    if (parsed.rows.length > MAX_ROWS) {
      throw new BatchBadRequestError(
        `too many rows (${String(parsed.rows.length)} > max ${String(MAX_ROWS)})`,
      )
    }

    // Validate agent at create time so the user sees a 403 immediately if
    // they don't have access — instead of having every row error out at run
    // time. We discard the resolved scope; the worker loads it fresh anyway.
    if (input.agentId) {
      const scope = await loadAgentScope(
        {
          userId: viewer.userId as never,
          workspaceId: viewer.workspaceId as never,
        },
        input.agentId,
      )
      if (!scope) {
        throw new AgentNotAccessibleError(
          `agent ${input.agentId} is not accessible`,
        )
      }
    }

    const batchId = newBatchId()
    const dir = batchDir(batchId, viewer.workspaceId)
    await mkdir(dir, { recursive: true })
    const safeName = sanitizeFileName(input.fileName)
    const sourceFilePath = join(dir, `source_${safeName}`)
    const resultFilePath = join(dir, "result.xlsx")
    await Bun.write(sourceFilePath, input.fileBuffer)

    const job = await createJob({
      id: batchId,
      ownerId: viewer.userId,
      workspaceId: viewer.workspaceId,
      name: stripExt(safeName),
      model: input.model ?? null,
      agentId: input.agentId ?? null,
      questionColumn: parsed.questionColumn,
      columnOrder: parsed.columnOrder,
      resultColumns: parsed.resultColumns,
      sourceFilePath,
      sourceMime: input.fileMime,
      resultFilePath,
      totalRows: parsed.rows.length,
    })

    // Bulk insert rows, then bulk enqueue. Ordering matters: rows must exist
    // in DB before any worker picks up its job.
    const rowInputs = parsed.rows.map((r) => ({
      id: newRowId(),
      batchId: job.id,
      ordinal: r.ordinal,
      question: r.question,
      originalColumns: r.columns,
    }))
    await bulkInsertRows(rowInputs)
    await enqueueRows(
      rowInputs.map((r) => ({ batchId: job.id, rowId: r.id })),
    )

    // Flip to `running` — workers may already be picking up jobs.
    await patchJob(job.id, { status: "running", startedAt: Date.now() })
    Logger.info(
      {
        batchId: job.id,
        rows: rowInputs.length,
        questionColumn: parsed.questionColumn,
      },
      "batch created and enqueued",
    )

    return {
      batch: { ...job, status: "running", startedAt: Date.now() },
      preview: {
        columns: parsed.columnOrder,
        questionColumn: parsed.questionColumn,
        sampleRows: parsed.rows.slice(0, 5).map((r) => r.columns),
        totalRows: parsed.rows.length,
      },
    }
  }

  public async listBatches(
    viewer: Viewer,
    opts: { limit?: number; before?: number },
  ): Promise<{ batches: BatchJob[] }> {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200))
    const batches = await listJobsByOwner(viewer.userId, {
      limit,
      ...(opts.before ? { before: opts.before } : {}),
    })
    return { batches }
  }

  public async getBatch(viewer: Viewer, id: string): Promise<BatchJob> {
    const job = await getJob(id)
    if (!job) throw new BatchNotFoundError(id)
    assertOwner(job, viewer)
    return job
  }

  public async listRows(
    viewer: Viewer,
    id: string,
    opts: { limit?: number; afterOrdinal?: number },
  ): Promise<{ rows: BatchRow[] }> {
    await this.getBatch(viewer, id) // permission check
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000))
    const rows = await listRowsByBatch(id, {
      limit,
      ...(opts.afterOrdinal !== undefined
        ? { afterOrdinal: opts.afterOrdinal }
        : {}),
    })
    return { rows }
  }

  public async cancelBatch(viewer: Viewer, id: string): Promise<void> {
    const job = await this.getBatch(viewer, id)
    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      throw new BatchConflictError(`batch is already ${job.status}`)
    }
    await patchJob(id, {
      status: "cancelled",
      finishedAt: Date.now(),
    })
  }

  public async archiveBatch(viewer: Viewer, id: string): Promise<void> {
    const job = await this.getBatch(viewer, id)
    await patchJob(id, { archivedAt: Date.now() })
    // Best-effort file cleanup; if it fails we still hide the row.
    await unlink(job.sourceFilePath).catch(() => {})
    await unlink(job.resultFilePath).catch(() => {})
  }

  /** Returns a (Node) ReadableStream for the result file. Caller is
   *  responsible for setting Content-Disposition / Content-Type. The result
   *  file always exists after at least one row has been processed; if not,
   *  we throw a 409 so the UI can show "no answers yet". */
  public async openDownload(
    viewer: Viewer,
    id: string,
  ): Promise<{
    job: BatchJob
    stream: NodeJS.ReadableStream
    contentLength: number
    partial: boolean
  }> {
    const job = await this.getBatch(viewer, id)
    let st: import("node:fs").Stats
    try {
      st = await stat(job.resultFilePath)
    } catch {
      throw new BatchConflictError(
        "result file not ready yet — wait for at least one row to finish",
      )
    }
    const stream = createReadStream(job.resultFilePath)
    return {
      job,
      stream,
      contentLength: st.size,
      partial: job.status !== "completed",
    }
  }
}
