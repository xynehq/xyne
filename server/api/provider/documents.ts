import { type Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { db } from "@/db/client"
import { workspaces, users, collectionItems } from "@/db/schema"
import { eq, and, isNull, sql } from "drizzle-orm"
import { getLogger } from "@/logger"
import { Subsystem, ProcessingJobType } from "@/types"
import type { TxnOrClient } from "@/types"
import {
  detectMimeType,
  getStoragePath,
  sanitizeFileName,
} from "@/api/knowledgeBase"
import {
  getCollectionById,
  createFileItem,
  getCollectionItemByPath,
  softDeleteCollectionItem,
  generateStorageKey,
  generateFileVespaDocId,
} from "@/db/knowledgeBase"
import { DeleteDocument } from "@/search/vespa"
import { KbItemsSchema } from "@xyne/vespa-ts/types"
import {
  boss,
  FileProcessingQueue,
  PdfFileProcessingQueue,
} from "@/queue/api-server-queue"
import { mkdir, writeFile, unlink } from "fs/promises"
import { dirname } from "path"
import * as crypto from "crypto"
import { resolveCollectionId } from "@/api/provider/collections"

const Logger = getLogger(Subsystem.Server)

function resolveWorkspaceId(c: Context): string {
  // ApiKeyMiddleware sets "workspaceId", dashboard JWT sets "jwtPayload"
  const fromApiKey = c.get("workspaceId") as string | undefined
  if (fromApiKey) return fromApiKey
  const payload = c.get("jwtPayload") as { workspaceId?: string } | undefined
  if (payload?.workspaceId) return payload.workspaceId
  throw new HTTPException(401, { message: "Could not resolve workspace" })
}

function resolveUserEmail(c: Context): string {
  const fromApiKey = c.get("userEmail") as string | undefined
  if (fromApiKey) return fromApiKey
  const payload = c.get("jwtPayload") as { sub?: string } | undefined
  if (payload?.sub) return payload.sub
  throw new HTTPException(401, { message: "Could not resolve user" })
}

async function resolveUserId(email: string): Promise<number> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)
  if (!user) throw new HTTPException(404, { message: "User not found" })
  return user.id
}

function calculateChecksum(buffer: Buffer): string {
  const hash = crypto.createHash("sha256")
  hash.update(new Uint8Array(buffer))
  return hash.digest("hex")
}

/**
 * Remove an existing collection item — soft-delete DB record, delete Vespa doc, delete file from disk.
 */
async function removeExistingItem(
  tx: TxnOrClient,
  existing: { id: string; vespaDocId: string | null; storagePath: string | null },
): Promise<void> {
  if (existing.vespaDocId) {
    try {
      await DeleteDocument(existing.vespaDocId, KbItemsSchema)
    } catch (err) {
      Logger.warn(`Failed to delete old Vespa doc ${existing.vespaDocId}: ${err}`)
    }
  }
  if (existing.storagePath) {
    try {
      await unlink(existing.storagePath)
    } catch {
      // File may already be gone
    }
  }
  await softDeleteCollectionItem(tx, existing.id)
}

/**
 * Upsert a single text document into a collection.
 * If a file with the same name exists at root, removes it first.
 * If doc_id is provided, uses it as vespaDocId for deterministic Vespa upsert.
 */
async function upsertTextDocument(
  collectionId: string,
  workspaceExternalId: string,
  userId: number,
  userEmail: string,
  doc: {
    doc_id?: string
    title: string
    content: string
    visibility?: string
    access_tags: string[]
    source_url?: string
    metadata?: Record<string, unknown>
  },
): Promise<{ itemId: string; title: string; status: string }> {
  const fileName = sanitizeFileName(doc.title.endsWith(".txt") ? doc.title : `${doc.title}.txt`)
  const buffer = Buffer.from(doc.content, "utf-8")
  const checksum = calculateChecksum(buffer)
  const storageKey = generateStorageKey()
  const vespaDocId = doc.doc_id ?? generateFileVespaDocId()

  const storagePath = getStoragePath(
    workspaceExternalId,
    collectionId,
    storageKey,
    fileName,
  )

  await mkdir(dirname(storagePath), { recursive: true })
  await writeFile(storagePath, new Uint8Array(buffer))

  const item = await db.transaction(async (tx: TxnOrClient) => {
    const existing = await getCollectionItemByPath(tx, collectionId, "/", fileName)
    if (existing) {
      await removeExistingItem(tx, existing)
    }
    return await createFileItem(
      tx,
      collectionId,
      null,
      fileName,
      vespaDocId,
      fileName,
      storagePath,
      storageKey,
      "text/plain",
      buffer.length,
      checksum,
      {
        source: "provider",
        visibility: doc.visibility ?? "public",
        access_tags: doc.access_tags ?? [],
        source_url: doc.source_url,
        ...(doc.metadata ?? {}),
      },
      userId,
      userEmail,
      "Queued for processing",
    )
  })

  await boss.send(
    FileProcessingQueue,
    { fileId: item.id, type: ProcessingJobType.FILE },
    { retryLimit: 3, expireInHours: 12 },
  )

  return { itemId: item.id, title: fileName, status: "pending" }
}

/**
 * POST /api/provider/manage/documents
 * POST /api/provider/dashboard/documents
 *
 * Ingests text documents into a collection using the async DB+queue pattern.
 * Supports upsert: if a file with the same name exists, it is replaced.
 * If doc_id is provided, it is used as the vespaDocId for deterministic Vespa upsert.
 */
export const ProviderIngestApi = async (c: Context) => {
  const { collection_id, documents } = c.req.valid("json" as never)
  const workspaceExternalId = resolveWorkspaceId(c)
  const userEmail = resolveUserEmail(c)
  const userId = await resolveUserId(userEmail)

  const collection = await getCollectionById(db, collection_id as string)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  if (collection.ownerId !== userId) {
    throw new HTTPException(403, { message: "Not the collection owner" })
  }

  try {
    const results = []
    for (const doc of documents as Array<{
      doc_id?: string; title: string; content: string
      visibility?: string; access_tags: string[]
      source_url?: string; metadata?: Record<string, unknown>
    }>) {
      results.push(await upsertTextDocument(collection_id as string, workspaceExternalId, userId, userEmail, doc))
    }

    return c.json({ collection_id, documents: results, total: results.length })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Provider document ingestion failed")
    throw new HTTPException(500, { message: "Document ingestion failed" })
  }
}

/**
 * POST /api/provider/manage/documents/upload
 * POST /api/provider/dashboard/documents/upload
 *
 * Uploads files into a collection using the async DB+queue pattern.
 */
export const ProviderFileUploadApi = async (c: Context) => {
  const workspaceExternalId = resolveWorkspaceId(c)
  const userEmail = resolveUserEmail(c)
  const userId = await resolveUserId(userEmail)
  const formData = await c.req.formData()

  const files = formData.getAll("files") as File[]
  const collectionId = formData.get("collection_id") as string
  const useOCRRaw = formData.get("useOCR") as string | null
  const useOCR = useOCRRaw !== "false"

  if (!collectionId || files.length === 0) {
    throw new HTTPException(400, {
      message: "collection_id and at least one file required",
    })
  }

  // Validate collection exists and belongs to this user
  const collection = await getCollectionById(db, collectionId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  if (collection.ownerId !== userId) {
    throw new HTTPException(403, { message: "Not the collection owner" })
  }

  try {
    const results: Array<{
      itemId: string
      fileName: string
      status: string
    }> = []

    for (const file of files) {
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const checksum = calculateChecksum(buffer)
      const mimeType = await detectMimeType(file.name, buffer, file.type)
      const fileName = sanitizeFileName(file.name)
      const storageKey = generateStorageKey()
      const vespaDocId = generateFileVespaDocId()

      const storagePath = getStoragePath(
        workspaceExternalId,
        collectionId,
        storageKey,
        fileName,
      )

      // Write to disk
      await mkdir(dirname(storagePath), { recursive: true })
      await writeFile(storagePath, new Uint8Array(buffer))

      // Create DB record (upsert: remove existing if present)
      const item = await db.transaction(async (tx: TxnOrClient) => {
        const existing = await getCollectionItemByPath(tx, collectionId, "/", fileName)
        if (existing) {
          await removeExistingItem(tx, existing)
        }
        return await createFileItem(
          tx,
          collectionId,
          null, // parentId — root level
          fileName,
          vespaDocId,
          file.name,
          storagePath,
          storageKey,
          mimeType,
          file.size,
          checksum,
          {
            source: "provider",
            originalFileName: file.name,
          },
          userId,
          userEmail,
          "Queued for processing",
        )
      })

      // Route PDF files to PDF queue, others to general queue
      const queueName =
        mimeType === "application/pdf"
          ? PdfFileProcessingQueue
          : FileProcessingQueue

      await boss.send(
        queueName,
        {
          fileId: item.id,
          type: ProcessingJobType.FILE,
          useOCR,
        },
        { retryLimit: 3, expireInHours: 12 },
      )

      results.push({
        itemId: item.id,
        fileName,
        status: "pending",
      })
    }

    return c.json({
      collection_id: collectionId,
      documents: results,
      total: results.length,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Provider file upload ingestion failed")
    throw new HTTPException(500, { message: "File ingestion failed" })
  }
}

/**
 * POST /api/provider/manage/collections/:collectionId/sync
 *
 * Full sync for a collection from an external source (e.g. docs site sync script).
 * 1. Upserts all provided documents (using doc_id as deterministic vespaDocId)
 * 2. Deletes any existing items with the same `source` in metadata that were NOT in this batch
 *
 * Documents uploaded via the dashboard (different source) are never touched.
 */
export const ProviderSyncApi = async (c: Context) => {
  const { collection: collectionName, source, documents } = c.req.valid("json" as never) as {
    collection: string
    source: string
    documents: Array<{
      doc_id: string
      title: string
      content: string
      visibility?: string
      access_tags: string[]
      source_url?: string
      metadata?: Record<string, unknown>
    }>
  }
  const workspaceExternalId = resolveWorkspaceId(c)
  const userEmail = resolveUserEmail(c)
  const userId = await resolveUserId(userEmail)

  // Resolve collection name → UUID
  const collectionId = await resolveCollectionId(workspaceExternalId, collectionName)
  if (!collectionId) {
    throw new HTTPException(404, { message: `Collection "${collectionName}" not found` })
  }

  const collection = await getCollectionById(db, collectionId)
  if (!collection) {
    throw new HTTPException(404, { message: "Collection not found" })
  }
  if (collection.ownerId !== userId) {
    throw new HTTPException(403, { message: "Not the collection owner" })
  }

  try {
    // 1. Upsert all documents
    const upsertedDocIds = new Set<string>()
    const results = []

    for (const doc of documents) {
      const merged = {
        ...doc,
        metadata: { ...doc.metadata, source },
      }
      const result = await upsertTextDocument(collectionId, workspaceExternalId, userId, userEmail, merged)
      upsertedDocIds.add(doc.doc_id)
      results.push(result)
    }

    // 2. Delete stale items — same source but not in this batch
    const allSourceItems = await db
      .select({
        id: collectionItems.id,
        vespaDocId: collectionItems.vespaDocId,
        storagePath: collectionItems.storagePath,
        name: collectionItems.name,
      })
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionId, collectionId),
          eq(collectionItems.type, "file"),
          isNull(collectionItems.deletedAt),
          sql`${collectionItems.metadata}->>'source' = ${source}`,
        ),
      )

    const stale = allSourceItems.filter(
      (item) => item.vespaDocId && !upsertedDocIds.has(item.vespaDocId),
    )

    let deletedCount = 0
    for (const item of stale) {
      try {
        await db.transaction(async (tx: TxnOrClient) => {
          await removeExistingItem(tx, item)
        })
        deletedCount++
        Logger.info(`Sync cleanup: removed stale "${item.name}" (${item.vespaDocId})`)
      } catch (err) {
        Logger.error(`Sync cleanup: failed to remove "${item.name}": ${err}`)
      }
    }

    return c.json({
      collection_id: collectionId,
      upserted: results.length,
      deleted: deletedCount,
      total: results.length,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error
    Logger.error(error, "Provider sync failed")
    throw new HTTPException(500, { message: "Sync failed" })
  }
}
