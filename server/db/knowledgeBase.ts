import {
  kbCollection,
  kbItems,
  type KbCollection,
  type NewKbCollection,
  type KbItem,
  type NewKbItem,
  type File,
  type Folder,
  // Legacy type aliases for backwards compatibility
  type KnowledgeBase,
  type NewKnowledgeBase,
  type KbFile,
  type NewKbFile,
} from "@/db/schema"

import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { and, asc, desc, eq, isNull, sql, or } from "drizzle-orm"

// Knowledge Base Collection CRUD operations
export const createKnowledgeBase = async (
  trx: TxnOrClient,
  kb: Omit<NewKnowledgeBase, 'vespaDocId'>,
): Promise<KnowledgeBase> => {
  // Generate vespa doc ID for the KB
  const vespaDocId = generateKbVespaDocId()
  
  const kbData: NewKbCollection = {
    ...kb,
    vespaDocId,
  }

  const [result] = await trx.insert(kbCollection).values(kbData).returning()
  if (!result) {
    throw new Error("Failed to create knowledge base")
  }
  return result
}

export const getKnowledgeBaseById = async (
  trx: TxnOrClient,
  kbId: string,
): Promise<KnowledgeBase | null> => {
  const [result] = await trx
    .select()
    .from(kbCollection)
    .where(and(eq(kbCollection.id, kbId), isNull(kbCollection.deletedAt)))
  return result || null
}

export const getKnowledgeBasesByOwner = async (
  trx: TxnOrClient,
  ownerId: number,
): Promise<KnowledgeBase[]> => {
  const results = await trx
    .select()
    .from(kbCollection)
    .where(
      and(
        eq(kbCollection.ownerId, ownerId),
        isNull(kbCollection.deletedAt),
      ),
    )
    .orderBy(desc(kbCollection.updatedAt))
  return results
}

export const getAccessibleKnowledgeBases = async (
  trx: TxnOrClient,
  userId: number,
): Promise<KnowledgeBase[]> => {
  // Get user's own KBs and all public KBs
  const results = await trx
    .select()
    .from(kbCollection)
    .where(
      and(
        isNull(kbCollection.deletedAt),
        or(eq(kbCollection.ownerId, userId), eq(kbCollection.isPrivate, false)),
      ),
    )
    .orderBy(desc(kbCollection.updatedAt))
  return results
}

export const updateKnowledgeBase = async (
  trx: TxnOrClient,
  kbId: string,
  updates: Partial<NewKnowledgeBase>,
): Promise<KnowledgeBase> => {
  const [result] = await trx
    .update(kbCollection)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(kbCollection.id, kbId))
    .returning()
  if (!result) {
    throw new Error("Knowledge base not found")
  }
  return result
}

export const softDeleteKnowledgeBase = async (
  trx: TxnOrClient,
  kbId: string,
): Promise<KnowledgeBase> => {
  const [result] = await trx
    .update(kbCollection)
    .set({
      deletedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(kbCollection.id, kbId))
    .returning()
  if (!result) {
    throw new Error("Knowledge base not found")
  }
  return result
}

// KB Items (Folders and Files) operations
export const createKbItem = async (
  trx: TxnOrClient,
  item: NewKbItem,
): Promise<KbItem> => {
  const [result] = await trx.insert(kbItems).values(item).returning()
  if (!result) {
    throw new Error("Failed to create KB item")
  }
  return result
}

export const getKbItemById = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<KbItem | null> => {
  const [result] = await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.id, itemId), isNull(kbItems.deletedAt)))
  return result || null
}

export const getKbItemsByParent = async (
  trx: TxnOrClient,
  kbId: string,
  parentId: string | null,
): Promise<KbItem[]> => {
  return await trx
    .select()
    .from(kbItems)
    .where(
      and(
        eq(kbItems.kbId, kbId),
        parentId ? eq(kbItems.parentId, parentId) : isNull(kbItems.parentId),
        isNull(kbItems.deletedAt)
      )
    )
    .orderBy(desc(kbItems.type), asc(kbItems.position), asc(kbItems.name))
}

export const getKbItemByPath = async (
  trx: TxnOrClient,
  kbId: string,
  path: string,
  name: string,
): Promise<KbItem | null> => {
  const [result] = await trx
    .select()
    .from(kbItems)
    .where(
      and(
        eq(kbItems.kbId, kbId),
        eq(kbItems.path, path),
        eq(kbItems.name, name),
        isNull(kbItems.deletedAt),
      ),
    )
  return result || null
}

export const updateKbItem = async (
  trx: TxnOrClient,
  itemId: string,
  updates: Partial<NewKbItem>,
): Promise<KbItem> => {
  const [result] = await trx
    .update(kbItems)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(kbItems.id, itemId))
    .returning()
  if (!result) {
    throw new Error("KB item not found")
  }
  return result
}

export const softDeleteKbItem = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<KbItem> => {
  const item = await getKbItemById(trx, itemId)
  if (!item) {
    throw new Error("KB item not found")
  }

  // If it's a folder, recursively delete all items inside it
  if (item.type === "folder") {
    const markDescendantsAsDeleted = async (
      parentId: string,
    ): Promise<number> => {
      const children = await trx
        .select()
        .from(kbItems)
        .where(and(eq(kbItems.parentId, parentId), isNull(kbItems.deletedAt)))

      let count = children.length

      // Mark children as deleted
      if (children.length > 0) {
        await trx
          .update(kbItems)
          .set({
            deletedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(and(eq(kbItems.parentId, parentId), isNull(kbItems.deletedAt)))

        // Recursively delete descendants of folder children
        for (const child of children) {
          if (child.type === "folder") {
            count += await markDescendantsAsDeleted(child.id)
          }
        }
      }

      return count
    }

    // Mark the folder itself as deleted
    await trx
      .update(kbItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(kbItems.id, itemId))

    // Mark all descendants as deleted
    const descendantCount = await markDescendantsAsDeleted(itemId)

    // Update KB total count
    await updateKbTotalCount(trx, item.kbId, -(descendantCount + 1))
    
    // Update parent folder counts (decrement the folder count from parent)
    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -(descendantCount + 1))
    }
  } else {
    // For files, just mark as deleted
    await trx
      .update(kbItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(kbItems.id, itemId))

    // Update KB total count
    await updateKbTotalCount(trx, item.kbId, -1)
    
    // Update parent folder counts (decrement 1 file from parent)
    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -1)
    }
  }

  // Return the updated item
  const [result] = await trx
    .select()
    .from(kbItems)
    .where(eq(kbItems.id, itemId))

  return result
}

// Helper function to update KB total counts
export const updateKbTotalCount = async (
  trx: TxnOrClient,
  kbId: string,
  delta: number,
): Promise<void> => {
  await trx
    .update(kbCollection)
    .set({
      totalItems: sql`${kbCollection.totalItems} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(kbCollection.id, kbId))
}

// Helper function to update folder's totalFileCount count
export const updateFolderTotalCount = async (
  trx: TxnOrClient,
  folderId: string,
  delta: number,
): Promise<void> => {
  await trx
    .update(kbItems)
    .set({
      totalFileCount: sql`${kbItems.totalFileCount} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(kbItems.id, folderId), eq(kbItems.type, "folder")))
}

// Helper function to update all parent folders' totalFileCount count recursively
export const updateParentFolderCounts = async (
  trx: TxnOrClient,
  parentId: string | null,
  delta: number,
): Promise<void> => {
  if (!parentId) return
  
  // Update the immediate parent folder
  await updateFolderTotalCount(trx, parentId, delta)
  
  // Get the parent folder to check if it has a parent
  const parentFolder = await getKbItemById(trx, parentId)
  if (parentFolder && parentFolder.parentId) {
    // Recursively update parent folders
    await updateParentFolderCounts(trx, parentFolder.parentId, delta)
  }
}

export const createFolder = async (
  trx: TxnOrClient,
  kbId: string,
  parentId: string | null,
  name: string,
  metadata: any = {},
  userId?: number,
  userEmail?: string,
): Promise<KbItem> => {
  // Get the KB to ensure it exists and get workspace info
  const kb = await getKnowledgeBaseById(trx, kbId)
  if (!kb) {
    throw new Error("Knowledge base not found")
  }

  // Calculate path
  let path = "/"
  if (parentId) {
    const parent = await getKbItemById(trx, parentId)
    if (!parent) {
      throw new Error("Parent folder not found")
    }
    if (parent.type !== "folder") {
      throw new Error("Parent must be a folder")
    }
    path = parent.path + parent.name + "/"
  }

  // Check if folder already exists
  const existing = await getKbItemByPath(trx, kbId, path, name)
  if (existing) {
    throw new Error("Folder already exists at this path")
  }

  // Get next position
  const siblings = await getKbItemsByParent(trx, kbId, parentId)
  const nextPosition = siblings.length

  // Generate vespa doc ID for the folder
  const vespaDocId = generateFolderVespaDocId()

  // Enhanced folder creation with more populated fields
  const folder = await createKbItem(trx, {
    kbId,
    parentId,
    workspaceId: kb.workspaceId,
    ownerId: kb.ownerId,
    name,
    type: "folder",
    path,
    position: nextPosition,
    vespaDocId,
    totalFileCount: 0, // New folders start with 0 files
    // Enhanced folder-specific fields
    originalName: name, // Store original name for folders too
    mimeType: "application/x-folder", // Use standard folder MIME type
    fileSize: null, // Folders don't have size
    checksum: null, // Folders don't have checksum
    storagePath: null, // Folders don't have storage path
    storageKey: null, // Folders don't have storage key
    // Creator information
    uploadedById: userId, // Who "uploaded" (created) this folder
    uploadedByEmail: userEmail, // Email of folder creator
    lastUpdatedById: userId,
    lastUpdatedByEmail: userEmail,
    // Processing information for folders
    processingInfo: {
      folderType: metadata.folderType || "user_created",
      createdVia: metadata.createdVia || "unknown",
      autoCreatedReason: metadata.autoCreatedReason || null,
      version: metadata.version || "1.0",
      description: metadata.description || "",
      tags: metadata.tags || [],
    },
    processedAt: new Date(), // Mark folder as "processed" when created
    metadata,
  })

  // Update KB total count
  await updateKbTotalCount(trx, kbId, 1)

  return folder
}

export const createFileItem = async (
  trx: TxnOrClient,
  kbId: string,
  parentId: string | null,
  name: string,
  vespaDocId: string,
  originalName: string,
  storagePath: string,
  storageKey: string,
  mimeType: string | null,
  fileSize: number | null,
  checksum: string | null,
  metadata: any = {},
  userId?: number,
  userEmail?: string,
): Promise<KbItem> => {
  // Get the KB to ensure it exists and get workspace info
  const kb = await getKnowledgeBaseById(trx, kbId)
  if (!kb) {
    throw new Error("Knowledge base not found")
  }

  // Calculate path
  let path = "/"
  if (parentId) {
    const parent = await getKbItemById(trx, parentId)
    if (!parent) {
      throw new Error("Parent folder not found")
    }
    if (parent.type !== "folder") {
      throw new Error("Parent must be a folder")
    }
    path = parent.path + parent.name + "/"
  }

  // Check if file already exists
  const existing = await getKbItemByPath(trx, kbId, path, name)
  if (existing) {
    throw new Error("File already exists at this path")
  }

  // Get next position
  const siblings = await getKbItemsByParent(trx, kbId, parentId)
  const nextPosition = siblings.length

  // Create file item
  const item = await createKbItem(trx, {
    kbId,
    parentId,
    workspaceId: kb.workspaceId,
    ownerId: kb.ownerId,
    name,
    type: "file",
    path,
    position: nextPosition,
    vespaDocId,
    originalName,
    storagePath,
    storageKey,
    mimeType,
    fileSize,
    checksum,
    uploadedById: userId,
    uploadedByEmail: userEmail,
    lastUpdatedById: userId,
    lastUpdatedByEmail: userEmail,
    metadata,
  })

  // Update KB total count
  await updateKbTotalCount(trx, kbId, 1)
  
  // Update parent folder counts (if the file is in a folder)
  if (parentId) {
    await updateParentFolderCounts(trx, parentId, 1)
  }

  return item
}

// Get all items in a KB recursively
export const getAllKbItems = async (
  trx: TxnOrClient,
  kbId: string,
): Promise<KbItem[]> => {
  // Get all items in the KB (not deleted)
  const items = await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.kbId, kbId), isNull(kbItems.deletedAt)))
    .orderBy(desc(kbItems.type), asc(kbItems.position), asc(kbItems.name))

  return items
}

// Helper functions for traversing folder structure
export const getParentItems = async (
  parentId: string,
  trx: TxnOrClient,
): Promise<KbItem[]> => {
  const results = await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.parentId, parentId), isNull(kbItems.deletedAt)))
  return results
}

export const getAllFolderItems = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const res = []
  let queue: any[] = []
  for (const id of parentIds) {
    queue.push(id)
  }
  while (queue.length > 0) {
    const curr = queue.shift()

    const resp = await getParentItems(curr, trx)
    if (resp.length == 0) {
      res.push(curr)
      continue
    }
    for (const item of resp) {
      if (item.type == "folder") {
        queue.push(item.id)
      } else if (item.type == "file") {
        res.push(item.id)
      }
    }
  }
  return res
}

export const getKbFilesVespaIds = async (
  KbFilesId: string[],
  trx: TxnOrClient,
) => {
  const resp = await trx
    .select({
      id: kbItems.id,
      vespaDocId: kbItems.vespaDocId,
      originalName: kbItems.originalName,
      mimeType: kbItems.mimeType,
      fileSize: kbItems.fileSize,
    })
    .from(kbItems)
    .where(
      and(
        sql`${kbItems.id} IN (${sql.join(
          KbFilesId.map((id) => sql`${id}`),
          sql`, `,
        )})`,
        eq(kbItems.type, "file"),
        isNull(kbItems.deletedAt)
      )
    )

  return resp
}

// Legacy compatibility functions
export const getKbFileByItemId = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<KbFile | null> => {
  const [result] = await trx
    .select()
    .from(kbItems)
    .where(
      and(
        eq(kbItems.id, itemId),
        eq(kbItems.type, "file"),
        isNull(kbItems.deletedAt)
      )
    )
  return (result as KbFile) || null
}

export const createKbFile = async (
  trx: TxnOrClient,
  file: NewKbFile,
): Promise<KbFile> => {
  // For backwards compatibility, this now creates a file item
  const fileData: NewKbItem = {
    ...file,
    type: "file",
  }
  const result = await createKbItem(trx, fileData)
  return result as KbFile
}

export const updateKbFile = async (
  trx: TxnOrClient,
  itemId: string,
  updates: Partial<NewKbFile>,
): Promise<KbFile> => {
  const result = await updateKbItem(trx, itemId, updates)
  return result as KbFile
}

export const softDeleteKbFile = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<KbFile> => {
  const result = await softDeleteKbItem(trx, itemId)
  return result as KbFile
}

// Generate unique storage key
export const generateStorageKey = (): string => {
  return createId()
}

// Generate Vespa document ID for KB files
export const generateVespaDocId = (): string => {
  return `kbf-${createId()}`
}

// Generate Vespa document ID for KB folders
export const generateFolderVespaDocId = (): string => {
  return `kbfd-${createId()}`
}

// Generate Vespa document ID for KB collections
export const generateKbVespaDocId = (): string => {
  return `kb-${createId()}`
}
