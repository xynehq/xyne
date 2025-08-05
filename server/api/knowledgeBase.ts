import { createId } from "@paralleldrive/cuid2"
import { mkdir, unlink, writeFile, readFile } from "node:fs/promises"
import { join, dirname, extname } from "node:path"
import { type SelectUser } from "@/db/schema"
import { z } from "zod"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import {
  createKnowledgeBase,
  getKnowledgeBaseById,
  getKnowledgeBasesByOwner,
  getAccessibleKnowledgeBases,
  updateKnowledgeBase,
  softDeleteKnowledgeBase,
  createFolder,
  createFileItem,
  getKbItemById,
  getKbItemsByParent,
  getKbItemByPath,
  updateKbItem,
  softDeleteKbItem,
  getKbFileByItemId,
  generateStorageKey,
  generateVespaDocId,
  generateFolderVespaDocId,
  getAllFolderItems,
  getKbFilesVespaIds,
} from "@/db/knowledgeBase"
import type { KnowledgeBase, KbItem, KbFile } from "@/db/schema"
import { kbItems, kbFiles } from "@/db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { insert, DeleteDocument } from "@/search/vespa"
import { Apps, kbFileSchema, KnowledgeBaseEntity } from "@/search/types"
import crypto from "crypto"
import { chunkDocument } from "@/chunks"
import { extractTextAndImagesWithChunksFromPDF } from "@/pdfChunks"
import { extractTextAndImagesWithChunksFromDocx } from "@/docxChunks"
import { extractTextAndImagesWithChunksFromPptx } from "@/pptChunks"
import * as XLSX from "xlsx"
import {
  DATASOURCE_CONFIG,
  getBaseMimeType,
  isTextFile,
  isSheetFile,
  isDocxFile,
  isPptxFile,
} from "@/integrations/dataSource/config"

const loggerWithChild = getLoggerWithChild(Subsystem.Api, {
  module: "knowledgeBaseService",
})

const { JwtPayloadKey } = config

// Storage configuration
const KB_STORAGE_ROOT = join(process.cwd(), "storage", "kb_files")
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB max file size
const MAX_FILES_PER_REQUEST = 100 // Maximum files per upload request

// Initialize storage directory
;(async () => {
  try {
    await mkdir(KB_STORAGE_ROOT, { recursive: true })
    loggerWithChild().info(
      `Knowledge Base storage directory ensured: ${KB_STORAGE_ROOT}`,
    )
  } catch (error) {
    loggerWithChild().error(
      error,
      `Failed to create Knowledge Base storage directory: ${KB_STORAGE_ROOT}`,
    )
  }
})()

// Schema definitions
const createKnowledgeBaseSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  isPrivate: z.boolean().optional().default(true),
  metadata: z.record(z.any()).optional(),
})

const updateKnowledgeBaseSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  isPrivate: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
})

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any()).optional(),
})

// Helper functions
function calculateChecksum(buffer: ArrayBuffer): string {
  const hash = crypto.createHash("sha256")
  hash.update(new Uint8Array(buffer))
  return hash.digest("hex")
}

function getStoragePath(
  workspaceId: string,
  kbId: string,
  storageKey: string,
  fileName: string,
): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  return join(
    KB_STORAGE_ROOT,
    workspaceId,
    kbId,
    year.toString(),
    month,
    `${storageKey}_${fileName}`,
  )
}

// API Handlers

// Create a new Knowledge Base
export const CreateKnowledgeBaseApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)

  // Get user from database like other APIs do
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    loggerWithChild({ email: userEmail }).error(
      "No user found for email in CreateKnowledgeBaseApi",
    )
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const rawData = await c.req.json()
    loggerWithChild({ email: userEmail }).info(
      `Creating KB with raw data: ${JSON.stringify(rawData)}`,
    )

    const validatedData = createKnowledgeBaseSchema.parse(rawData)
    const vespaDocId = generateFolderVespaDocId()
    loggerWithChild({ email: userEmail }).info(
      `User object: ${JSON.stringify({ id: user.id, email: user.email, role: user.role })}`,
    )

    const kbData = {
      name: validatedData.name,
      description: validatedData.description || null,
      workspaceId: user.workspaceId,
      ownerId: user.id,
      isPrivate: validatedData.isPrivate ?? true,
      lastUpdatedById: user.id,
      lastUpdatedByEmail: user.email,
      metadata:{
        ...validatedData.metadata || {},
        vespaDocId: vespaDocId, // Store the vespaDocId in metadata
      },
    }

    loggerWithChild({ email: userEmail }).info(
      `Creating KB with data: ${JSON.stringify(kbData)}`,
    )

    const kb = await createKnowledgeBase(db, kbData)

    const vespaDoc = {
      docId: vespaDocId,
      kbId: kb.id,
      itemId: kb.id,
      fileName: validatedData.name,
      app: Apps.KnowledgeBase,
      entity: KnowledgeBaseEntity.Collection, // You may need to add this to your enum
      storagePath: "",
      chunks: [],
      chunks_pos: [],
      image_chunks: [],
      image_chunks_pos: [],
      description: validatedData.description || "",
      metadata: JSON.stringify({
        type: "knowledge_base",
        isPrivate: validatedData.isPrivate ?? true,
        createdBy: user.email,
        ownerId: user.id,
        workspaceId: user.workspaceId,
      }),
      createdBy: user.email,
      mimeType: "knowledge_base",
      fileSize: 0,
      duration: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await insert(vespaDoc, kbFileSchema)
    loggerWithChild({ email: userEmail }).info(
      `Created Knowledge Base: ${kb.id} for user ${userEmail}`,
    )

    return c.json(kb)
  } catch (error) {
    if (error instanceof z.ZodError) {
      loggerWithChild({ email: userEmail }).error(
        `Validation error: ${JSON.stringify(error.errors)}`,
      )
      throw new HTTPException(400, {
        message: `Invalid request data: ${error.errors.map((e) => e.message).join(", ")}`,
      })
    }
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to create Knowledge Base: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: `Failed to create Knowledge Base: ${errMsg}`,
    })
  }
}

// List Knowledge Bases for a user
export const ListKnowledgeBasesApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const showOnlyOwn = c.req.query("ownOnly") === "true"

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kbs = showOnlyOwn
      ? await getKnowledgeBasesByOwner(db, user.id)
      : await getAccessibleKnowledgeBases(db, user.id)
    return c.json(kbs)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to list Knowledge Bases: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to list Knowledge Bases",
    })
  }
}

// Get a specific Knowledge Base
export const GetKnowledgeBaseApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check access: owner can always access, others only if KB is public
    if (kb.ownerId !== user.id && kb.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    return c.json(kb)
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to get Knowledge Base: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to get Knowledge Base",
    })
  }
}

// Update a Knowledge Base
export const UpdateKnowledgeBaseApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check ownership
    if (kb.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const rawData = await c.req.json()
    const validatedData = updateKnowledgeBaseSchema.parse(rawData)

    const updatedKb = await updateKnowledgeBase(db, kbId, {
      ...validatedData,
      lastUpdatedById: user.id,
      lastUpdatedByEmail: user.email,
    })

    loggerWithChild({ email: userEmail }).info(
      `Updated Knowledge Base: ${kbId}`,
    )

    return c.json(updatedKb)
  } catch (error) {
    if (error instanceof HTTPException) throw error
    if (error instanceof z.ZodError) {
      throw new HTTPException(400, {
        message: `Invalid request data: ${error.errors.map((e) => e.message).join(", ")}`,
      })
    }

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to update Knowledge Base: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to update Knowledge Base",
    })
  }
}

// Delete a Knowledge Base
export const DeleteKnowledgeBaseApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check ownership
    if (kb.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    // Get all items in the knowledge base before deletion
    const allItems = await db
      .select()
      .from(kbItems)
      .where(and(isNull(kbItems.deletedAt)))

    // Filter items that belong to this KB by checking hierarchy
    const kbItemsToDelete: KbItem[] = []
    for (const item of allItems) {
      if (item.id === kbId) {
        kbItemsToDelete.push(item)
        continue
      }

      // Check if item belongs to this KB by traversing up the hierarchy
      let currentItem = item
      let belongsToKb = false
      while (currentItem.parentId) {
        if (currentItem.parentId === kbId) {
          belongsToKb = true
          break
        }
        const parent = allItems.find((i) => i.id === currentItem.parentId)
        if (!parent) break
        currentItem = parent
      }

      if (belongsToKb) {
        kbItemsToDelete.push(item)
      }
    }

    // Delete all files from Vespa and storage
    let deletedFilesCount = 0
    const fileItemIds: string[] = []

    for (const item of kbItemsToDelete) {
      if (item.type === "file") {
        const kbFile = await getKbFileByItemId(db, item.id)
        if (kbFile) {
          fileItemIds.push(item.id)

          try {
            // Delete from Vespa
            await DeleteDocument(kbFile.vespaDocId, kbFileSchema)
            loggerWithChild({ email: userEmail }).info(
              `Deleted from Vespa: ${kbFile.vespaDocId}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete from Vespa: ${kbFile.vespaDocId} - ${getErrorMessage(error)}`,
            )
          }

          try {
            // Delete from storage
            await unlink(kbFile.storagePath)
            loggerWithChild({ email: userEmail }).info(
              `Deleted from storage: ${kbFile.storagePath}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete file from storage: ${kbFile.storagePath} - ${getErrorMessage(error)}`,
            )
          }

          deletedFilesCount++
        }
      }
      else if (item.type === "folder") {
        // Delete folder from Vespa
        const folderMetadata = item.metadata as Record<string, any>
        const vespaDocId = folderMetadata?.vespaDocId

        if (vespaDocId) {
          try {
            await DeleteDocument(vespaDocId, kbFileSchema)
            loggerWithChild({ email: userEmail }).info(
              `Deleted folder from Vespa: ${vespaDocId}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete folder from Vespa: ${vespaDocId} - ${getErrorMessage(error)}`,
            )
          }
        }
      }
      else if (item.type === "knowledge_base") {
        // Delete Knowledge Base from Vespa
        const kbMetadata = item.metadata as Record<string, any>
        const vespaDocId = kbMetadata?.vespaDocId

        if (vespaDocId) {
          try {
            await DeleteDocument(vespaDocId, kbFileSchema)
            loggerWithChild({ email: userEmail }).info(
              `Deleted Knowledge Base from Vespa: ${vespaDocId}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete Knowledge Base from Vespa: ${vespaDocId} - ${getErrorMessage(error)}`,
            )
          }
        }
      }
    }

    // Use transaction to ensure both tables are updated atomically
    await db.transaction(async (tx) => {
      // Soft delete all items in the KB (including the KB itself)
      if (kbItemsToDelete.length > 0) {
        const itemIds = kbItemsToDelete.map((item) => item.id)
        await tx
          .update(kbItems)
          .set({
            deletedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(
            sql`${kbItems.id} IN (${sql.join(
              itemIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
      }

      // Also soft delete all file records in kb_files table
      if (fileItemIds.length > 0) {
        await tx
          .update(kbFiles)
          .set({
            deletedAt: sql`NOW()`,
          })
          .where(
            sql`${kbFiles.itemId} IN (${sql.join(
              fileItemIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
      }
    })

    loggerWithChild({ email: userEmail }).info(
      `Deleted Knowledge Base: ${kbId} (${kbItemsToDelete.length} total items deleted, ${deletedFilesCount} files removed from Vespa and storage)`,
    )

    return c.json({
      success: true,
      deletedCount: kbItemsToDelete.length,
      deletedFiles: deletedFilesCount,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to delete Knowledge Base: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to delete Knowledge Base",
    })
  }
}

// List items in a Knowledge Base
export const ListKbItemsApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")
  const parentId = c.req.query("parentId") || null

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check access: owner can always access, others only if KB is public
    if (kb.ownerId !== user.id && kb.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const items = await getKbItemsByParent(db, kbId, parentId)
    return c.json(items)
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to list KB items: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to list Knowledge Base items",
    })
  }
}

// Create a folder
export const CreateFolderApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check ownership
    if (kb.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const rawData = await c.req.json()
    const validatedData = createFolderSchema.parse(rawData)

    // Create Vespa document for the folder
    const vespaDocId = generateFolderVespaDocId()

    // Store vespaDocId in folder metadata
    const folderMetadata = {
      ...(validatedData.metadata || {}),
      vespaDocId: vespaDocId,
    }

    const folder = await createFolder(
      db,
      kbId,
      validatedData.parentId || null,
      validatedData.name,
      folderMetadata,
      user.id,
      user.email,
    )

    const vespaDoc = {
      docId: vespaDocId,
      kbId: kbId,
      itemId: folder.id,
      app: Apps.KnowledgeBase,
      fileName: validatedData.name,
      entity: KnowledgeBaseEntity.Folder,
      storagePath: "",
      chunks: [],
      chunks_pos: [],
      image_chunks: [],
      image_chunks_pos: [],
      description: "",
      metadata: JSON.stringify({
        type: "folder",
        createdBy: user.email,
        parentId: validatedData.parentId || null,
      }),
      createdBy: user.email,
      mimeType: "folder",
      fileSize: 0,
      duration: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await insert(vespaDoc, kbFileSchema)

    loggerWithChild({ email: userEmail }).info(
      `Created folder: ${folder.id} in KB: ${kbId} with Vespa doc: ${vespaDocId}`,
    )

    return c.json(folder)
  } catch (error) {
    if (error instanceof HTTPException) throw error
    if (error instanceof z.ZodError) {
      throw new HTTPException(400, {
        message: `Invalid request data: ${error.errors.map((e) => e.message).join(", ")}`,
      })
    }

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to create folder: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to create folder",
    })
  }
}

// Duplicate handling strategies
enum DuplicateStrategy {
  SKIP = "skip",
  RENAME = "rename",
  OVERWRITE = "overwrite",
}

// Helper function to generate unique name
function generateUniqueName(baseName: string, existingNames: string[]): string {
  const nameLower = baseName.toLowerCase()
  const ext = extname(baseName)
  const nameWithoutExt = baseName.slice(0, -ext.length || undefined)

  // Check if name already exists (case-insensitive)
  const nameExists = existingNames.some((n) => n.toLowerCase() === nameLower)
  if (!nameExists) return baseName

  // Generate unique name with counter
  let counter = 1
  let newName: string
  do {
    newName = `${nameWithoutExt} (${counter})${ext}`
    counter++
  } while (existingNames.some((n) => n.toLowerCase() === newName.toLowerCase()))

  return newName
}

// Session management for batch uploads
const uploadSessions = new Map<
  string,
  {
    folderCache: Map<string, string>
    createdAt: number
    results: any[]
  }
>()

// Clean up old sessions (older than 1 hour)
setInterval(() => {
  const now = Date.now()
  for (const [sessionId, session] of uploadSessions.entries()) {
    if (now - session.createdAt > 3600000) {
      uploadSessions.delete(sessionId)
    }
  }
}, 300000) // Run every 5 minutes

// Helper function to ensure folder exists or create it
async function ensureFolderPath(
  db: any,
  kbId: string,
  pathParts: string[],
  parentId: string | null = null,
  folderCache?: Map<string, string>,
): Promise<string | null> {
  if (pathParts.length === 0) {
    return parentId
  }

  const folderPath = pathParts.join("/")

  // Check cache first
  if (folderCache && folderCache.has(folderPath)) {
    return folderCache.get(folderPath) || null
  }

  const folderName = pathParts[0]

  // Check if folder already exists at this level (case-insensitive)
  const existingItems = await getKbItemsByParent(db, kbId, parentId)
  const existingFolder = existingItems.find(
    (item) =>
      item.type === "folder" &&
      item.name.toLowerCase() === folderName.toLowerCase(),
  )

  let currentFolderId: string

  if (existingFolder) {
    currentFolderId = existingFolder.id
  } else {
    // Create Vespa document for the folder created during file upload
    const vespaDocId = generateFolderVespaDocId()

    // Create the folder with vespaDocId in metadata
    const newFolder = await createFolder(db, kbId, parentId, folderName, {
      vespaDocId: vespaDocId,
    })
    currentFolderId = newFolder.id

    const vespaDoc = {
      docId: vespaDocId,
      kbId: kbId,
      itemId: newFolder.id,
      fileName: folderName, // Use folder name as fileName
      app:Apps.KnowledgeBase,
      entity: KnowledgeBaseEntity.Folder, // Mark as folder
      storagePath: "", // Folders don't have storage path
      chunks: [], // Folders don't have chunks
      chunks_pos: [], // Folders don't have chunk positions
      image_chunks: [], // Folders don't have image chunks
      image_chunks_pos: [], // Folders don't have image chunk positions
      description: "", // Could be populated if needed
      metadata: JSON.stringify({
        type: "folder",
        createdBy: "system", // Created during file upload
        parentId: parentId || null,
      }),
      createdBy: "system", // Created during file upload
      mimeType: "folder", // Use "folder" as mime type for folders
      fileSize: 0, // Folders don't have size
      duration: 0, // Folders don't have duration
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await insert(vespaDoc, kbFileSchema)

    loggerWithChild().info(
      `Created folder during upload: ${newFolder.id} in KB: ${kbId} with Vespa doc: ${vespaDocId}`,
    )
  }

  // Cache the result
  if (folderCache) {
    folderCache.set(pathParts.slice(0, 1).join("/"), currentFolderId)
  }

  // Recursively process remaining path parts
  return ensureFolderPath(
    db,
    kbId,
    pathParts.slice(1),
    currentFolderId,
    folderCache,
  )
}

// Upload files
export const UploadFilesApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")
  const requestPath = c.req.path

  // Handle different endpoints
  const isBatchUpload = requestPath.includes("/upload/batch")
  const isComplete = requestPath.includes("/upload/complete")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check ownership
    if (kb.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    // Handle session completion
    if (isComplete) {
      const { sessionId } = await c.req.json()
      const session = uploadSessions.get(sessionId)

      if (!session) {
        return c.json({
          success: true,
          message: "Session not found or already completed",
          summary: { total: 0, successful: 0, skipped: 0, failed: 0 },
        })
      }

      // Calculate summary
      const results = session.results || []
      const summary = {
        total: results.length,
        successful: results.filter((r: any) => r.success).length,
        skipped: results.filter(
          (r: any) => !r.success && r.message.includes("Skipped"),
        ).length,
        failed: results.filter(
          (r: any) => !r.success && !r.message.includes("Skipped"),
        ).length,
        renamed: results.filter((r: any) => r.success && r.wasRenamed).length,
      }

      // Clean up session
      uploadSessions.delete(sessionId)

      return c.json({ success: true, summary })
    }

    const formData = await c.req.formData()
    const parentId = formData.get("parentId") as string | null
    const files = formData.getAll("files") as File[]
    const paths = formData.getAll("paths") as string[] // Get file paths for folder structure
    const duplicateStrategy =
      (formData.get("duplicateStrategy") as DuplicateStrategy) ||
      DuplicateStrategy.RENAME

    // For batch uploads, get session info
    let sessionId = formData.get("sessionId") as string | null
    let folderCache: Map<string, string> | undefined

    if (isBatchUpload && sessionId) {
      let session = uploadSessions.get(sessionId)
      if (!session) {
        session = {
          folderCache: new Map(),
          createdAt: Date.now(),
          results: [],
        }
        uploadSessions.set(sessionId, session)
      }
      folderCache = session.folderCache
    }

    if (!files || files.length === 0) {
      throw new HTTPException(400, { message: "No files provided" })
    }

    // Validate file count
    if (files.length > MAX_FILES_PER_REQUEST) {
      throw new HTTPException(400, {
        message: `Too many files. Maximum ${MAX_FILES_PER_REQUEST} files allowed per request`,
      })
    }

    // Define type for upload results
    interface UploadResult {
      success: boolean
      fileName: string
      parentId: string | null
      message: string
      itemId?: string
      originalFileName?: string
      duplicateId?: string
      isIdentical?: boolean
      wasRenamed?: boolean
    }

    const uploadResults: UploadResult[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const filePath = paths[i] || file.name // Use provided path or default to filename
      let targetParentId = parentId // Declare here so it's accessible in catch block

      // Skip system files
      if (
        file.name === ".DS_Store" ||
        file.name.startsWith("._") ||
        file.name === "Thumbs.db" ||
        file.name === "desktop.ini"
      ) {
        uploadResults.push({
          success: false,
          fileName: file.name,
          parentId: targetParentId,
          message: "Skipped: System file",
        })
        loggerWithChild({ email: userEmail }).info(
          `Skipped system file: ${file.name}`,
        )
        continue
      }

      try {
        // Validate file size
        if (file.size > MAX_FILE_SIZE) {
          uploadResults.push({
            success: false,
            fileName: file.name,
            parentId: targetParentId,
            message: `Skipped: File too large (${Math.round(file.size / 1024 / 1024)}MB). Maximum size is ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`,
          })
          loggerWithChild({ email: userEmail }).info(
            `Skipped large file: ${file.name} (${file.size} bytes)`,
          )
          continue
        }

        // Parse the file path to extract folder structure
        const pathParts = filePath.split("/").filter((part) => part.length > 0)
        const originalFileName = pathParts.pop() || file.name // Get the actual filename

        // Validate file name
        const invalidChars = /[\x00-\x1f\x7f<>:"|?*\\]/
        if (invalidChars.test(originalFileName)) {
          uploadResults.push({
            success: false,
            fileName: originalFileName,
            parentId: targetParentId,
            message: "Skipped: Invalid characters in filename",
          })
          continue
        }

        // Skip if the filename is a system file (in case it comes from path)
        if (
          originalFileName === ".DS_Store" ||
          originalFileName.startsWith("._") ||
          originalFileName === "Thumbs.db" ||
          originalFileName === "desktop.ini"
        ) {
          uploadResults.push({
            success: false,
            fileName: originalFileName,
            parentId: targetParentId,
            message: "Skipped: System file",
          })
          loggerWithChild({ email: userEmail }).info(
            `Skipped system file: ${originalFileName}`,
          )
          continue
        }

        // Create folder structure if needed
        if (pathParts.length > 0) {
          targetParentId = await ensureFolderPath(
            db,
            kbId,
            pathParts,
            parentId,
            folderCache,
          )
        }

        // Read file content and calculate checksum
        const arrayBuffer = await file.arrayBuffer()
        const buffer = Buffer.from(arrayBuffer)
        const checksum = calculateChecksum(arrayBuffer)

        // Check for duplicate by name in the same folder first
        let targetPath = "/"
        if (targetParentId) {
          const parent = await getKbItemById(db, targetParentId)
          if (parent) {
            targetPath = parent.path + parent.name + "/"
          }
        }

        const existingItems = await getKbItemsByParent(db, kbId, targetParentId)
        // Create a mutable copy of existing names that we can update during batch processing
        const currentNames = [...existingItems.map((item) => item.name)]

        // Also check names from files already processed in this batch
        for (let j = 0; j < i; j++) {
          const prevResult = uploadResults[j]
          if (prevResult.success && prevResult.parentId === targetParentId) {
            currentNames.push(prevResult.fileName)
          }
        }

        let fileName = originalFileName
        const existingFile = await getKbItemByPath(
          db,
          kbId,
          targetPath,
          fileName,
        )

        if (existingFile) {
          // File with same name exists - check checksum to decide action
          const existingKbFile = await getKbFileByItemId(db, existingFile.id)

          if (existingKbFile && existingKbFile.checksum === checksum) {
            // Same content - skip the upload
            uploadResults.push({
              success: false,
              fileName: originalFileName,
              message: "Skipped: Identical file already exists",
              duplicateId: existingFile.id,
              isIdentical: true,
              parentId: targetParentId,
            })
            continue
          } else {
            // Different content - handle based on strategy
            if (duplicateStrategy === DuplicateStrategy.SKIP) {
              uploadResults.push({
                success: false,
                fileName: originalFileName,
                message:
                  "Skipped: File with same name exists (different content)",
                duplicateId: existingFile.id,
                parentId: targetParentId,
              })
              continue
            } else if (duplicateStrategy === DuplicateStrategy.RENAME) {
              fileName = generateUniqueName(originalFileName, currentNames)
            } else if (duplicateStrategy === DuplicateStrategy.OVERWRITE) {
              // Delete the existing file to replace it
              await softDeleteKbItem(db, existingFile.id)

              if (existingKbFile) {
                await DeleteDocument(existingKbFile.vespaDocId, kbFileSchema)
                try {
                  await unlink(existingKbFile.storagePath)
                } catch (error) {
                  // Ignore file deletion errors
                }
              }
            }
          }
        }

        // Generate unique identifiers
        const storageKey = generateStorageKey()
        const vespaDocId = generateVespaDocId()

        // Calculate storage path
        const storagePath = getStoragePath(
          user.workspaceExternalId,
          kbId,
          storageKey,
          fileName,
        )

        // Ensure directory exists
        await mkdir(dirname(storagePath), { recursive: true })

        // Write file to disk
        await writeFile(storagePath, new Uint8Array(buffer))

        // Use transaction for atomic file creation
        const { item, file: kbFile } = await db.transaction(async (tx) => {
          return await createFileItem(
            tx,
            kbId,
            targetParentId,
            fileName,
            vespaDocId,
            fileName,
            storagePath,
            storageKey,
            file.type || "application/octet-stream",
            file.size,
            checksum,
            {
              originalPath: filePath,
              folderStructure: pathParts.join("/"),
              originalFileName:
                originalFileName !== fileName ? originalFileName : undefined,
              wasOverwritten:
                existingFile &&
                duplicateStrategy === DuplicateStrategy.OVERWRITE,
            },
            user.id,
            user.email,
          )
        })

        // Process file based on type
        const baseMimeType = getBaseMimeType(file.type || "text/plain")
        let chunks: string[] = []
        let chunks_pos: number[] = []

        try {
          if (baseMimeType === "application/pdf") {
            // Process PDF
            const result = await extractTextAndImagesWithChunksFromPDF(
              new Uint8Array(buffer),
              vespaDocId,
              false,
            )
            chunks = result.text_chunks
            chunks_pos = result.text_chunk_pos
          } else if (isDocxFile(baseMimeType)) {
            // Process DOCX
            const result = await extractTextAndImagesWithChunksFromDocx(
              new Uint8Array(buffer),
              vespaDocId,
              false,
            )
            chunks = result.text_chunks
            chunks_pos = result.text_chunk_pos
          } else if (isPptxFile(baseMimeType)) {
            // Process PPTX
            const result = await extractTextAndImagesWithChunksFromPptx(
              new Uint8Array(buffer),
              vespaDocId,
              false,
            )
            chunks = result.text_chunks
            chunks_pos = result.text_chunk_pos
          } else if (isSheetFile(baseMimeType)) {
            // Process spreadsheet
            const workbook = XLSX.readFile(storagePath)
            const allChunks: string[] = []

            for (const sheetName of workbook.SheetNames) {
              const worksheet = workbook.Sheets[sheetName]
              if (!worksheet) continue

              const sheetData: string[][] = XLSX.utils.sheet_to_json(
                worksheet,
                {
                  header: 1,
                  defval: "",
                  raw: false,
                },
              )

              const validRows = sheetData.filter((row) =>
                row.some((cell) => cell && cell.toString().trim().length > 0),
              )

              for (const row of validRows) {
                const textualCells = row
                  .filter(
                    (cell) =>
                      cell &&
                      isNaN(Number(cell)) &&
                      cell.toString().trim().length > 0,
                  )
                  .map((cell) => cell.toString().trim())

                if (textualCells.length > 0) {
                  allChunks.push(textualCells.join(" "))
                }
              }
            }

            chunks = allChunks
            chunks_pos = allChunks.map((_, idx) => idx)
          } else if (isTextFile(baseMimeType)) {
            // Process text file
            const content = await file.text()
            const processedChunks = chunkDocument(content.trim())
            chunks = processedChunks.map((v) => v.chunk)
            chunks_pos = chunks.map((_, idx) => idx)
          } else {
            // For unsupported types, try to extract text content
            try {
              const content = await file.text()
              if (content.trim()) {
                const processedChunks = chunkDocument(content.trim())
                chunks = processedChunks.map((v) => v.chunk)
                chunks_pos = chunks.map((_, idx) => idx)
              }
            } catch {
              // If text extraction fails, create a basic chunk with file info
              chunks = [
                `File: ${file.name}, Type: ${baseMimeType}, Size: ${file.size} bytes`,
              ]
              chunks_pos = [0]
            }
          }
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to process file content for ${file.name}: ${getErrorMessage(error)}`,
          )
          // Create basic chunk on processing error
          chunks = [
            `File: ${file.name}, Type: ${baseMimeType}, Size: ${file.size} bytes`,
          ]
          chunks_pos = [0]
        }

        // Create Vespa document
        const vespaDoc = {
          docId: vespaDocId,
          kbId: kbId,
          itemId: item.id,
          fileName: targetPath === '/' ? kb.name + targetPath + filePath : kb.name + targetPath + fileName,
          app:Apps.KnowledgeBase,
          entity: KnowledgeBaseEntity.File, // Always "file" for files being uploaded
          storagePath: storagePath,
          chunks: chunks,
          chunks_pos: chunks_pos,
          metadata: JSON.stringify({
            originalFileName: file.name,
            uploadedBy: user.email,
            chunksCount: chunks.length,
            processingMethod: baseMimeType,
          }),
          createdBy: user.email,
          mimeType: baseMimeType,
          fileSize: file.size,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        await insert(vespaDoc, kbFileSchema)

        uploadResults.push({
          success: true,
          itemId: item.id,
          fileName: fileName,
          originalFileName: originalFileName,
          parentId: targetParentId,
          message:
            fileName !== originalFileName
              ? `File uploaded as "${fileName}" (renamed to avoid duplicate)`
              : "File uploaded successfully",
          wasRenamed: fileName !== originalFileName,
        })

        loggerWithChild({ email: userEmail }).info(
          `Uploaded file: ${fileName} to KB: ${kbId}`,
        )
      } catch (error) {
        const errMsg = getErrorMessage(error)
        uploadResults.push({
          success: false,
          fileName: file.name,
          parentId: targetParentId,
          message: `Failed to upload file: ${errMsg}`,
        })

        loggerWithChild({ email: userEmail }).error(
          error,
          `Failed to upload file ${file.name}: ${errMsg}`,
        )
      }
    }

    // Include summary in response
    const summary = {
      total: files.length,
      successful: uploadResults.filter((r) => r.success).length,
      skipped: uploadResults.filter(
        (r) => !r.success && r.message.includes("Skipped"),
      ).length,
      failed: uploadResults.filter(
        (r) => !r.success && !r.message.includes("Skipped"),
      ).length,
      renamed: uploadResults.filter((r) => r.success && r.wasRenamed).length,
    }

    return c.json({ results: uploadResults, summary })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to upload files: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to upload files",
    })
  }
}

// Delete an item
export const DeleteItemApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")
  const itemId = c.req.param("itemId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check ownership
    if (kb.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const item = await getKbItemById(db, itemId)
    if (!item) {
      throw new HTTPException(404, { message: "Item not found" })
    }

    // Verify item belongs to this KB by traversing up the hierarchy
    let currentItem = item
    let belongsToKb = false
    while (currentItem.parentId) {
      if (currentItem.parentId === kbId) {
        belongsToKb = true
        break
      }
      const parent = await getKbItemById(db, currentItem.parentId)
      if (!parent) break
      currentItem = parent
    }

    if (!belongsToKb) {
      throw new HTTPException(404, {
        message: "Item not found in this knowledge base",
      })
    }

    // Collect all items to delete (including descendants if it's a folder)
    const itemsToDelete: { item: KbItem; kbFile?: KbFile }[] = []

    if (item.type === "file") {
      // For files, just add the single file
      const kbFile = await getKbFileByItemId(db, itemId)
      itemsToDelete.push({ item, kbFile: kbFile || undefined })
    } else if (item.type === "folder") {
      // For folders, get all descendants recursively
      const getAllDescendants = async (parentId: string): Promise<KbItem[]> => {
        const children = await db
          .select()
          .from(kbItems)
          .where(and(eq(kbItems.parentId, parentId), isNull(kbItems.deletedAt)))

        const allDescendants: KbItem[] = [...children]

        // Recursively get descendants of each child folder
        for (const child of children) {
          if (child.type === "folder") {
            const childDescendants = await getAllDescendants(child.id)
            allDescendants.push(...childDescendants)
          }
        }

        return allDescendants
      }

      // Get all descendants including the folder itself
      itemsToDelete.push({ item })
      const descendants = await getAllDescendants(itemId)

      for (const descendantItem of descendants) {
        if (descendantItem.type === "file") {
          const kbFile = await getKbFileByItemId(db, descendantItem.id)
          itemsToDelete.push({
            item: descendantItem,
            kbFile: kbFile || undefined,
          })
        } else {
          itemsToDelete.push({ item: descendantItem })
        }
      }
    }

    // Delete all files and folders from Vespa and storage
    const fileItemIds: string[] = []
    let deletedFoldersCount = 0

    for (const { item: itemToDelete, kbFile } of itemsToDelete) {
      if (itemToDelete.type === "file" && kbFile) {
        fileItemIds.push(itemToDelete.id)

        try {
          // Delete from Vespa
          await DeleteDocument(kbFile.vespaDocId, kbFileSchema)
          loggerWithChild({ email: userEmail }).info(
            `Deleted file from Vespa: ${kbFile.vespaDocId}`,
          )
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to delete file from Vespa: ${kbFile.vespaDocId} - ${getErrorMessage(error)}`,
          )
        }

        try {
          // Delete from storage
          await unlink(kbFile.storagePath)
          loggerWithChild({ email: userEmail }).info(
            `Deleted from storage: ${kbFile.storagePath}`,
          )
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to delete file from storage: ${kbFile.storagePath} - ${getErrorMessage(error)}`,
          )
        }
      } else if (itemToDelete.type === "folder") {
        // Delete folder from Vespa
        const folderMetadata = itemToDelete.metadata as Record<string, any>
        const vespaDocId = folderMetadata?.vespaDocId

        if (vespaDocId) {
          try {
            await DeleteDocument(vespaDocId, kbFileSchema)
            deletedFoldersCount++
            loggerWithChild({ email: userEmail }).info(
              `Deleted folder from Vespa: ${vespaDocId}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete folder from Vespa: ${vespaDocId} - ${getErrorMessage(error)}`,
            )
          }
        }
      }
    }

    // Use transaction to soft delete items and update kb_files
    await db.transaction(async (tx) => {
      // Soft delete the item (and all descendants if it's a folder)
      await softDeleteKbItem(tx, itemId)

      // Also soft delete all file records in kb_files table
      if (fileItemIds.length > 0) {
        await tx
          .update(kbFiles)
          .set({
            deletedAt: sql`NOW()`,
          })
          .where(
            sql`${kbFiles.itemId} IN (${sql.join(
              fileItemIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
      }
    })

    loggerWithChild({ email: userEmail }).info(
      `Deleted item: ${itemId} from KB: ${kbId} (${itemsToDelete.length} total items deleted)`,
    )

    return c.json({
      success: true,
      deletedCount: itemsToDelete.length,
      deletedFiles: itemsToDelete.filter((i) => i.item.type === "file").length,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to delete item: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to delete item",
    })
  }
}

// Get file preview URL
export const GetFilePreviewApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")
  const itemId = c.req.param("itemId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check access: owner can always access, others only if KB is public
    if (kb.ownerId !== user.id && kb.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const item = await getKbItemById(db, itemId)
    if (!item || item.type !== "file") {
      throw new HTTPException(404, { message: "File not found" })
    }

    // Verify item belongs to this KB by traversing up the hierarchy
    let currentItem = item
    let belongsToKb = false
    while (currentItem.parentId) {
      if (currentItem.parentId === kbId) {
        belongsToKb = true
        break
      }
      const parent = await getKbItemById(db, currentItem.parentId)
      if (!parent) break
      currentItem = parent
    }

    if (!belongsToKb) {
      throw new HTTPException(404, {
        message: "File not found in this knowledge base",
      })
    }

    const kbFile = await getKbFileByItemId(db, itemId)
    if (!kbFile) {
      throw new HTTPException(404, { message: "File data not found" })
    }

    // Return preview URL based on file type
    // For now, just return the storage path that can be used for preview
    // In a real implementation, this might return a signed URL or preview service URL
    return c.json({
      previewUrl: `/api/v1/kb/${kbId}/files/${itemId}/content`,
      mimeType: kbFile.mimeType,
      fileName: kbFile.originalName,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to get file preview: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to get file preview",
    })
  }
}

// Get file content for preview
export const GetFileContentApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const kbId = c.req.param("kbId")
  const itemId = c.req.param("itemId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const kb = await getKnowledgeBaseById(db, kbId)
    if (!kb) {
      throw new HTTPException(404, { message: "Knowledge Base not found" })
    }

    // Check access: owner can always access, others only if KB is public
    if (kb.ownerId !== user.id && kb.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const item = await getKbItemById(db, itemId)
    if (!item || item.type !== "file") {
      throw new HTTPException(404, { message: "File not found" })
    }

    // Verify item belongs to this KB by traversing up the hierarchy
    let currentItem = item
    let belongsToKb = false
    while (currentItem.parentId) {
      if (currentItem.parentId === kbId) {
        belongsToKb = true
        break
      }
      const parent = await getKbItemById(db, currentItem.parentId)
      if (!parent) break
      currentItem = parent
    }

    if (!belongsToKb) {
      throw new HTTPException(404, {
        message: "File not found in this knowledge base",
      })
    }

    const kbFile = await getKbFileByItemId(db, itemId)
    if (!kbFile) {
      throw new HTTPException(404, { message: "File data not found" })
    }

    // Read file content
    const fileContent = await readFile(kbFile.storagePath)

    // Return file content with appropriate headers
    return new Response(fileContent, {
      headers: {
        "Content-Type": kbFile.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${kbFile.originalName}"`,
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to get file content: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to get file content",
    })
  }
}

export const GetKbVespaIds = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const { parentIds } = await c.req.json() // Assuming the array is sent in the request body
  if (!Array.isArray(parentIds) || parentIds.length === 0) {
    throw new HTTPException(400, {
      message: "Invalid or missing parentIds array",
    })
  }
  try {
    const fileIds = await getAllFolderItems(parentIds, db)
    const ids = await getKbFilesVespaIds(fileIds, db)
    const vespaIds = ids.map((item: { vespaDocId: string }) => item.vespaDocId)
    return c.json(
      {
        data: vespaIds,
        success: true,
      },
      200,
    )
  } catch (error) {
    return c.json({
      status: 500,
      error: error,
    })
  }
}
