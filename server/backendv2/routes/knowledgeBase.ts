// v2 Knowledge Base router. Mounted at /v2/kb in server/backendv2/server.ts.
//
// Wraps v1's KB helpers (db + storage + Vespa enqueue) so v2 behavior matches
// production v1 exactly. v1 routes (/api/v1/cl/*) remain untouched; we just
// reuse the same exported helpers from @/db/knowledgeBase and the storage
// path helpers from @/api/knowledgeBase.

import * as crypto from "crypto"
import { createReadStream as createFileReadStream } from "node:fs"
import { mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, extname } from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { stream } from "hono/streaming"

import { getStoragePath, sanitizeFileName } from "@/api/knowledgeBase"
import config from "@/config"
import { db } from "@/db/client"
import {
  createCollection,
  createFileItem,
  createFolder as dbCreateFolder,
  generateCollectionVespaDocId,
  generateFileVespaDocId,
  generateStorageKey,
  getAccessibleCollections,
  getCollectionById,
  getCollectionFileByItemId,
  getCollectionItemById,
  getCollectionItemsByParent,
  getCollectionItemsByParentPaginated,
  getCollectionsByOwner,
  softDeleteCollection,
  softDeleteCollectionItem,
} from "@/db/knowledgeBase"
import type { Collection, CollectionItem } from "@/db/schema"
import { collectionItems } from "@/db/schema"
import { getUserByEmail } from "@/db/user"
import { queuePdfForDoclingScheduler } from "@/lib/doclingSchedulerIntake"
import { getLogger } from "@/logger"
import {
  FileProcessingQueue,
  PdfFileProcessingQueue,
  boss,
} from "@/queue/api-server-queue"
import { expandSheetIds } from "@/search/utils"
import { DeleteDocument, GetDocumentsByDocIds } from "@/search/vespa"
import { UploadStatus } from "@/shared/types"
import { getTracer } from "@/tracer"
import { ProcessingJobType, type TxnOrClient } from "@/types"
import { Subsystem } from "@/types"
import { KbItemsSchema } from "@xyne/vespa-ts/types"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"

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

/** Capability bundle returned by `loadCollection`. The flag is the single
 *  authority on whether a viewer can mutate; both endpoints that shape it
 *  into the response and endpoints that gate writes consume the same value. */
type CollectionAccess = { collection: Collection; canWrite: boolean }

/** Enforce read access and compute the viewer's capability in one pass.
 *  Throws 404 if the collection doesn't exist, 403 if the viewer has no
 *  access. Read rule mirrors v1's `canViewCollection`
 *  (`server/api/knowledgeBase.ts:262`): owner OR not private OR explicitly
 *  granted via `permissions[]`. Write rule is owner-only — surfaced as the
 *  `canWrite` flag instead of a second helper so the rule lives in one place.
 *  Mutating endpoints call `assertCanWrite(access)` immediately after to
 *  reject non-owners with a 403. */
const loadCollection = async (
  clId: string,
  actor: Actor,
): Promise<CollectionAccess> => {
  const collection = await getCollectionById(db, clId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  const isOwner = collection.ownerId === actor.id
  if (isOwner) {
    return { collection, canWrite: true }
  }
  if (collection.isPrivate === false) {
    return { collection, canWrite: false }
  }
  const permitted = Array.isArray(collection.permissions)
    ? (collection.permissions as unknown[]).includes(actor.id)
    : false
  if (!permitted) {
    throw new HTTPException(403, { message: "Forbidden" })
  }
  return { collection, canWrite: false }
}

/** Mutation gate. Call directly after `loadCollection` on any endpoint that
 *  changes the collection (upload, create folder, delete, rename). Throws
 *  403 with the same "Owner only" message v1 uses for symmetry. */
const assertCanWrite = (access: CollectionAccess): void => {
  if (!access.canWrite) {
    throw new HTTPException(403, { message: "Owner only" })
  }
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
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
      // True only for the owner. The UI uses this to hide owner-only
      // affordances (upload, new folder, delete) on shared/public
      // collections — non-owners only get read.
      canWrite: r.ownerId === actor.id,
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
  assertCanWrite(await loadCollection(clId, actor))
  await db.transaction(async (tx: TxnOrClient) => {
    await softDeleteCollection(tx, clId)
  })
  return c.json({ ok: true })
})

// ── Items (folders + files) ────────────────────────────────────────────────

// GET /v2/kb/collections/:clId/items?parentId=...&limit=&offset=
router.get("/collections/:clId/items", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const { canWrite } = await loadCollection(clId, actor)
  const parentRaw = c.req.query("parentId")
  const parentId = parentRaw && parentRaw !== "" ? parentRaw : null

  const limitRaw = c.req.query("limit")
  if (limitRaw !== undefined && limitRaw !== "") {
    const parsedLimit = Number.parseInt(limitRaw, 10)
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 200)
      : 50
    const offsetRaw = c.req.query("offset")
    const parsedOffset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0
    const { items, total, folderCount, fileCount } =
      await getCollectionItemsByParentPaginated(db, clId, parentId, {
        limit,
        offset,
      })
    return c.json({
      items: items.map(toEntry),
      total,
      folderCount,
      fileCount,
      hasMore: offset + items.length < total,
      canWrite,
    })
  }

  const items = await getCollectionItemsByParent(db, clId, parentId)
  let folderCount = 0
  let fileCount = 0
  for (const it of items) {
    if (it.type === "folder") {
      folderCount += 1
    } else {
      fileCount += 1
    }
  }
  return c.json({
    items: items.map(toEntry),
    total: items.length,
    folderCount,
    fileCount,
    hasMore: false,
    // Echo write capability so a UI that deep-links into a collection
    // (without hitting /collections first) can hide owner-only buttons.
    canWrite,
  })
})

// GET /v2/kb/collections/:clId/items/:itemId/breadcrumb
// Walks parentId chain so the UI can render path segments without N fetches.
router.get("/collections/:clId/items/:itemId/breadcrumb", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  await loadCollection(clId, actor)

  const chain: { id: string; name: string }[] = []
  let cur: CollectionItem | null = await getCollectionItemById(db, itemId)
  // Capture the leaf's vespaDocId on the way up so the UI can show
  // the "View Vespa document" affordance in the PDF viewer toolbar
  // (chat citations already pass it through CitationTab; KB route
  // doesn't have it and needs to read it from here).
  const leafVespaDocId =
    cur && cur.collectionId === clId ? (cur.vespaDocId ?? null) : null
  while (cur && cur.collectionId === clId) {
    chain.unshift({ id: cur.id, name: cur.name })
    if (!cur.parentId) {
      break
    }
    cur = await getCollectionItemById(db, cur.parentId)
  }
  return c.json({ chain, vespaDocId: leafVespaDocId })
})

// POST /v2/kb/collections/:clId/folders  body: { name, parentId? }
router.post("/collections/:clId/folders", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  assertCanWrite(await loadCollection(clId, actor))

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
  assertCanWrite(await loadCollection(clId, actor))

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
  const access = await loadCollection(clId, actor)
  assertCanWrite(access)
  const collection = access.collection

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
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File)
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

      try {
        const useDoclingSchedulerForPdf =
          mime === "application/pdf" &&
          config.doclingEnabled &&
          config.doclingAsyncEnabled &&
          config.doclingAsyncSchedulerEnabled

        if (useDoclingSchedulerForPdf) {
          const { schedulerFile, sourceKind, basePriority } =
            await queuePdfForDoclingScheduler({
              fileId: item.id,
              vespaDocId: item.vespaDocId,
              collectionId: item.collectionId,
              parentId: item.parentId,
              collectionName: collection.name,
              fileName: item.name,
              originalName: item.originalName,
              storagePath: item.storagePath,
              path: item.path,
              mimeType: item.mimeType || mime,
              fileSize: item.fileSize,
              uploadedByEmail: item.uploadedByEmail,
              metadata: item.metadata,
            })
          Logger.info(
            {
              fileId: item.id,
              sourceKind,
              basePriority,
              queuedThroughDoclingScheduler: Boolean(schedulerFile),
            },
            schedulerFile
              ? "Queued uploaded PDF directly for async Docling scheduler"
              : "Skipped direct async Docling scheduler queue because file already exists there",
          )
        } else {
          const queueName =
            mime === "application/pdf"
              ? PdfFileProcessingQueue
              : FileProcessingQueue
          await boss.send(
            queueName,
            {
              fileId: item.id,
              type: ProcessingJobType.FILE,
              useOCR: true,
            },
            { retryLimit: 3, expireInHours: 12 },
          )
        }
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
//
// Local-dev fallback: when DB + Vespa are tunneled to the VM but file blobs
// aren't (the common dev setup), set `KB_CONTENT_PROXY_URL` to forward this
// request to the deployed instance. The user's access-token cookie is
// reusable because the JWT secret is shared with the VM. When the env is
// unset we hit the local disk as usual.
router.get("/collections/:clId/files/:itemId/content", async (c) => {
  const actor = await loadActor(c)
  const clId = c.req.param("clId")
  const itemId = c.req.param("itemId")
  await loadCollection(clId, actor)

  const proxyBase = process.env["KB_CONTENT_PROXY_URL"]
  if (proxyBase) {
    const target = `${proxyBase.replace(/\/$/, "")}${c.req.path}`
    const forwardHeaders: Record<string, string> = {}
    const cookie = c.req.header("cookie")
    if (cookie) forwardHeaders["cookie"] = cookie
    const range = c.req.header("range")
    if (range) forwardHeaders["range"] = range
    const upstream = await fetch(target, {
      method: "GET",
      headers: forwardHeaders,
      redirect: "follow",
    })
    const passthrough = new Headers()
    // `Headers.forEach` is the spec-mandated traversal that's typed in
    // every TS lib variant; the iterator and `.entries()` forms aren't
    // (the @types/node Headers shim ships neither). Same drop-list as
    // before: hop-by-hop headers and set-cookie don't get passed
    // through.
    upstream.headers.forEach((v, k) => {
      const lk = k.toLowerCase()
      if (
        lk === "set-cookie" ||
        lk === "transfer-encoding" ||
        lk === "connection"
      ) {
        return
      }
      passthrough.set(k, v)
    })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: passthrough,
    })
  }

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
      c.header(
        "Content-Range",
        `bytes ${String(start)}-${String(end)}/${String(fileSize)}`,
      )
      c.header("Content-Length", String(chunkSize))
      for (const [k, v] of Object.entries(baseHeaders)) {
        c.header(k, v)
      }
      c.status(206)
      const rs = createFileReadStream(sp, {
        start,
        end,
        highWaterMark: 64 * 1024,
      })
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

// ── Citation resolution ────────────────────────────────────────────────────
//
// GET /v2/kb/files/resolve/:docId[?chunk=N]
//
// The pi-mono agent emits citations as `[<docId>#<chunk_index>]`. The chat UI
// strips those tokens, calls this endpoint per unique docId, and opens the
// resolved file in the slide-over viewer at the cited chunk's page number.
//
// Returns 404 when the docId isn't present in collection_items (e.g. agent
// hallucinated, or the file was deleted post-ingest). Returns 403 if the
// caller can't read the underlying collection — same rule as the rest of
// /v2/kb. We deliberately do NOT leak the vespa fields directly; only the
// minimal trio (clId, itemId, name) plus the resolved page number.
router.get("/files/resolve/:docId", async (c) => {
  const actor = await loadActor(c)
  const docId = c.req.param("docId")
  const chunkRaw = c.req.query("chunk")
  const chunkIndex =
    chunkRaw && /^\d+$/.test(chunkRaw) ? Number(chunkRaw) : null

  const [row] = await db
    .select({
      itemId: collectionItems.id,
      collectionId: collectionItems.collectionId,
      name: collectionItems.name,
    })
    .from(collectionItems)
    .where(eq(collectionItems.vespaDocId, docId))
    .limit(1)
  if (!row) {
    throw new HTTPException(404, { message: "Unknown docId" })
  }

  // ACL — viewer needs at least read access on the parent collection.
  await loadCollection(row.collectionId, actor)

  // Best-effort resolution. From the chunk's entry in chunks_map we lift
  // both the page number(s) and the PDF-coordinate bounding box. The
  // frontend uses the bbox to draw a precise rectangular overlay on the
  // cited page — far more reliable than text-substring matching, which
  // breaks on tables, footnotes, and hyphenation. We still ship a short
  // text snippet as a fallback (for chunks with missing bbox).
  let pageNumber: number | null = null
  let chunkText: string | null = null
  let bbox: {
    l: number
    t: number
    r: number
    b: number
  } | null = null
  let pages: number[] = []
  if (chunkIndex !== null) {
    try {
      const span = getTracer("backendv2-kb").startSpan("resolveCitation")
      const resp = await GetDocumentsByDocIds([docId], span)
      const doc = resp?.root?.children?.[0]
      const fields = (doc?.fields ?? {}) as Record<string, unknown>
      const chunksMap = fields["chunks_map"]
      if (Array.isArray(chunksMap)) {
        const entry = (
          chunksMap as Array<{
            chunk_index: number
            page_numbers?: number[]
            bbox_l?: number
            bbox_t?: number
            bbox_r?: number
            bbox_b?: number
          }>
        ).find((m) => m.chunk_index === chunkIndex)
        if (entry?.page_numbers && entry.page_numbers.length > 0) {
          pages = entry.page_numbers
          pageNumber = entry.page_numbers[0] ?? null
        }
        if (
          entry &&
          typeof entry.bbox_l === "number" &&
          typeof entry.bbox_t === "number" &&
          typeof entry.bbox_r === "number" &&
          typeof entry.bbox_b === "number"
        ) {
          bbox = {
            l: entry.bbox_l,
            t: entry.bbox_t,
            r: entry.bbox_r,
            b: entry.bbox_b,
          }
        }
      }
      const chunksRaw = fields["chunks"] ?? fields["chunks_summary"]
      if (Array.isArray(chunksRaw)) {
        const raw = (chunksRaw as unknown[])[chunkIndex]
        const text =
          typeof raw === "string"
            ? raw
            : raw && typeof raw === "object"
              ? ((raw as { chunk?: string; text?: string }).chunk ??
                (raw as { chunk?: string; text?: string }).text ??
                "")
              : ""
        // Build a snippet that the PDF text layer will actually contain.
        // Docling sometimes emits HTML (`<th>…</th>`, `<table>`) or
        // markdown (`**bold**`, `# header`) inside chunks; pdf.js's text
        // layer only carries plain glyphs, so we strip all formatting,
        // collapse whitespace, drop the leading "[Page N]" marker, and
        // pick the first 6 prose words. Six is a sweet spot: long enough
        // to be unique, short enough that minor line-break differences
        // don't kill the substring match.
        const cleaned = String(text)
          .replace(/^\[Page \d+(-\d+)?\]\s*/, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&[a-z]+;|&#\d+;/gi, " ")
          .replace(/[*_`~#>|]+/g, " ")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/\s+/g, " ")
          .trim()
        if (cleaned.length > 0) {
          // We want the WHOLE cited passage highlighted, not just a
          // prefix. pdf.js's findController matches the query as a
          // single phrase, normalising whitespace/line-breaks in the
          // PDF text layer — so a long contiguous span of prose works
          // fine. We cap at ~30 words to keep the find input readable
          // and to leave headroom against minor docling-vs-PDF
          // formatting drift over long stretches. Drop a leading
          // single-char token (table-cell residue like "I"/"a") so the
          // snippet starts on real text.
          const tokens = cleaned.split(" ")
          while (tokens.length > 0 && tokens[0]!.length <= 1) tokens.shift()
          const snippet = tokens.slice(0, 30).join(" ")
          chunkText = snippet.length > 3 ? snippet : null
        }
      }
    } catch (err) {
      Logger.warn(
        { err, docId, chunkIndex },
        "resolve: vespa chunk lookup failed",
      )
    }
  }

  return c.json({
    docId,
    itemId: row.itemId,
    collectionId: row.collectionId,
    name: row.name,
    chunkIndex,
    pageNumber,
    pages,
    bbox,
    chunkText,
  })
})

// ── Vespa document inspector ──────────────────────────────────────────────
//
// GET /v2/kb/files/inspect/:docId
//
// Returns the raw Vespa document fields the agent's search tools see for
// this docId — chunks, chunk metadata (page numbers, bbox), title,
// indexed timestamps, etc. Used by the "View Vespa document" affordance
// in the PDF viewer toolbar so an operator can inspect exactly what the
// search index has, vs the rendered PDF.
//
// Access: viewer needs read on the parent collection (same gate as the
// resolve endpoint above).
router.get("/files/inspect/:docId", async (c) => {
  const actor = await loadActor(c)
  const docId = c.req.param("docId")

  const [row] = await db
    .select({
      itemId: collectionItems.id,
      collectionId: collectionItems.collectionId,
      name: collectionItems.name,
    })
    .from(collectionItems)
    .where(eq(collectionItems.vespaDocId, docId))
    .limit(1)
  if (!row) {
    throw new HTTPException(404, { message: "Unknown docId" })
  }
  await loadCollection(row.collectionId, actor)

  const span = getTracer("backendv2-kb").startSpan("vespaInspect")
  let fields: Record<string, unknown> = {}
  try {
    const resp = await GetDocumentsByDocIds([docId], span)
    const doc = resp?.root?.children?.[0]
    fields = (doc?.fields ?? {}) as Record<string, unknown>
  } finally {
    span.end()
  }

  return c.json({
    docId,
    itemId: row.itemId,
    collectionId: row.collectionId,
    name: row.name,
    fields,
  })
})

// ── Global file-name search ───────────────────────────────────────────────
//
// GET /v2/kb/search?q=<query>&limit=<n>
//
// Spotlight-style "go to file" search. Returns file rows whose name matches
// `q` (case-insensitive, contains) across every collection the caller can
// read. Same access rule as `loadCollection` — owner, public, or explicitly
// permitted. Folders and collections are intentionally excluded; the v1 UI's
// global palette is "files first" and other entity types can be added by
// flipping the `type=` filter when the product is ready.
//
// Ranking is intentionally simple — prefix matches float to the top, then
// recency tie-breaks. We don't reach for Vespa here: filename ILIKE is
// O(rows-in-accessible-collections), which is tiny compared to a workspace's
// chunk volume, and it stays correct for freshly-uploaded files that haven't
// finished indexing yet.
router.get("/search", async (c) => {
  const actor = await loadActor(c)
  const q = (c.req.query("q") ?? "").trim()
  const limitRaw = Number(c.req.query("limit") ?? "20")
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(50, Math.floor(limitRaw)))
    : 20

  if (q.length === 0) {
    return c.json({ results: [] })
  }

  const accessible = await getAccessibleCollections(db, actor.id)
  if (accessible.length === 0) {
    return c.json({ results: [] })
  }
  const idToName = new Map(accessible.map((cl) => [cl.id, cl.name]))
  const collectionIds = accessible.map((cl) => cl.id)

  // LOWER() + LIKE so the underlying index can be reused even when callers
  // pass mixed case. Parameterisation prevents SQL injection but does NOT
  // neutralise `%` / `_` / `\` as LIKE metacharacters — those are escaped
  // explicitly below (and ESCAPE '\' is set on each LIKE clause). Without
  // this, `q = "%"` would match everything.
  const escapedQ = q.toLowerCase().replace(/[\\%_]/g, "\\$&")
  const needle = `%${escapedQ}%`
  const prefix = `${escapedQ}%`

  const rows = await db
    .select({
      id: collectionItems.id,
      collectionId: collectionItems.collectionId,
      parentId: collectionItems.parentId,
      name: collectionItems.name,
      path: collectionItems.path,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
      uploadStatus: collectionItems.uploadStatus,
      updatedAt: collectionItems.updatedAt,
      vespaDocId: collectionItems.vespaDocId,
    })
    .from(collectionItems)
    .where(
      and(
        inArray(collectionItems.collectionId, collectionIds),
        eq(collectionItems.type, "file"),
        isNull(collectionItems.deletedAt),
        sql`LOWER(${collectionItems.name}) LIKE ${needle} ESCAPE '\\'`,
      ),
    )
    .orderBy(
      sql`CASE WHEN LOWER(${collectionItems.name}) LIKE ${prefix} ESCAPE '\\' THEN 0 ELSE 1 END`,
      desc(collectionItems.updatedAt),
    )
    .limit(limit)

  return c.json({
    results: rows.map((r) => ({
      id: r.id,
      collectionId: r.collectionId,
      collectionName: idToName.get(r.collectionId) ?? "",
      parentId: r.parentId,
      name: r.name,
      path: r.path,
      mimeType: r.mimeType,
      fileSize: r.fileSize,
      uploadStatus: r.uploadStatus,
      updatedAt: r.updatedAt,
      vespaDocId: r.vespaDocId,
    })),
  })
})

// Suppress unused-import warning for UploadStatus (kept for future status polling).
void UploadStatus

export default router
