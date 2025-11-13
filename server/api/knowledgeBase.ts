import { createId } from "@paralleldrive/cuid2"
import { mkdir, unlink, writeFile, readFile } from "node:fs/promises"
import { createReadStream as createFileReadStream } from "node:fs"
import { join, dirname, extname } from "node:path"
import { stat } from "node:fs/promises"
import { stream } from "hono/streaming"
import { userAgentPermissions, type SelectUser } from "@/db/schema"
import { z } from "zod"
import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem, ProcessingJobType, type TxnOrClient } from "@/types"
import config from "@/config"
import { getErrorMessage } from "@/utils"
import { db } from "@/db/client"
import { getUserByEmail } from "@/db/user"
import JSZip from "jszip"
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
  getCollectionFilesVespaIds,
  getCollectionItemsStatusByCollections,
  markParentAsProcessing,
  // Legacy aliases for backward compatibility
} from "@/db/knowledgeBase"
import { cleanUpAgentDb, getAgentByExternalId } from "@/db/agent"
import type { Collection, CollectionItem, File as DbFile } from "@/db/schema"
import { collectionItems, collections } from "@/db/schema"
import { and, eq, isNull, sql } from "drizzle-orm"
import { DeleteDocument, GetDocument } from "@/search/vespa"
import { ChunkMetadata, KbItemsSchema } from "@xyne/vespa-ts/types"
import {
  boss,
  FileProcessingQueue,
  PdfFileProcessingQueue,
} from "@/queue/api-server-queue"
import * as crypto from "crypto"
import { fileTypeFromBuffer } from "file-type"
import {
  DATASOURCE_CONFIG,
  getBaseMimeType,
} from "@/integrations/dataSource/config"
import { getAuth, safeGet } from "./agent"
import { ApiKeyScopes, FileType, UploadStatus } from "@/shared/types"
import { expandSheetIds } from "@/search/utils"
import { checkFileSize } from "@/integrations/dataSource"
import { getFileType } from "@/shared/fileUtils"

const EXTENSION_MIME_MAP: Record<string, string> = {
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
  ".xml": "application/xml",
  ".json": "application/json",
  ".zip": "application/zip",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".avi": "video/x-msvideo",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".md": "text/markdown",     
  ".markdown": "text/markdown",
}

const loggerWithChild = getLoggerWithChild(Subsystem.Api, {
  module: "knowledgeBaseService",
})

const { JwtPayloadKey } = config

// Storage configuration for Knowledge Base feature files
const KB_STORAGE_ROOT = join(process.cwd(), "storage", "kb_files")
const MAX_FILE_SIZE = 100 // 100MB max file size
const MAX_ZIP_FILE_SIZE = 35 // 35MB max zip file size

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
  metadata: z.record(z.any(), z.any()).optional(),
})

const updateCollectionSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  isPrivate: z.boolean().optional(),
  metadata: z.record(z.any(), z.any()).optional(),
})

const createFolderSchema = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.any(), z.any()).optional(),
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

/**
 * Checks if a file path or filename is a system file that should be skipped
 * @param pathOrName - Full path or just filename to check
 * @returns true if the file is a system file and should be skipped
 */
function isSystemFile(pathOrName: string): boolean {
  // Check for macOS system directories and files
  if (
    pathOrName.includes("__MACOSX/") ||
    pathOrName.includes("/._") ||
    pathOrName.endsWith(".DS_Store")
  ) {
    return true
  }

  // Extract filename from path
  const fileName = pathOrName.split("/").pop() || ""

  // Check for common system files
  if (
    fileName === ".DS_Store" ||
    fileName.startsWith("._") ||
    fileName === "Thumbs.db" ||
    fileName === "desktop.ini"
  ) {
    return true
  }

  return false
}

// Enhanced MIME type detection with extension normalization and magic byte analysis
async function detectMimeType(
  fileName: string,
  buffer: ArrayBuffer | Uint8Array | Buffer,
  browserMimeType?: string,
): Promise<string> {
  try {
    let detectionBuffer: Uint8Array | Buffer
    if (Buffer.isBuffer(buffer)) {
      detectionBuffer = buffer
    } else if (buffer instanceof Uint8Array) {
      detectionBuffer = buffer
    } else {
      detectionBuffer = new Uint8Array(buffer)
    }

    // Step 1: Normalize the file extension (case-insensitive)
    const ext = extname(fileName).toLowerCase()

    // Step 2: Extension-based MIME mapping uses a module-level constant now.

    // Step 3: Use magic byte detection from file-type library
    let detectedType: string | undefined
    try {
      const fileTypeResult = await fileTypeFromBuffer(detectionBuffer)
      if (fileTypeResult?.mime) {
        detectedType = fileTypeResult.mime
        loggerWithChild().debug(
          `Magic byte detection for ${fileName}: ${detectedType}`,
        )
      }
    } catch (error) {
      loggerWithChild().debug(
        `Magic byte detection failed for ${fileName}: ${getErrorMessage(error)}`,
      )
    }

    // Step 4: Determine the best MIME type using fallback strategy
    let finalMimeType: string

    // Priority: 1. Magic bytes (most reliable), 2. Extension mapping, 3. Browser type, 4. Default
    if (detectedType) {
      finalMimeType = detectedType
    } else if (EXTENSION_MIME_MAP[ext]) {
      finalMimeType = EXTENSION_MIME_MAP[ext]
    } else if (
      browserMimeType &&
      browserMimeType !== "application/octet-stream"
    ) {
      finalMimeType = browserMimeType
    } else {
      finalMimeType = "application/octet-stream"
    }

    loggerWithChild().debug(
      `MIME detection for ${fileName}: extension=${ext}, magic=${detectedType}, browser=${browserMimeType}, final=${finalMimeType}`,
    )

    return finalMimeType
  } catch (error) {
    loggerWithChild().error(
      error,
      `Error in MIME detection for ${fileName}: ${getErrorMessage(error)}`,
    )
    // Fallback to browser type or default
    return browserMimeType || "application/octet-stream"
  }
}

// API Handlers

// Create a new Collection
export const CreateCollectionApi = async (c: Context) => {
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.CREATE_COLLECTION)) {
      return c.json(
        { message: "API key does not have scope to create collections" },
        403,
      )
    }
  }

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
      via_apiKey,
    }

    loggerWithChild({ email: userEmail }).info(
      `Creating Collection with data: ${JSON.stringify(collectionData)}`,
    )

    // Create collection in database first
    const collection = await db.transaction(async (tx: TxnOrClient) => {
      return await createCollection(tx, collectionData)
    })

    // Queue after transaction commits to avoid race condition
    await boss.send(
      FileProcessingQueue,
      {
        collectionId: collection.id,
        type: ProcessingJobType.COLLECTION,
      },
      {
        retryLimit: 3,
        expireInHours: 12,
      },
    )
    loggerWithChild({ email: userEmail }).info(
      `Created Collection: ${collection.id} for user ${userEmail}`,
    )

    return c.json(collection)
  } catch (error) {
    if (error instanceof z.ZodError) {
      loggerWithChild({ email: userEmail }).error(
        `Validation error: ${JSON.stringify(error)}`,
      )
      throw new HTTPException(400, {
        message: `Invalid request data: ${JSON.stringify(error)}`,
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
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.LIST_COLLECTIONS)) {
      return c.json(
        { message: "API key does not have scope to list collections" },
        403,
      )
    }
  }
  const showOnlyOwn = c.req.query("ownOnly") === "true"
  const includeItems = c.req.query("includeItems") === "true"

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

    // If includeItems is requested, fetch items for each collection
    if (includeItems) {
      const collectionsWithItems = await Promise.all(
        collections.map(async (collection) => {
          try {
            // Check access: owner can always access, others only if Collection is public
            if (collection.ownerId !== user.id && collection.isPrivate) {
              return {
                ...collection,
                items: [], // Return empty items array for inaccessible collections
              }
            }

            const items = await getCollectionItemsByParent(
              db,
              collection.id,
              null,
            )
            return {
              ...collection,
              items,
            }
          } catch (error) {
            loggerWithChild({ email: userEmail }).warn(
              error,
              `Failed to fetch items for collection ${collection.id}: ${getErrorMessage(error)}`,
            )
            return {
              ...collection,
              items: [], // Return empty items array on error
            }
          }
        }),
      )

      return c.json(collectionsWithItems)
    }

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
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.LIST_COLLECTIONS)) {
      return c.json(
        { message: "API key does not have scope to get collection details" },
        403,
      )
    }
  }

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

export const GetCollectionNameForSharedAgentApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const collectionId = c.req.param("clId")
  const agentExternalId = c.req.query("agentExternalId")

  if (!agentExternalId || !collectionId) {
    throw new HTTPException(400, {
      message: "agentExternalId and collectionId are required",
    })
  }

  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  const agent = await getAgentByExternalId(
    db,
    agentExternalId,
    user.workspaceId,
  )

  if (!agent) {
    throw new HTTPException(404, { message: "Agent not found" })
  }
  if (!agent.isPublic) {
    const hasPermission = await db
      .select()
      .from(userAgentPermissions)
      .where(
        and(
          eq(userAgentPermissions.userId, user.id),
          eq(userAgentPermissions.agentId, agent.id),
        ),
      )
      .limit(1)

    if (!hasPermission || hasPermission.length === 0) {
      throw new HTTPException(403, {
        message: "You don't have shared access to this agent",
      })
    }
  }
  try {
    const collection = await getCollectionById(db, collectionId)
    if (!collection) {
      throw new HTTPException(404, { message: "Collection not found" })
    }

    return c.json({ name: collection.name })
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
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.UPDATE_COLLECTION)) {
      return c.json(
        { message: "API key does not have scope to update collections" },
        403,
      )
    }
  }

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
        message: `Invalid request data: ${JSON.stringify(error)}`,
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
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.DELETE_COLLECTION)) {
      return c.json(
        { message: "API key does not have scope to delete collections" },
        403,
      )
    }
  }
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

    await db.transaction(async (tx: TxnOrClient) => {
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

    // Create folder in database first
    const folder = await db.transaction(async (tx: TxnOrClient) => {
      return await createFolder(
        tx,
        collectionId,
        validatedData.parentId || null,
        validatedData.name,
        folderMetadata,
        user.id,
        user.email,
      )
    })

    // Queue after transaction commits to avoid race condition
    await boss.send(
      FileProcessingQueue,
      {
        folderId: folder.id,
        type: ProcessingJobType.FOLDER,
      },
      {
        retryLimit: 3,
        expireInHours: 12,
      },
    )

    loggerWithChild({ email: userEmail }).info(
      `Created folder: ${folder.id} in Collection: ${collectionId} with Vespa doc: ${folder.vespaDocId}`,
    )

    return c.json(folder)
  } catch (error) {
    if (error instanceof HTTPException) throw error
    if (error instanceof z.ZodError) {
      throw new HTTPException(400, {
        message: `Invalid request data: ${JSON.stringify(error)}`,
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
  uploadSessions.forEach((session, sessionId) => {
    if (now - session.createdAt > 3600000) {
      uploadSessions.delete(sessionId)
    }
  })
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

    // Create auto-folder in database first
    const newFolder = await db.transaction(async (tx: TxnOrClient) => {
      return await createFolder(
        tx,
        collectionId,
        parentId,
        folderName,
        autoCreatedFolderMetadata,
      )
    })

    // Queue after transaction commits to avoid race condition
    await boss.send(
      FileProcessingQueue,
      {
        folderId: newFolder.id,
        type: ProcessingJobType.FOLDER,
      },
      {
        retryLimit: 3,
        expireInHours: 12,
      },
    )

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
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.UPLOAD_FILES)) {
      return c.json(
        { message: "API key does not have scope to upload files to KB" },
        403,
      )
    }
  }
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
    let files = formData.getAll("files") as File[]
    let paths = formData.getAll("paths") as string[] // Get file paths for folder structure
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

    // Check if any files are zip files and extract them
    const extractedFiles: File[] = []
    const extractedPaths: string[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const ext = extname(file.name).toLowerCase()

      if (ext === ".zip") {
        // Check zip file size before extraction
        const zipSizeMB = Math.round(file.size / 1024 / 1024)
        if (file.size > MAX_ZIP_FILE_SIZE * 1024 * 1024) {
          loggerWithChild({ email: userEmail }).warn(
            `Zip file too large: ${file.name} (${zipSizeMB}MB). Maximum is ${MAX_ZIP_FILE_SIZE}MB`,
          )
          throw new HTTPException(400, {
            message: `Zip file too large (${zipSizeMB}MB). Maximum size is ${MAX_ZIP_FILE_SIZE}MB`,
          })
        }

        loggerWithChild({ email: userEmail }).info(
          `Extracting zip file: ${file.name} (${zipSizeMB}MB)`,
        )

        try {
          // Extract zip file
          const zipBuffer = await file.arrayBuffer()
          const zip = await JSZip.loadAsync(zipBuffer)

          let extractedCount = 0
          for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
            // Skip directories
            if (zipEntry.dir) continue

            // Skip system files using helper function
            if (isSystemFile(relativePath)) {
              continue
            }

            // Get the file name from the path
            const pathParts = relativePath.split("/")
            const entryFileName = pathParts[pathParts.length - 1]

            // Extract the file content
            const content = await zipEntry.async("blob")

            // Detect proper MIME type for the extracted file
            const arrayBuffer = await content.arrayBuffer()
            const mimeType = await detectMimeType(entryFileName, arrayBuffer)

            const extractedFile = new File([content], entryFileName, {
              type: mimeType,
            })

            extractedFiles.push(extractedFile)
            extractedPaths.push(relativePath)
            extractedCount++
          }

          loggerWithChild({ email: userEmail }).info(
            `Extracted ${extractedCount} files from ${file.name}`,
          )
        } catch (error) {
          loggerWithChild({ email: userEmail }).error(
            error,
            `Failed to extract zip file: ${file.name}`,
          )
          // If extraction fails, treat it as a regular file
          extractedFiles.push(file)
          extractedPaths.push(paths[i] || file.name)
        }
      } else {
        // Not a zip file, add as-is
        extractedFiles.push(file)
        extractedPaths.push(paths[i] || file.name)
      }
    }

    // Replace files and paths with extracted versions
    files = extractedFiles
    paths = extractedPaths

    // Validate file count - allow up to 3000 files for zip extractions
    const maxFilesLimit = 10000

    if (files.length > maxFilesLimit) {
      throw new HTTPException(400, {
        message: `Too many files. Maximum ${maxFilesLimit} files allowed per request`,
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
      uploadStatus?: string // Add uploadStatus field
    }

    const uploadResults: UploadResult[] = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const filePath = paths[i] || file.name // Use provided path or default to filename
      let targetParentId = parentId // Declare here so it's accessible in catch block

      // Skip system files
      if (isSystemFile(file.name)) {
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
      let storagePath = ""
      try {
        // Validate file size
        try {
          checkFileSize(file.size, MAX_FILE_SIZE)
        } catch (error) {
          uploadResults.push({
            success: false,
            fileName: file.name,
            parentId: targetParentId,
            message: `Skipped: File too large (${Math.round(file.size / 1024 / 1024)}MB). Maximum size is ${MAX_FILE_SIZE}MB`,
          })
          loggerWithChild({ email: userEmail }).info(
            `Skipped large file: ${file.name} (${file.size} bytes)`,
          )
          continue
        }

        // Parse the file path to extract folder structure
        const pathParts = filePath.split("/").filter((part) => part.length > 0)
        const originalFileName = pathParts.pop() || file.name // Get the actual filename

        // Skip if the filename is a system file (in case it comes from path)
        if (isSystemFile(originalFileName)) {
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
        let storageKey = generateStorageKey()
        const vespaDocId = generateFileVespaDocId()

        // Calculate storage path
        storagePath = getStoragePath(
          user.workspaceExternalId,
          collectionId,
          storageKey,
          fileName,
        )

        // Ensure directory exists
        await mkdir(dirname(storagePath), { recursive: true })

        // Write file to disk
        await writeFile(storagePath, new Uint8Array(buffer))

        // Detect MIME type using robust detection with extension normalization and magic bytes
        const detectedMimeType = await detectMimeType(
          originalFileName,
          buffer,
          file.type,
        )

        // Create file record in database first
        const item = await db.transaction(async (tx: TxnOrClient) => {
          return await createFileItem(
            tx,
            collectionId,
            targetParentId,
            fileName,
            vespaDocId,
            fileName,
            storagePath,
            storageKey,
            detectedMimeType,
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
            `File uploaded successfully, queued for processing`, // Initial status message
          )
        })

        // Queue after transaction commits to avoid race condition
        // Route PDF files to the PDF queue, other files to the general queue
        const queueName =
          detectedMimeType === "application/pdf"
            ? PdfFileProcessingQueue
            : FileProcessingQueue
        await boss.send(
          queueName,
          { fileId: item.id, type: ProcessingJobType.FILE },
          {
            retryLimit: 3,
            expireInHours: 12,
          },
        )

        uploadResults.push({
          success: true,
          itemId: item.id,
          fileName: fileName,
          originalFileName: originalFileName,
          parentId: targetParentId,
          message:
            fileName !== originalFileName
              ? `File uploaded as "${fileName}" (renamed to avoid duplicate) - queued for processing`
              : "File uploaded successfully - queued for processing",
          wasRenamed: fileName !== originalFileName,
          uploadStatus: UploadStatus.PENDING, // Indicate it's pending processing
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
        if (storagePath) {
          try {
            await unlink(storagePath)
          } catch (err) {
            loggerWithChild({ email: userEmail }).error(
              error,
              `Failed to clean up storage file`,
            )
          }
        }

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
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.DELETE_COLLECTION_ITEM)) {
      return c.json(
        { message: "API key does not have scope to delete collection items" },
        403,
      )
    }
  }
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

    await db.transaction(async (tx: TxnOrClient) => {
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
            const vespaDocIds = expandSheetIds(itemToDelete.vespaDocId)
            for (const id of vespaDocIds) {
              try {
                await DeleteDocument(id, KbItemsSchema)
                loggerWithChild({ email: userEmail }).info(
                  `Deleted file from Vespa: ${id}`,
                )
              } catch (error) {
                loggerWithChild({ email: userEmail }).error(
                  `Failed to delete file from Vespa: ${id}`,
                  { error: getErrorMessage(error) },
                )
              }
            }
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
      previewUrl: `/api/v1/cl/${collectionId}/files/${itemId}/content`,
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

export const GetChunkContentApi = async (c: Context) => {
  const { sub: userEmail } = c.get(JwtPayloadKey)
  const chunkIndex = parseInt(c.req.param("cId"))
  const docId = c.req.param("docId")

  try {
    const resp = await GetDocument(KbItemsSchema, docId)

    if (!resp || !resp.fields) {
      throw new HTTPException(404, {
        message: "Invalid Vespa document response",
      })
    }

    if (resp.fields.sddocname && resp.fields.sddocname !== "kb_items") {
      throw new HTTPException(404, { message: "Invalid document type" })
    }

    if (!resp.fields.chunks_pos || !resp.fields.chunks) {
      throw new HTTPException(404, { message: "Document missing chunk data" })
    }

    // Handle both legacy number[] format and new ChunkMetadata[] format
    const index = resp.fields.chunks_pos.findIndex(
      (pos: number | ChunkMetadata) => {
        // If it's a number (legacy format), compare directly
        if (typeof pos === "number") {
          return pos === chunkIndex
        }
        // If it's a ChunkMetadata object, compare the index field
        if (typeof pos === "object" && pos !== null) {
          if (pos.chunk_index !== undefined) {
            return pos.chunk_index === chunkIndex
          } else {
            loggerWithChild({ email: userEmail }).warn(
              `Unexpected chunk position object format: ${JSON.stringify(pos)}`,
            )
          }
        }
        return false
      },
    )
    if (index === -1) {
      throw new HTTPException(404, { message: "Chunk index not found" })
    }

    // Get the chunk content from Vespa response
    let chunkContent = resp.fields.chunks[index]
    let pageIndex: number | undefined

    const isSheetFile =
      getFileType({
        type: resp.fields.mimeType || "",
        name: resp.fields.fileName || "",
      }) === FileType.SPREADSHEET
    if (isSheetFile) {
      const sheetIndexMatch = docId.match(/_sheet_(\d+)$/)
      if (sheetIndexMatch) {
        pageIndex = parseInt(sheetIndexMatch[1], 10)
      } else {
        pageIndex = 0
      }
      // Remove header row (first line) and column header (first tab-delimited value) from each remaining line
      chunkContent = chunkContent.split("\n").slice(1).map((line) => {
        return line.split("\t").slice(1).join("\t")
      }).join("\n")
    } else {
      const pageNums = resp.fields.chunks_map?.[index]?.page_numbers
      pageIndex =
        Array.isArray(pageNums) && typeof pageNums[0] === "number"
          ? pageNums[0]
          : -1
    }

    if (!chunkContent) {
      throw new HTTPException(404, { message: "Chunk content not found" })
    }

    return c.json({
      chunkContent: chunkContent,
      pageIndex: pageIndex,
    })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to get chunk content: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to get chunk content",
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
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(collectionFile.originalName || "file")}`,
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

// Poll collection items status for multiple collections
export const PollCollectionsStatusApi = async (c: Context) => {
  const { email: userEmail, via_apiKey } = getAuth(c)

  if (via_apiKey) {
    const apiKeyScopes =
      safeGet<{ scopes?: string[] }>(c, "config")?.scopes || []
    if (!apiKeyScopes.includes(ApiKeyScopes.LIST_COLLECTIONS)) {
      return c.json(
        { message: "API key does not have scope to poll collection status" },
        403,
      )
    }
  }

  // Get user from database
  const users = await getUserByEmail(db, userEmail)
  if (!users || users.length === 0) {
    throw new HTTPException(404, { message: "User not found" })
  }
  const user = users[0]

  try {
    const body = await c.req.json()
    const collectionIds = body.collectionIds as string[]

    if (
      !collectionIds ||
      !Array.isArray(collectionIds) ||
      collectionIds.length === 0
    ) {
      throw new HTTPException(400, {
        message: "collectionIds array is required",
      })
    }

    // Fetch items only for collections owned by the user (enforced in DB function)
    const items = await getCollectionItemsStatusByCollections(
      db,
      collectionIds,
      user.id,
    )

    return c.json({ items })
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to poll collections status: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to poll collections status",
    })
  }
}

// Download file (supports all file types with true streaming and range requests)
export const DownloadFileApi = async (c: Context) => {
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

    // Verify item belongs to this Collection by checking collectionId directly
    if (item.collectionId !== collectionId) {
      throw new HTTPException(404, {
        message: "File not found in this knowledge base",
      })
    }

    const collectionFile = await getCollectionFileByItemId(db, itemId)
    if (!collectionFile) {
      throw new HTTPException(404, { message: "File data not found" })
    }

    // Check if file exists on disk and get stats
    let fileStats
    try {
      if (!collectionFile.storagePath) {
        throw new HTTPException(404, { message: "File storage path not found" })
      }
      fileStats = await stat(collectionFile.storagePath)
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
        loggerWithChild({ email: userEmail }).error(
          `File not found on disk: ${collectionFile.storagePath}`,
        )
        throw new HTTPException(404, {
          message:
            "File content not found on disk. The file may have been moved or deleted.",
        })
      }
      throw statError
    }
    const fileSize = fileStats.size
    const range = c.req.header("range")

    const storagePath = collectionFile.storagePath

    if (!collectionFile.originalName) {
      throw new HTTPException(400, { message: "File original name is missing" })
    }

    // Filename sanitization helper functions for download functionality
    function sanitizeFilename(name: string): string {
      // Replace non-ASCII and problematic characters with '_'
      return name.replace(/[^\x20-\x7E]|["\\]/g, "_")
    }

    // RFC 5987 encoding for filename*
    function encodeRFC5987ValueChars(str: string): string {
      return encodeURIComponent(str)
        .replace(/['()]/g, escape)
        .replace(/%(7C|60|5E)/g, unescape)
    }

    const safeFileName = sanitizeFilename(collectionFile.originalName)
    const encodedFileName = encodeRFC5987ValueChars(collectionFile.originalName)

    loggerWithChild({ email: userEmail }).info(
      `Download request: ${collectionFile.originalName} (${fileSize} bytes) ${range ? `Range: ${range}` : "Full file"}`,
    )

    // Create streaming headers that trigger immediate download dialog
    const baseHeaders = {
      "Content-Type": "application/octet-stream", // Force binary download
      "Content-Disposition": `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`,
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "X-Content-Type-Options": "nosniff",
      "X-Download-Options": "noopen",
      "X-Accel-Buffering": "no",
      "Accept-Ranges": "bytes",
    }

    if (range) {
      // Handle range requests
      const parts = range.replace(/bytes=/, "").split("-")
      const start = parseInt(parts[0], 10)
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
      const chunkSize = end - start + 1

      // Validate range
      if (start >= fileSize || end >= fileSize || start > end) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: {
            "Content-Range": `bytes */${fileSize}`,
          },
        })
      }

      loggerWithChild({ email: userEmail }).info(
        `Streaming range: ${start}-${end}/${fileSize} immediately`,
      )

      // Use Node.js streaming for more control over browser behavior
      return stream(c, async (streamWriter) => {
        // Set headers before streaming starts
        c.header("Content-Range", `bytes ${start}-${end}/${fileSize}`)
        c.header("Content-Length", chunkSize.toString())
        Object.entries(baseHeaders).forEach(([key, value]) => {
          c.header(key, value)
        })
        c.status(206)

        // Create file stream
        const readStream = createFileReadStream(storagePath, {
          start,
          end,
          highWaterMark: 64 * 1024, // 64KB chunks
        })

        return new Promise<void>((resolve, reject) => {
          readStream.on("data", async (chunk) => {
            try {
              await streamWriter.write(chunk)
            } catch (error) {
              readStream.destroy()
              reject(error)
            }
          })

          readStream.on("end", () => {
            loggerWithChild({ email: userEmail }).info(
              `Range download completed: ${collectionFile.originalName}`,
            )
            resolve()
          })

          readStream.on("error", (error) => {
            loggerWithChild({ email: userEmail }).error(
              error,
              `Stream error: ${getErrorMessage(error)}`,
            )
            reject(error)
          })
        })
      })
    } else {
      // Full file download with immediate header sending
      loggerWithChild({ email: userEmail }).info(
        `Streaming full file immediately: ${fileSize} bytes`,
      )

      return stream(c, async (streamWriter) => {
        // Set headers before streaming starts - this should trigger download dialog immediately
        c.header("Content-Length", fileSize.toString())
        Object.entries(baseHeaders).forEach(([key, value]) => {
          c.header(key, value)
        })
        c.status(200)

        // Create file stream
        const readStream = createFileReadStream(storagePath, {
          highWaterMark: 64 * 1024, // 64KB chunks
        })

        return new Promise<void>((resolve, reject) => {
          let bytesStreamed = 0

          readStream.on("data", async (chunk) => {
            try {
              await streamWriter.write(chunk)
              bytesStreamed += chunk.length

              // Log progress for large files
              if (bytesStreamed % (10 * 1024 * 1024) === 0) {
                loggerWithChild({ email: userEmail }).debug(
                  `Download progress: ${bytesStreamed}/${fileSize} bytes`,
                )
              }
            } catch (error) {
              readStream.destroy()
              reject(error)
            }
          })

          readStream.on("end", () => {
            loggerWithChild({ email: userEmail }).info(
              `Download completed: ${collectionFile.originalName} (${bytesStreamed} bytes)`,
            )
            resolve()
          })

          readStream.on("error", (error) => {
            loggerWithChild({ email: userEmail }).error(
              error,
              `Stream error: ${getErrorMessage(error)}`,
            )
            reject(error)
          })
        })
      })
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error

    const errMsg = getErrorMessage(error)
    loggerWithChild({ email: userEmail }).error(
      error,
      `Failed to download file: ${errMsg}`,
    )
    throw new HTTPException(500, {
      message: "Failed to download file",
    })
  }
}
