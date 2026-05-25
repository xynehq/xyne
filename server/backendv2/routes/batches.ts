// v2 batch processing router. Mounted at /v2/batches in
// server/backendv2/server.ts.
//
// Thin Hono wrapper around BatchService — same shape as routes/chat.ts:
// auth + permission live in the service, HTTP shaping lives here.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { stream } from "hono/streaming"

import {
  AgentNotAccessibleError,
  BatchBadRequestError,
  BatchConflictError,
  BatchForbiddenError,
  BatchNotFoundError,
  BatchService,
  type Viewer,
} from "../agent/batch/service"

type Vars = {
  jwtPayload: { sub: string; workspaceId: string }
}

const service = new BatchService()

const router = new Hono<{ Variables: Vars }>()

const viewerFrom = (c: Context<{ Variables: Vars }>): Viewer => {
  const p = c.get("jwtPayload")
  return { userId: p.sub, workspaceId: p.workspaceId }
}

const handle = async (
  c: Context,
  fn: () => Promise<Response | object>,
): Promise<Response> => {
  try {
    const result = await fn()
    if (result instanceof Response) return result
    return c.json(result)
  } catch (err) {
    if (err instanceof BatchNotFoundError) {
      throw new HTTPException(404, { message: err.message })
    }
    if (err instanceof BatchForbiddenError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof AgentNotAccessibleError) {
      throw new HTTPException(403, { message: err.message })
    }
    if (err instanceof BatchBadRequestError) {
      throw new HTTPException(400, { message: err.message })
    }
    if (err instanceof BatchConflictError) {
      throw new HTTPException(409, { message: err.message })
    }
    if (err instanceof HTTPException) throw err
    const message = err instanceof Error ? err.message : "Internal error"
    throw new HTTPException(500, { message })
  }
}

// POST /v2/batches  (multipart)
router.post("/", (c) =>
  handle(c, async () => {
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw new BatchBadRequestError("multipart body required")
    }
    const file = form.get("file")
    if (!(file instanceof File)) {
      throw new BatchBadRequestError("file field required")
    }
    const model = typeof form.get("model") === "string"
      ? (form.get("model") as string)
      : undefined
    const agentId = typeof form.get("agentId") === "string"
      ? (form.get("agentId") as string)
      : undefined
    const questionColumn =
      typeof form.get("questionColumn") === "string"
        ? (form.get("questionColumn") as string)
        : undefined

    const buf = Buffer.from(await file.arrayBuffer())
    return service.createBatch(viewerFrom(c), {
      fileBuffer: buf,
      fileName: file.name || "upload.xlsx",
      fileMime: file.type || "application/octet-stream",
      ...(model ? { model } : {}),
      ...(agentId ? { agentId } : {}),
      ...(questionColumn ? { questionColumn } : {}),
    })
  }),
)

// GET /v2/batches?limit&before
router.get("/", (c) =>
  handle(c, async () => {
    const limitRaw = c.req.query("limit")
    const beforeRaw = c.req.query("before")
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
    const before = beforeRaw ? Number.parseInt(beforeRaw, 10) : undefined
    return service.listBatches(viewerFrom(c), {
      ...(limit !== undefined ? { limit } : {}),
      ...(before !== undefined ? { before } : {}),
    })
  }),
)

// GET /v2/batches/:id
router.get("/:id", (c) =>
  handle(c, async () => service.getBatch(viewerFrom(c), c.req.param("id"))),
)

// GET /v2/batches/:id/rows
router.get("/:id/rows", (c) =>
  handle(c, async () => {
    const limitRaw = c.req.query("limit")
    const afterRaw = c.req.query("after")
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
    const afterOrdinal = afterRaw ? Number.parseInt(afterRaw, 10) : undefined
    return service.listRows(viewerFrom(c), c.req.param("id"), {
      ...(limit !== undefined ? { limit } : {}),
      ...(afterOrdinal !== undefined ? { afterOrdinal } : {}),
    })
  }),
)

// POST /v2/batches/:id/cancel
router.post("/:id/cancel", (c) =>
  handle(c, async () => {
    await service.cancelBatch(viewerFrom(c), c.req.param("id"))
    return { ok: true }
  }),
)

// DELETE /v2/batches/:id  (soft delete / archive)
router.delete("/:id", (c) =>
  handle(c, async () => {
    await service.archiveBatch(viewerFrom(c), c.req.param("id"))
    return { ok: true }
  }),
)

// GET /v2/batches/:id/download
router.get("/:id/download", (c) =>
  handle(c, async () => {
    const { job, stream: readStream, contentLength, partial } =
      await service.openDownload(viewerFrom(c), c.req.param("id"))
    const downloadName = `${job.name}_result${partial ? "_partial" : ""}.xlsx`
    c.header(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    c.header(
      "Content-Disposition",
      `attachment; filename="${downloadName.replace(/"/g, "")}"`,
    )
    c.header("Content-Length", String(contentLength))
    if (partial) c.header("X-Batch-Partial", "true")
    return stream(c, async (s) => {
      // Pipe a Node ReadableStream into hono's streaming response by reading
      // chunks. Avoids loading the whole file into memory for large results.
      for await (const chunk of readStream as AsyncIterable<Buffer>) {
        await s.write(new Uint8Array(chunk))
      }
    })
  }),
)

export default router
