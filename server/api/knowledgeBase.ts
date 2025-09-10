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
  // New primary function names
  createCollection,
  getCollectionById,
  getCollectionsByOwner,
  getAccessibleCollections,
  updateCollection,
  softDeleteCollection,
  createFolder,
  createFileItem,
  getCollectionItemById,
  getCollectionItemsByParent,
  getCollectionItemByPath,
  updateCollectionItem,
  softDeleteCollectionItem,
  getCollectionFileByItemId,
  generateStorageKey,
  generateFileVespaDocId,
  generateFolderVespaDocId,
  generateCollectionVespaDocId,
  // Legacy aliases for backward compatibility
  } from "@/db/knowledgeBase"
import { cleanUpAgentDb } from "@/db/agent"
import type { 
  Collection, 
  CollectionItem, 
  File as DbFile, 
} from "@/db/schema"
import { collectionItems, collections } from "@/db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { insert, DeleteDocument } from "@/search/vespa"
import { Apps, KbItemsSchema, KnowledgeBaseEntity } from "@/search/types"
import crypto from "crypto"
import { FileProcessorService } from "@/services/fileProcessor"
import {
  DATASOURCE_CONFIG,
  getBaseMimeType,
} from "@/integrations/dataSource/config"

const loggerWithChild = getLoggerWithChild(Subsystem.Api, {
  module: "knowledgeBaseService",
})

const { JwtPayloadKey } = config

// Storage configuration for Knowledge Base feature files
const KB_STORAGE_ROOT = join(process.cwd(), "storage", "kb_files")
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB max file size
const MAX_FILES_PER_REQUEST = 100 // Maximum files per upload request

// Initialize storage directory for Knowledge Base files
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

// Schema definitions for Knowledge Base feature
const createCollectionSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  isPrivate: z.boolean().optional().default(true),
  metadata: z.record(z.any()).optional(),
})

const updateCollectionSchema = z.object({
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
  collectionId: string,
  storageKey: string,
  fileName: string,
): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  return join(
    KB_STORAGE_ROOT,
    workspaceId,
    collectionId,
    year.toString(),
    month,
    `${storageKey}_${fileName}`,
  )
}

// API Handlers

// Create a new Collection
export const CreateCollectionApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)

  // Get user from database like other APIs do
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    loggerWithChild({ email: userEmail }).error(
      "No user found for email in CreateCollectionApi",
    )
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const rawData = await c.req.json()
    loggerWithChild({ email: userEmail }).info(
      `Creating Collection with raw data: ${JSON.stringify(rawData)}`,
    )

    const validatedData = createCollectionSchema.parse(rawData)
    const vespaDocId = generateCollectionVespaDocId()
    loggerWithChild({ email: userEmail }).info(
      `User object: ${JSON.stringify({ id: user.id, email: user.email, role: user.role })}`,
    )

    const collectionData = {
      name: validatedData.name,
      description: validatedData.description || null,
      workspaceId: user.workspaceId,
      ownerId: user.id,
      isPrivate: validatedData.isPrivate ?? true,
      lastUpdatedById: user.id,
      lastUpdatedByEmail: user.email,
      metadata: {
        ...(validatedData.metadata || {}),
        vespaDocId: vespaDocId, // Store the vespaDocId in metadata
      },
    }

    loggerWithChild({ email: userEmail }).info(
      `Creating Collection with data: ${JSON.stringify(collectionData)}`,
    )

    // Use transaction to ensure both database and Vespa operations succeed together
    const collection = await db.transaction(async (tx) => {
      const createdCollection = await createCollection(tx, collectionData)

      const vespaDoc = {
        docId: vespaDocId,
        clId: createdCollection.id,
        itemId: createdCollection.id,
        fileName: validatedData.name,
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.Collection,
        description: validatedData.description || "",
        storagePath: "",
        chunks: [],
        image_chunks: [],
        chunks_pos: [],
        image_chunks_pos: [],
        metadata: JSON.stringify({
          version: "1.0",
          lastModified: Date.now(),
          ...validatedData.metadata,
        }),
        createdBy: user.email,
        duration: 0,
        mimeType: "knowledge_base",
        fileSize: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      await insert(vespaDoc, KbItemsSchema)
      return createdCollection
    })
    loggerWithChild({ email: userEmail }).info(
      `Created Collection: ${collection.id} for user ${userEmail}`,
    )

    return c.json(collection)
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
      `Failed to create Collection: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: `Failed to create Collection: ${errMsg}`,
    })
  }
}

// List Collections for a user
export const ListCollectionsApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const showOnlyOwn = c.req.query("ownOnly") === "true"

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collections = showOnlyOwn
      ? await getCollectionsByOwner(db, user.id)
      : await getAccessibleCollections(db, user.id)
    return c.json(collections)
  } catch (error) {
    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to list Collections: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to list Collections",
    })
  }
}

// Get a specific Collection
export const GetCollectionApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check access: owner can always access, others only if Collection is public
    if (collection.ownerId !== user.id && collection.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
      })
    }

    return c.json(collection)
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to get Collection: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to get Collection",
    })
  }
}

// Update a Collection
export const UpdateCollectionApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check ownership
    if (collection.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
      })
    }

    const rawData = await c.req.json()
    const validatedData = updateCollectionSchema.parse(rawData)

    const updatedCollection = await updateCollection(db, collectionId, {
      ...validatedData,
      lastUpdatedById: user.id,
      lastUpdatedByEmail: user.email,
    })

    loggerWithChild({ email: userEmail }).info(
      `Updated Collection: ${collectionId}`,
    )

    return c.json(updatedCollection)
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
      `Failed to update Collection: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to update Collection",
    })
  }
}

// Delete a Collection
export const DeleteCollectionApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check ownership
    if (collection.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
      })
    }

    // Get all items that belong to this collection directly via collectionId
    const collectionItemsToDelete = await db
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.collectionId, collectionId),
          isNull(collectionItems.deletedAt),
        ),
      )

    // Use transaction to ensure database operations are atomic
    let deletedFilesCount = 0
    let deletedFoldersCount = 0
    const deletedItemIds: string[] = []

    await db.transaction(async (tx) => {
      // Collect item IDs for agent cleanup (with proper prefixes)
      for (const item of collectionItemsToDelete) {
        if (item.type === "file") {
          deletedItemIds.push(`clf-${item.id}`)
        } else if (item.type === "folder") {
          deletedItemIds.push(`clfd-${item.id}`)
        }
      }
      // Also include collection ID
      deletedItemIds.push(`cl-${collectionId}`)

      // Soft delete all items in the collection first
      if (collectionItemsToDelete.length > 0) {
        const itemIds = collectionItemsToDelete.map((item) => item.id)
        await tx
          .update(collectionItems)
          .set({
            deletedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(
            sql`${collectionItems.id} IN (${sql.join(
              itemIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          )
      }

      // Soft delete the collection itself
      await softDeleteCollection(tx, collectionId)

      // Clean up agent references to deleted items
      if (deletedItemIds.length > 0) {
        await cleanUpAgentDb(tx, deletedItemIds, userEmail)
      }
    })

    // After successful database transaction, clean up Vespa and storage
    // These operations are logged but don't fail the deletion if they error
    for (const item of collectionItemsToDelete) {
      if (item.type === "file") {
        try {
          // Delete from Vespa
          if (item.vespaDocId) {
            await DeleteDocument(item.vespaDocId, KbItemsSchema)
            loggerWithChild({ email: userEmail }).info(
              `Deleted file from Vespa: ${item.vespaDocId}`,
            )
          }
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to delete file from Vespa: ${item.vespaDocId} - ${getErrorMessage(error)}`,
          )
        }

        try {
          // Delete from storage
          if (item.storagePath) {
            await unlink(item.storagePath)
            loggerWithChild({ email: userEmail }).info(
              `Deleted from storage: ${item.storagePath}`,
            )
          }
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to delete file from storage: ${item.storagePath} - ${getErrorMessage(error)}`,
          )
        }

        deletedFilesCount++
      } else if (item.type === "folder") {
        // Delete folder from Vespa
        if (item.vespaDocId) {
          try {
            await DeleteDocument(item.vespaDocId, KbItemsSchema)
            deletedFoldersCount++
            loggerWithChild({ email: userEmail }).info(
              `Deleted folder from Vespa: ${item.vespaDocId}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete folder from Vespa: ${item.vespaDocId} - ${getErrorMessage(error)}`,
            )
          }
        }
      }
    }

    // Delete the collection from Vespa
    try {
      if (collection.vespaDocId) {
        await DeleteDocument(collection.vespaDocId, KbItemsSchema)
        loggerWithChild({ email: userEmail }).info(
          `Deleted collection from Vespa: ${collection.vespaDocId}`,
        )
      }
    } catch (error) {
      loggerWithChild({ email: userEmail }).warn(
        `Failed to delete collection from Vespa: ${collection.vespaDocId} - ${getErrorMessage(error)}`,
      )
    }

    loggerWithChild({ email: userEmail }).info(
      `Deleted Collection: ${collectionId} (${collectionItemsToDelete.length} items deleted, ${deletedFilesCount} files and ${deletedFoldersCount} folders removed from Vespa and storage)`,
    )

    return c.json({
      success: true,
      deletedCount: collectionItemsToDelete.length,
      deletedFiles: deletedFilesCount,
      deletedFolders: deletedFoldersCount,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to delete Collection: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to delete Collection",
    })
  }
}

// List items in a Collection
export const ListCollectionItemsApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")
  const parentId = c.req.query("parentId") || null

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check access: owner can always access, others only if Collection is public
    if (collection.ownerId !== user.id && collection.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
      })
    }

    const items = await getCollectionItemsByParent(db, collectionId, parentId)
    return c.json(items)
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to list Collection items: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to list Collection items",
    })
  }
}

// Create a folder
export const CreateFolderApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check ownership
    if (collection.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
      })
    }

    const rawData = await c.req.json()
    const validatedData = createFolderSchema.parse(rawData)

    // Enhanced folder metadata with more details (no vespaDocId here!)
    const folderMetadata = {
      ...(validatedData.metadata || {}),
      type: "folder",
      createdBy: user.email,
      createdById: user.id,
      workspaceId: user.workspaceId,
      clId: collectionId,
      parentId: validatedData.parentId || null,
      description: validatedData.metadata?.description || "",
      tags: validatedData.metadata?.tags || [],
      folderType: "user_created", // vs "auto_created" during file upload
      createdVia: "api",
      version: "1.0",
    }

    // Use transaction to ensure both folder creation and Vespa insertion succeed together
    const folder = await db.transaction(async (tx) => {
      const createdFolder = await createFolder(
        tx,
        collectionId,
        validatedData.parentId || null,
        validatedData.name,
        folderMetadata,
        user.id,
        user.email,
      )

      // Use the vespaDocId from the folder record (generated in createFolder)
      const vespaDoc = {
        docId: createdFolder.vespaDocId!,
        clId: collectionId,
        itemId: createdFolder.id,
        app: Apps.KnowledgeBase as const,
        fileName: validatedData.name,
        entity: KnowledgeBaseEntity.Folder,
        description: folderMetadata.description || "",
        storagePath: "",
        chunks: [],
        image_chunks: [],
        chunks_pos: [],
        image_chunks_pos: [],
        metadata: JSON.stringify({
          version: "1.0",
          lastModified: Date.now(),
          tags: folderMetadata.tags || [],
        }),
        createdBy: user.email,
        duration: 0,
        mimeType: "folder",
        fileSize: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      await insert(vespaDoc, KbItemsSchema)
      return createdFolder
    })

    loggerWithChild({ email: userEmail }).info(
      `Created folder: ${folder.id} in Collection: ${collectionId} with Vespa doc: ${folder.vespaDocId}`,
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
  collectionId: string,
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
  const existingItems = await getCollectionItemsByParent(
    db,
    collectionId,
    parentId,
  )
  const existingFolder = existingItems.find(
    (item) =>
      item.type === "folder" &&
      item.name.toLowerCase() === folderName.toLowerCase(),
  )

  let currentFolderId: string

  if (existingFolder) {
    currentFolderId = existingFolder.id
  } else {
    // Enhanced folder metadata for auto-created folders during file upload (no vespaDocId!)
    const autoCreatedFolderMetadata = {
      type: "folder",
      createdBy: "system",
      createdById: null, // System-created
      workspaceId: null, // Will be populated by createFolder
      clId: collectionId,
      parentId: parentId || null,
      description: "Auto-created during file upload",
      tags: ["auto-created"],
      folderType: "auto_created", // vs "user_created" from API
      createdVia: "file_upload",
      version: "1.0",
      autoCreatedReason: "folder_structure_from_file_path",
    }

    // Use transaction to ensure both folder creation and Vespa insertion succeed together
    const newFolder = await db.transaction(async (tx: any) => {
      const createdFolder = await createFolder(
        tx,
        collectionId,
        parentId,
        folderName,
        autoCreatedFolderMetadata,
      )

      // Use the vespaDocId from the newly created folder (no duplication!)
      const vespaDoc = {
        docId: createdFolder.vespaDocId!, // Use the ID generated by createFolder
        clId: collectionId,
        itemId: createdFolder.id,
        fileName: folderName,
        app: Apps.KnowledgeBase as const,
        entity: KnowledgeBaseEntity.Folder,
        description: "Auto-created during file upload",
        storagePath: "",
        chunks: [],
        image_chunks: [],
        chunks_pos: [],
        image_chunks_pos: [],
        metadata: JSON.stringify({
          version: "1.0",
          lastModified: Date.now(),
          autoCreated: true,
          originalPath: pathParts.join("/"),
        }),
        createdBy: "system",
        duration: 0,
        mimeType: "folder",
        fileSize: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      await insert(vespaDoc, KbItemsSchema)
      return createdFolder
    })

    currentFolderId = newFolder.id

    loggerWithChild().info(
      `Auto-created folder during upload: ${newFolder.id} in Collection: ${collectionId} with Vespa doc: ${newFolder.vespaDocId}`,
    )
  }

  // Cache the result
  if (folderCache) {
    folderCache.set(pathParts.slice(0, 1).join("/"), currentFolderId)
  }

  // Recursively process remaining path parts
  return ensureFolderPath(
    db,
    collectionId,
    pathParts.slice(1),
    currentFolderId,
    folderCache,
  )
}

// Upload files
export const UploadFilesApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")
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
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check ownership
    if (collection.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
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
            collectionId,
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
          const parent = await getCollectionItemById(db, targetParentId)
          if (parent) {
            targetPath = parent.path + parent.name + "/"
          }
        }

        const existingItems = await getCollectionItemsByParent(
          db,
          collectionId,
          targetParentId,
        )
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
        const existingFile = await getCollectionItemByPath(
          db,
          collectionId,
          targetPath,
          fileName,
        )

        if (existingFile) {
          // File with same name exists - check checksum to decide action
          const existingCollectionFile = await getCollectionFileByItemId(
            db,
            existingFile.id,
          )

          if (
            existingCollectionFile &&
            existingCollectionFile.checksum === checksum
          ) {
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
              await softDeleteCollectionItem(db, existingFile.id)

              if (existingCollectionFile) {
                if (existingCollectionFile.vespaDocId) {
                  await DeleteDocument(
                    existingCollectionFile.vespaDocId,
                    KbItemsSchema,
                  )
                }
                try {
                  if (existingCollectionFile.storagePath) {
                    await unlink(existingCollectionFile.storagePath)
                  }
                } catch (error) {
                  // Ignore file deletion errors
                }
              }
            }
          }
        }

        // Generate unique identifiers
        const storageKey = generateStorageKey()
        const vespaDocId = generateFileVespaDocId()

        // Calculate storage path
        const storagePath = getStoragePath(
          user.workspaceExternalId,
          collectionId,
          storageKey,
          fileName,
        )

        // Ensure directory exists
        await mkdir(dirname(storagePath), { recursive: true })

        // Write file to disk
        await writeFile(storagePath, new Uint8Array(buffer))

        // Process file using the service
        const processingResult = await FileProcessorService.processFile(
          buffer,
          file.type || "text/plain",
          fileName,
          vespaDocId,
          storagePath,
        )

        const { chunks, chunks_pos, image_chunks, image_chunks_pos } =
          processingResult

        // Use transaction for atomic file creation AND Vespa insertion
        const item = await db.transaction(async (tx) => {
          const createdItem = await createFileItem(
            tx,
            collectionId,
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

          // Create Vespa document within the same transaction
          const vespaDoc = {
            docId: vespaDocId,
            clId: collectionId,
            itemId: createdItem.id,
            fileName:
              targetPath === "/"
                ? collection.name + targetPath + filePath
                : collection.name + targetPath + fileName,
            app: Apps.KnowledgeBase as const,
            entity: KnowledgeBaseEntity.File, // Always "file" for files being uploaded
            description: "", // Default description for uploaded files
            storagePath: storagePath,
            chunks: chunks,
            chunks_pos: chunks_pos,
            image_chunks: image_chunks,
            image_chunks_pos: image_chunks_pos,
            metadata: JSON.stringify({
              originalFileName: file.name,
              uploadedBy: user.email,
              chunksCount: chunks.length,
              imageChunksCount: image_chunks.length,
              processingMethod: getBaseMimeType(file.type || "text/plain"),
              lastModified: Date.now(),
            }),
            createdBy: user.email,
            duration: 0,
            mimeType: getBaseMimeType(file.type || "text/plain"),
            fileSize: file.size,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }

          await insert(vespaDoc, KbItemsSchema)
          return createdItem
        })

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
          `Uploaded file: ${fileName} to KB: ${collectionId}`,
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
  const collectionId = c.req.param("clId")
  const itemId = c.req.param("itemId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check ownership
    if (collection.ownerId !== user.id) {
      throw new HTTPException(403, {
        message: "You don't have access to this Knowledge Base",
      })
    }

    const item = await getCollectionItemById(db, itemId)
    if (!item) {
      throw new HTTPException(404, { message: "Item not found" })
    }

    // Verify item belongs to this Collection by checking collectionId directly
    if (item.collectionId !== collectionId) {
      throw new HTTPException(404, {
        message: "Item not found in this knowledge base",
      })
    }

    // Collect all items to delete (including descendants if it's a folder)
    const itemsToDelete: CollectionItem[] = []

    if (item.type === "file") {
      // For files, just add the single file
      itemsToDelete.push(item)
    } else if (item.type === "folder") {
      // For folders, get all descendants recursively
      const getAllDescendants = async (
        parentId: string,
      ): Promise<CollectionItem[]> => {
        const children = await db
          .select()
          .from(collectionItems)
          .where(
            and(
              eq(collectionItems.parentId, parentId),
              isNull(collectionItems.deletedAt),
            ),
          )

        const allDescendants: CollectionItem[] = [...children]

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
      itemsToDelete.push(item)
      const descendants = await getAllDescendants(itemId)
      itemsToDelete.push(...descendants)
    }

    // Use transaction to ensure database operations are atomic first
    let deletedFilesCount = 0
    let deletedFoldersCount = 0
    const deletedItemIds: string[] = []

    await db.transaction(async (tx) => {
      // Collect item IDs for agent cleanup (with proper prefixes)
      for (const itemToDelete of itemsToDelete) {
        if (itemToDelete.type === "file") {
          deletedItemIds.push(`clf-${itemToDelete.id}`)
        } else if (itemToDelete.type === "folder") {
          deletedItemIds.push(`clfd-${itemToDelete.id}`)
        }
      }

      // Soft delete the item (and all descendants if it's a folder)
      await softDeleteCollectionItem(tx, itemId)

      // Clean up agent references to deleted items
      if (deletedItemIds.length > 0) {
        await cleanUpAgentDb(tx, deletedItemIds, userEmail)
      }
    })

    // After successful database transaction, clean up Vespa and storage
    // These operations are logged but don't fail the deletion if they error
    for (const itemToDelete of itemsToDelete) {
      if (itemToDelete.type === "file") {
        try {
          // Delete from Vespa
          if (itemToDelete.vespaDocId) {
            await DeleteDocument(itemToDelete.vespaDocId, KbItemsSchema)
            loggerWithChild({ email: userEmail }).info(
              `Deleted file from Vespa: ${itemToDelete.vespaDocId}`,
            )
          }
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to delete file from Vespa: ${itemToDelete.vespaDocId} - ${getErrorMessage(error)}`,
          )
        }

        try {
          // Delete from storage
          if (itemToDelete.storagePath) {
            await unlink(itemToDelete.storagePath)
            loggerWithChild({ email: userEmail }).info(
              `Deleted from storage: ${itemToDelete.storagePath}`,
            )
          }
        } catch (error) {
          loggerWithChild({ email: userEmail }).warn(
            `Failed to delete file from storage: ${itemToDelete.storagePath} - ${getErrorMessage(error)}`,
          )
        }

        deletedFilesCount++
      } else if (itemToDelete.type === "folder") {
        // Delete folder from Vespa
        if (itemToDelete.vespaDocId) {
          try {
            await DeleteDocument(itemToDelete.vespaDocId, KbItemsSchema)
            deletedFoldersCount++
            loggerWithChild({ email: userEmail }).info(
              `Deleted folder from Vespa: ${itemToDelete.vespaDocId}`,
            )
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              `Failed to delete folder from Vespa: ${itemToDelete.vespaDocId} - ${getErrorMessage(error)}`,
            )
          }
        }
      }
    }

    loggerWithChild({ email: userEmail }).info(
      `Deleted item: ${itemId} from Collection: ${collectionId} (${itemsToDelete.length} total items deleted, ${deletedFilesCount} files and ${deletedFoldersCount} folders)`,
    )

    return c.json({
      success: true,
      deletedCount: itemsToDelete.length,
      deletedFiles: deletedFilesCount,
      deletedFolders: deletedFoldersCount,
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
  const collectionId = c.req.param("clId")
  const itemId = c.req.param("itemId")

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    // Check access: owner can always access, others only if Collection is public
    if (collection.ownerId !== user.id && collection.isPrivate) {
      throw new HTTPException(403, {
        message: "You don't have access to this Collection",
      })
    }

    const item = await getCollectionItemById(db, itemId)
    if (!item || item.type !== "file") {
      throw new HTTPException(404, { message: "File not found" })
    }

    // Verify item belongs to this Collection by traversing up the hierarchy
    let currentItem = item
    let belongsToCollection = currentItem.collectionId === collectionId
    while (currentItem.parentId) {
      if (currentItem.parentId === collectionId) {
        belongsToCollection = true
        break
      }
      const parent = await getCollectionItemById(db, currentItem.parentId)
      if (!parent) break
      currentItem = parent
    }

    if (!belongsToCollection) {
      throw new HTTPException(404, {
        message: "File not found in this knowledge base",
      })
    }

    const collectionFile = await getCollectionFileByItemId(db, itemId)
    if (!collectionFile) {
      throw new HTTPException(404, { message: "File data not found" })
    }

    // Return preview URL based on file type
    // For now, just return the storage path that can be used for preview
    // In a real implementation, this might return a signed URL or preview service URL
    return c.json({
      previewUrl: `/api/v1/kb/${collectionId}/files/${itemId}/content`,
      mimeType: collectionFile.mimeType,
      fileName: collectionFile.originalName,
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
  const collectionId = c.req.param("clId")
  const itemId = c.req.param("itemId")

  try {
    const collectionFile = await getCollectionFileByItemId(db, itemId)
    if (!collectionFile) {
      throw new HTTPException(404, { message: "File data not found" })
    }

    // Read file content
    if (!collectionFile.storagePath) {
      throw new HTTPException(404, { message: "File storage path not found" })
    }
    const fileContent = await readFile(collectionFile.storagePath)

    // Return file content with appropriate headers
    return new Response(new Uint8Array(fileContent), {
      headers: {
        "Content-Type": collectionFile.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${collectionFile.originalName}"`,
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
