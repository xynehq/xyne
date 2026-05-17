// v2 Knowledge Base router. Mounted at /v2/kb in server/backendv2/server.ts.
//
// Wraps v1's KB helpers (db + storage + Vespa enqueue) so v2 behavior matches
// production v1 exactly. v1 routes (/api/v1/cl/*) remain untouched; we just
// reuse the same exported helpers from @/db/knowledgeBase and the storage
// path helpers from @/api/knowledgeBase.

import { Hono, type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { stream } from "hono/streaming"
import { mkdir, unlink, writeFile, stat } from "node:fs/promises"
import { createReadStream as createFileReadStream } from "node:fs"
import { dirname, extname } from "node:path"
import * as crypto from "crypto"
import { fileTypeFromBuffer } from "file-type"

import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import {
  createCollection,
  getCollectionById,
  getCollectionsByOwner,
  softDeleteCollection,
  createFolder as dbCreateFolder,
  createFileItem,
  getCollectionItemById,
  getCollectionItemsByParent,
  getCollectionFileByItemId,
  softDeleteCollectionItem,
  generateStorageKey,
  generateFileVespaDocId,
  generateCollectionVespaDocId,
} from "@/db/knowledgeBase"
import {
  getStoragePath,
  sanitizeFileName,
} from "@/api/knowledgeBase"
import {
  boss,
  FileProcessingQueue,
  PdfFileProcessingQueue,
} from "@/queue/api-server-queue"
import { DeleteDocument } from "@/search/vespa"
import { KbItemsSchema } from "@xyne/vespa-ts/types"
import { expandSheetIds } from "@/search/utils"
import { ProcessingJobType, type TxnOrClient } from "@/types"
import { UploadStatus } from "@/shared/types"
import type { Collection, CollectionItem } from "@/db/schema"
import { collectionItems } from "@/db/schema"
import { and, eq, isNull } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Api).child({ module: "backendv2/kb" })

type Vars = { jwtPayload: { sub: string; workspaceId: string } }

const router = new Hono<{ Variables: Vars }>()

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024 // 100 MB, matches v1

// ── Helpers ────────────────────────────────────────────────────────────────

type Actor = {
  id: number
  email: string
  workspaceId: number
  workspaceExternalId: string
}

const loadActor = async (c: Context<{ Variables: Vars }>): Promise<Actor> => {
  const email = c.get("jwtPayload").sub
  const users = await getUserByEmail(db, email)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const u = users[0]!
  return {
    id: u.id,
    email: u.email,
    workspaceId: u.workspaceId,
    workspaceExternalId: u.workspaceExternalId,
  }
}

const loadOwnedCollection = async (
  clId: string,
  actor: Actor,
): Promise<Collection> => {
  const collection = await getCollectionById(db, clId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  if (collection.ownerId !== actor.id) {
    throw new HTTPException(403, { message: "Forbidden" })
  }
  return collection
}

// MIME detection: magic bytes -> extension map -> browser type -> octet-stream.
// Mirrors v1's detectMimeType but inlined to avoid importing the non-exported
// function. The ext map covers the formats v1 lists; anything else falls
// through to magic bytes / browser type.
const EXT_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

const detectMime = async (
  fileName: string,
  buf: Buffer,
  browserType?: string,
): Promise<string> => {
  try {
    const sniffed = await fileTypeFromBuffer(buf)
    if (sniffed?.mime) {
      return sniffed.mime
    }
  } catch {
    // ignore
  }
  const ext = extname(fileName).toLowerCase()
  if (EXT_MIME[ext]) {
    return EXT_MIME[ext]!
  }
  if (browserType && browserType !== "application/octet-stream") {
    return browserType
  }
  return "application/octet-stream"
}

const checksum = (buf: ArrayBuffer): string =>
  crypto.createHash("sha256").update(new Uint8Array(buf)).digest("hex")

// Map a DB row -> the JSON shape ui2 consumes. ui2's BrowserEntry has
// `kind`, `id`, `name`, optional `format`/`caption`/`columns`. We send a
// superset and let the client decide what to surface.
const toEntry = (item: CollectionItem): Record<string, unknown> => ({
  id: item.id,
  name: item.name,
  type: item.type,
  parentId: item.parentId,
  path: item.path,
  mimeType: item.mimeType,
  fileSize: item.fileSize,
  uploadStatus: item.uploadStatus,
  updatedAt: item.updatedAt,
  createdAt: item.createdAt,
})

// ── Collections ────────────────────────────────────────────────────────────

// GET /v2/kb/collections
router.get("/collections", async (c) => {
  const actor = await loadActor(c)
  const rows = await getCollectionsByOwner(db, actor.id)
  return c.json({
    collections: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      totalItems: r.totalItems,
      uploadStatus: r.uploadStatus,
      isPrivate: r.isPrivate,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  })
})

// POST /v2/kb/collections  body: { name, description? }
router.post("/collections", async (c) => {
  const actor = await loadActor(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string
    description?: string
  }
  const name = (body.name ?? "").trim()
  if (!name) {
    throw new HTTPException(400, { message: "name required" })
  }
  if (name.length > 255) {
    throw new HTTPException(400, { message: "name too long" })
  }

  const vespaDocId = generateCollectionVespaDocId()
  const collection = await db.transaction(async (tx: TxnOrClient) =>
    createCollection(tx, {
      name,
      description: body.description ?? null,
      workspaceId: actor.workspaceId,
      ownerId: actor.id,
      isPrivate: true,
      lastUpdatedById: actor.id,
      lastUpdatedByEmail: actor.email,
      metadata: { vespaDocId },
    }),
  )

  // Same enqueue pattern as v1's CreateCollectionApi.
  try {
    await boss.send(
      FileProcessingQueue,
      { collectionId: collection.id, type: ProcessingJobType.COLLECTION },
      { retryLimit: 3, expireInHours: 12 },
    )
  } catch (err) {
    Logger.error({ err, collectionId: collection.id }, "queue enqueue failed")
  }

  return c.json({
    id: collection.id,
    name: collection.name,
    description: collection.description,
    totalItems: collection.totalItems,
    uploadStatus: collection.uploadStatus,
    isPrivate: collection.isPrivate,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  })
})

// DELETE /v2/kb/collections/:clId  (soft delete)
router.delete("/collections/:clId", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  await loadOwnedCollection(clId, actor)
  await db.transaction(async (tx: TxnOrClient) => {
    await softDeleteCollection(tx, clId)
  })
  return c.json({ ok: true })
})

// ── Items (folders + files) ────────────────────────────────────────────────

// GET /v2/kb/collections/:clId/items?parentId=...
router.get("/collections/:clId/items", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  await loadOwnedCollection(clId, actor)
  const parentRaw = c.req.query("parentId")
  const parentId = parentRaw && parentRaw !== "" ? parentRaw : null
  const items = await getCollectionItemsByParent(db, clId, parentId)
  return c.json({ items: items.map(toEntry) })
})

// GET /v2/kb/collections/:clId/items/:itemId/breadcrumb
// Walks parentId chain so the UI can render path segments without N fetches.
router.get("/collections/:clId/items/:itemId/breadcrumb", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  await loadOwnedCollection(clId, actor)

  const chain: { id: string; name: string }[] = []
  let cur: CollectionItem | null = await getCollectionItemById(db, itemId)
  while (cur && cur.collectionId === clId) {
    chain.unshift({ id: cur.id, name: cur.name })
    if (!cur.parentId) {
      break
    }
    cur = await getCollectionItemById(db, cur.parentId)
  }
  return c.json({ chain })
})

// POST /v2/kb/collections/:clId/folders  body: { name, parentId? }
router.post("/collections/:clId/folders", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  await loadOwnedCollection(clId, actor)

  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string
    parentId?: string | null
  }
  const name = (body.name ?? "").trim()
  if (!name) {
    throw new HTTPException(400, { message: "name required" })
  }
  if (name.length > 255) {
    throw new HTTPException(400, { message: "name too long" })
  }
  const parentId = body.parentId ?? null

  let folder: CollectionItem
  try {
    folder = await db.transaction(async (tx: TxnOrClient) =>
      dbCreateFolder(tx, clId, parentId, name, {}, actor.id, actor.email),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : "create failed"
    if (msg.includes("already exists")) {
      throw new HTTPException(409, { message: msg })
    }
    throw new HTTPException(400, { message: msg })
  }
  return c.json(toEntry(folder))
})

// DELETE /v2/kb/collections/:clId/items/:itemId
// Soft-delete + Vespa cleanup + storage unlink (folders recurse).
router.delete("/collections/:clId/items/:itemId", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  await loadOwnedCollection(clId, actor)

  const item = await getCollectionItemById(db, itemId)
  if (!item || item.collectionId !== clId) {
    throw new HTTPException(404, { message: "Item not found" })
  }

  // Collect descendants for files (so we can unlink + un-index after soft delete).
  const toCleanup: CollectionItem[] = []
  if (item.type === "file") {
    toCleanup.push(item)
  } else {
    const walk = async (parentId: string): Promise<void> => {
      const children = await db
        .select()
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.parentId, parentId),
            isNull(collectionItems.deletedAt),
          ),
        )
      for (const ch of children) {
        toCleanup.push(ch)
        if (ch.type === "folder") {
          await walk(ch.id)
        }
      }
    }
    toCleanup.push(item)
    await walk(itemId)
  }

  await db.transaction(async (tx: TxnOrClient) => {
    await softDeleteCollectionItem(tx, itemId)
  })

  for (const it of toCleanup) {
    if (it.type === "file") {
      if (it.vespaDocId) {
        for (const id of expandSheetIds(it.vespaDocId)) {
          try {
            await DeleteDocument(id, KbItemsSchema)
          } catch (err) {
            Logger.warn({ err, id }, "Vespa file delete failed")
          }
        }
      }
      if (it.storagePath) {
        try {
          await unlink(it.storagePath)
        } catch (err) {
          Logger.warn({ err, path: it.storagePath }, "storage unlink failed")
        }
      }
    } else if (it.type === "folder" && it.vespaDocId) {
      try {
        await DeleteDocument(it.vespaDocId, KbItemsSchema)
      } catch (err) {
        Logger.warn({ err, id: it.vespaDocId }, "Vespa folder delete failed")
      }
    }
  }

  return c.json({ ok: true, deletedCount: toCleanup.length })
})

// ── Upload ─────────────────────────────────────────────────────────────────
//
// POST /v2/kb/collections/:clId/upload
// multipart: files[] (one or many), parentId? (string)
//
// Basic single-pass upload — no zip extraction, no duplicate-rename strategy,
// no session batching. Each file: sanitize -> size check -> mkdir -> write ->
// insert row -> enqueue. Matches v1's per-file flow.
router.post("/collections/:clId/upload", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const collection = await loadOwnedCollection(clId, actor)

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch (err) {
    Logger.error({ err }, "formData parse failed")
    throw new HTTPException(400, { message: "Invalid multipart body" })
  }
  const parentIdRaw = formData.get("parentId")
  const parentId =
    typeof parentIdRaw === "string" && parentIdRaw !== "" ? parentIdRaw : null
  const files = formData.getAll("files").filter((f): f is File => f instanceof File)
  if (files.length === 0) {
    throw new HTTPException(400, { message: "No files provided" })
  }

  if (parentId) {
    const parent = await getCollectionItemById(db, parentId)
    if (!parent || parent.collectionId !== clId || parent.type !== "folder") {
      throw new HTTPException(400, { message: "Invalid parentId" })
    }
  }

  type Result =
    | { success: true; itemId: string; name: string }
    | { success: false; name: string; error: string }
  const results: Result[] = []

  for (const file of files) {
    const originalName = sanitizeFileName(file.name)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      results.push({
        success: false,
        name: originalName,
        error: `File too large (max ${String(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB)`,
      })
      continue
    }

    let storagePath = ""
    try {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const sum = checksum(arrayBuffer)
      const mime = await detectMime(originalName, buffer, file.type)

      const storageKey = generateStorageKey()
      const vespaDocId = generateFileVespaDocId()
      storagePath = getStoragePath(
        actor.workspaceExternalId,
        clId,
        storageKey,
        originalName,
      )

      await mkdir(dirname(storagePath), { recursive: true })
      await writeFile(storagePath, new Uint8Array(buffer))

      const item = await db.transaction(async (tx: TxnOrClient) =>
        createFileItem(
          tx,
          clId,
          parentId,
          originalName,
          vespaDocId,
          originalName,
          storagePath,
          storageKey,
          mime,
          file.size,
          sum,
          {},
          actor.id,
          actor.email,
          "File uploaded successfully, queued for processing",
        ),
      )

      // Same routing as v1 — PDFs go to the PDF queue.
      const queueName =
        mime === "application/pdf"
          ? PdfFileProcessingQueue
          : FileProcessingQueue
      try {
        await boss.send(
          queueName,
          {
            fileId: item.id,
            type: ProcessingJobType.FILE,
            useOCR: true,
          },
          { retryLimit: 3, expireInHours: 12 },
        )
      } catch (err) {
        Logger.error({ err, fileId: item.id }, "queue enqueue failed")
      }

      results.push({ success: true, itemId: item.id, name: originalName })
      Logger.info(
        { fileId: item.id, clId, ownerEmail: actor.email },
        `Uploaded ${originalName} to KB ${clId}`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload failed"
      if (storagePath) {
        try {
          await unlink(storagePath)
        } catch {
          // ignore
        }
      }
      Logger.error({ err, name: originalName }, "upload failed")
      results.push({ success: false, name: originalName, error: msg })
    }
  }

  // Touch collection updatedAt so list endpoints surface the activity.
  void collection

  return c.json({
    results,
    summary: {
      total: files.length,
      successful: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
    },
  })
})

// ── File content ───────────────────────────────────────────────────────────
//
// GET /v2/kb/collections/:clId/files/:itemId/content
// Streams inline file bytes with Range support so react-pdf can chunk loads.
router.get("/collections/:clId/files/:itemId/content", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  await loadOwnedCollection(clId, actor)

  const item = await getCollectionItemById(db, itemId)
  if (!item || item.collectionId !== clId || item.type !== "file") {
    throw new HTTPException(404, { message: "File not found" })
  }
  const file = await getCollectionFileByItemId(db, itemId)
  if (!file || !file.storagePath) {
    throw new HTTPException(404, { message: "File data not found" })
  }

  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(file.storagePath)
  } catch {
    throw new HTTPException(404, { message: "File content not found on disk" })
  }
  const fileSize = stats.size
  const range = c.req.header("range")
  const mimeType = file.mimeType || "application/octet-stream"
  const dispositionName = encodeURIComponent(file.originalName || "file")

  const baseHeaders: Record<string, string> = {
    "Content-Type": mimeType,
    "Content-Disposition": `inline; filename*=UTF-8''${dispositionName}`,
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
  }

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (!m) {
      throw new HTTPException(416, { message: "Invalid range" })
    }
    const startStr = m[1] ?? ""
    const endStr = m[2] ?? ""
    let start: number
    let end: number
    if (startStr === "" && endStr !== "") {
      const suffix = parseInt(endStr, 10)
      if (Number.isNaN(suffix) || suffix <= 0) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${String(fileSize)}` },
        })
      }
      start = Math.max(0, fileSize - suffix)
      end = fileSize - 1
    } else {
      start = startStr ? parseInt(startStr, 10) : 0
      end = endStr ? parseInt(endStr, 10) : fileSize - 1
    }
    if (
      Number.isNaN(start) ||
      Number.isNaN(end) ||
      start > end ||
      end >= fileSize
    ) {
      return new Response("Range Not Satisfiable", {
        status: 416,
        headers: { "Content-Range": `bytes */${String(fileSize)}` },
      })
    }
    const chunkSize = end - start + 1
    const sp = file.storagePath
    return stream(c, async (w) => {
      c.header("Content-Range", `bytes ${String(start)}-${String(end)}/${String(fileSize)}`)
      c.header("Content-Length", String(chunkSize))
      for (const [k, v] of Object.entries(baseHeaders)) {
        c.header(k, v)
      }
      c.status(206)
      const rs = createFileReadStream(sp, { start, end, highWaterMark: 64 * 1024 })
      await new Promise<void>((resolve, reject) => {
        rs.on("data", async (chunk) => {
          try {
            await w.write(chunk as Buffer)
          } catch (e) {
            rs.destroy()
            reject(e)
          }
        })
        rs.on("end", () => {
          resolve()
        })
        rs.on("error", reject)
      })
    })
  }

  const sp = file.storagePath
  return stream(c, async (w) => {
    c.header("Content-Length", String(fileSize))
    for (const [k, v] of Object.entries(baseHeaders)) {
      c.header(k, v)
    }
    c.status(200)
    const rs = createFileReadStream(sp, { highWaterMark: 64 * 1024 })
    await new Promise<void>((resolve, reject) => {
      rs.on("data", async (chunk) => {
        try {
          await w.write(chunk as Buffer)
        } catch (e) {
          rs.destroy()
          reject(e)
        }
      })
      rs.on("end", () => {
        resolve()
      })
      rs.on("error", reject)
    })
  })
})

// Suppress unused-import warning for UploadStatus (kept for future status polling).
void UploadStatus

export default router
