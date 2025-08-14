import {
  collections,
  collectionItems,
  type Collection,
  type NewCollection,
  type CollectionItem,
  type NewCollectionItem,
  type File,
  type Folder,
} from "@/db/schema"

import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { and, asc, desc, eq, isNull, sql, or, inArray } from "drizzle-orm"

// Collection CRUD operations
export const createCollection = async (
  trx: TxnOrClient,
  collection: Omit<NewCollection, 'vespaDocId'>,
): Promise<Collection> => {
  // Generate vespa doc ID for the collection
  const vespaDocId = generateCollectionVespaDocId()
  
  const collectionData: NewCollection = {
    ...collection,
    vespaDocId,
  }

  const [result] = await trx.insert(collections).values(collectionData).returning()
  if (!result) {
    throw new Error("Failed to create collection")
  }
  return result
}

export const getCollectionById = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<Collection | null> => {
  const [result] = await trx
    .select()
    .from(collections)
    .where(and(eq(collections.id, collectionId), isNull(collections.deletedAt)))
  return result || null
}

export const getCollectionsByOwner = async (
  trx: TxnOrClient,
  ownerId: number,
): Promise<Collection[]> => {
  const results = await trx
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.ownerId, ownerId),
        isNull(collections.deletedAt),
      ),
    )
    .orderBy(desc(collections.updatedAt))
  return results
}

export const getAccessibleCollections = async (
  trx: TxnOrClient,
  userId: number,
): Promise<Collection[]> => {
  // Get user's own collections and all public collections
  const results = await trx
    .select()
    .from(collections)
    .where(
      and(
        isNull(collections.deletedAt),
        or(eq(collections.ownerId, userId), eq(collections.isPrivate, false)),
      ),
    )
    .orderBy(desc(collections.updatedAt))
  return results
}

export const updateCollection = async (
  trx: TxnOrClient,
  collectionId: string,
  updates: Partial<NewCollection>,
): Promise<Collection> => {
  const [result] = await trx
    .update(collections)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
    .returning()
  if (!result) {
    throw new Error("Collection not found")
  }
  return result
}

export const softDeleteCollection = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<Collection> => {
  const [result] = await trx
    .update(collections)
    .set({
      deletedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
    .returning()
  if (!result) {
    throw new Error("Collection not found")
  }
  return result
}

// Collection Items (Folders and Files) operations
export const createCollectionItem = async (
  trx: TxnOrClient,
  item: NewCollectionItem,
): Promise<CollectionItem> => {
  const [result] = await trx.insert(collectionItems).values(item).returning()
  if (!result) {
    throw new Error("Failed to create collection item")
  }
  return result
}

export const getCollectionItemById = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<CollectionItem | null> => {
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(and(eq(collectionItems.id, itemId), isNull(collectionItems.deletedAt)))
  return result || null
}

export const getCollectionItemsByParent = async (
  trx: TxnOrClient,
  collectionId: string,
  parentId: string | null,
): Promise<CollectionItem[]> => {
  return await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        parentId ? eq(collectionItems.parentId, parentId) : isNull(collectionItems.parentId),
        isNull(collectionItems.deletedAt)
      )
    )
    .orderBy(desc(collectionItems.type), asc(collectionItems.position), asc(collectionItems.name))
}

export const getCollectionItemByPath = async (
  trx: TxnOrClient,
  collectionId: string,
  path: string,
  name: string,
): Promise<CollectionItem | null> => {
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        eq(collectionItems.path, path),
        eq(collectionItems.name, name),
        isNull(collectionItems.deletedAt),
      ),
    )
  return result || null
}

export const updateCollectionItem = async (
  trx: TxnOrClient,
  itemId: string,
  updates: Partial<NewCollectionItem>,
): Promise<CollectionItem> => {
  const [result] = await trx
    .update(collectionItems)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collectionItems.id, itemId))
    .returning()
  if (!result) {
    throw new Error("Collection item not found")
  }
  return result
}

export const softDeleteCollectionItem = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<CollectionItem> => {
  const item = await getCollectionItemById(trx, itemId)
  if (!item) {
    throw new Error("Collection item not found")
  }

  // If it's a folder, recursively delete all items inside it
  if (item.type === "folder") {
    const markDescendantsAsDeleted = async (
      parentId: string,
    ): Promise<number> => {
      const children = await trx
        .select()
        .from(collectionItems)
        .where(and(eq(collectionItems.parentId, parentId), isNull(collectionItems.deletedAt)))

      let count = children.length

      // Mark children as deleted
      if (children.length > 0) {
        await trx
          .update(collectionItems)
          .set({
            deletedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(and(eq(collectionItems.parentId, parentId), isNull(collectionItems.deletedAt)))

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
      .update(collectionItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(collectionItems.id, itemId))

    // Mark all descendants as deleted
    const descendantCount = await markDescendantsAsDeleted(itemId)

    // Update collection total count
    await updateCollectionTotalCount(trx, item.collectionId, -(descendantCount + 1))
    
    // Update parent folder counts (decrement the folder count from parent)
    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -(descendantCount + 1))
    }
  } else {
    // For files, just mark as deleted
    await trx
      .update(collectionItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(collectionItems.id, itemId))

    // Update collection total count
    await updateCollectionTotalCount(trx, item.collectionId, -1)
    
    // Update parent folder counts (decrement 1 file from parent)
    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -1)
    }
  }

  // Return the updated item
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(eq(collectionItems.id, itemId))

  return result
}

// Helper function to update collection total counts
export const updateCollectionTotalCount = async (
  trx: TxnOrClient,
  collectionId: string,
  delta: number,
): Promise<void> => {
  await trx
    .update(collections)
    .set({
      totalItems: sql`${collections.totalItems} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(collections.id, collectionId))
}

// Helper function to update folder's totalFileCount count
export const updateFolderTotalCount = async (
  trx: TxnOrClient,
  folderId: string,
  delta: number,
): Promise<void> => {
  await trx
    .update(collectionItems)
    .set({
      totalFileCount: sql`${collectionItems.totalFileCount} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(collectionItems.id, folderId), eq(collectionItems.type, "folder")))
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
  const parentFolder = await getCollectionItemById(trx, parentId)
  if (parentFolder && parentFolder.parentId) {
    // Recursively update parent folders
    await updateParentFolderCounts(trx, parentFolder.parentId, delta)
  }
}

export const createFolder = async (
  trx: TxnOrClient,
  collectionId: string,
  parentId: string | null,
  name: string,
  metadata: any = {},
  userId?: number,
  userEmail?: string,
): Promise<CollectionItem> => {
  // Get the collection to ensure it exists and get workspace info
  const collection = await getCollectionById(trx, collectionId)
  if (!collection) {
    throw new Error("Collection not found")
  }

  // Calculate path
  let path = "/"
  if (parentId) {
    const parent = await getCollectionItemById(trx, parentId)
    if (!parent) {
      throw new Error("Parent folder not found")
    }
    if (parent.type !== "folder") {
      throw new Error("Parent must be a folder")
    }
    path = parent.path + parent.name + "/"
  }

  // Check if folder already exists
  const existing = await getCollectionItemByPath(trx, collectionId, path, name)
  if (existing) {
    throw new Error("Folder already exists at this path")
  }

  // Get next position
  const siblings = await getCollectionItemsByParent(trx, collectionId, parentId)
  const nextPosition = siblings.length

  // Generate vespa doc ID for the folder
  const vespaDocId = generateFolderVespaDocId()

  // Enhanced folder creation with more populated fields
  const folder = await createCollectionItem(trx, {
    collectionId: collectionId,
    parentId,
    workspaceId: collection.workspaceId,
    ownerId: collection.ownerId,
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
      version: "1.0",
      lastModified: Date.now(),
      tags: metadata.tags || [],
    },
    processedAt: new Date(), // Mark folder as "processed" when created
    metadata,
  })

  // Update collection total count
  await updateCollectionTotalCount(trx, collectionId, 1)

  return folder
}

export const createFileItem = async (
  trx: TxnOrClient,
  collectionId: string,
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
): Promise<CollectionItem> => {
  // Get the collection to ensure it exists and get workspace info
  const collection = await getCollectionById(trx, collectionId)
  if (!collection) {
    throw new Error("Collection not found")
  }

  // Calculate path
  let path = "/"
  if (parentId) {
    const parent = await getCollectionItemById(trx, parentId)
    if (!parent) {
      throw new Error("Parent folder not found")
    }
    if (parent.type !== "folder") {
      throw new Error("Parent must be a folder")
    }
    path = parent.path + parent.name + "/"
  }

  // Check if file already exists
  const existing = await getCollectionItemByPath(trx, collectionId, path, name)
  if (existing) {
    throw new Error("File already exists at this path")
  }

  // Get next position
  const siblings = await getCollectionItemsByParent(trx, collectionId, parentId)
  const nextPosition = siblings.length

  // Create file item
  const item = await createCollectionItem(trx, {
    collectionId: collectionId,
    parentId,
    workspaceId: collection.workspaceId,
    ownerId: collection.ownerId,
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

  // Update collection total count
  await updateCollectionTotalCount(trx, collectionId, 1)
  
  // Update parent folder counts (if the file is in a folder)
  if (parentId) {
    await updateParentFolderCounts(trx, parentId, 1)
  }

  return item
}

// Get all items in a collection recursively
export const getAllCollectionItems = async (
  trx: TxnOrClient,
  collectionId: string,
): Promise<CollectionItem[]> => {
  // Get all items in the collection (not deleted)
  const items = await trx
    .select()
    .from(collectionItems)
    .where(and(eq(collectionItems.collectionId, collectionId), isNull(collectionItems.deletedAt)))
    .orderBy(desc(collectionItems.type), asc(collectionItems.position), asc(collectionItems.name))

  return items
}

// Helper functions for traversing folder structure
export const getParentItems = async (
  parentId: string,
  trx: TxnOrClient,
): Promise<CollectionItem[]> => {
  const results = await trx
    .select()
    .from(collectionItems)
    .where(and(eq(collectionItems.parentId, parentId), isNull(collectionItems.deletedAt)))
  return results
}

export const getAllCollectionAndFolderItems = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const res = []
  let queue: any[] = []
  for (const id of parentIds) {
    // Check if this is a prefixed ID (collection or collection folder)
    let actualId = id
    let isCollection = false
    let isCollectionFolder = false
    
    if (id.startsWith('cl-')) {
      actualId = id.substring(3) // Remove 'cl-' prefix
      isCollection = true
    } else if (id.startsWith('clfd-')) {
      actualId = id.substring(5) // Remove 'clfd-' prefix
      isCollectionFolder = true
    } else {
    }
    
    queue.push({ id: actualId, isCollection, isCollectionFolder })
  }
  
  while (queue.length > 0) {
    const curr = queue.shift()
    const currId = curr.id

    const resp = await getParentItems(currId, trx)
    if (resp.length == 0) {
      res.push(currId)
      continue
    }
    for (const item of resp) {
      if (item.type == "folder") {
        queue.push({ id: item.id, isCollection: false, isCollectionFolder: false })
      } else if (item.type == "file") {
        res.push(item.id)
      }
    }
  }
  return res
}

// Keep the old function for backward compatibility
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

export const getCollectionFilesVespaIds = async (
  collectionFileIds: string[],
  trx: TxnOrClient,
) => {
  const resp = await trx
    .select({
      id: collectionItems.id,
      vespaDocId: collectionItems.vespaDocId,
      originalName: collectionItems.originalName,
      mimeType: collectionItems.mimeType,
      fileSize: collectionItems.fileSize,
    })
    .from(collectionItems)
    .where(
      and(
        inArray(collectionItems.id, collectionFileIds),
        eq(collectionItems.type, "file"),
        isNull(collectionItems.deletedAt)
      )
    )

  return resp
}

// Legacy compatibility functions
export const getCollectionFileByItemId = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<File | null> => {
  const [result] = await trx
    .select()
    .from(collectionItems)
    .where(
      and(
        eq(collectionItems.id, itemId),
        eq(collectionItems.type, "file"),
        isNull(collectionItems.deletedAt)
      )
    )
  return (result as File) || null
}

export const createCollectionFile = async (
  trx: TxnOrClient,
  file: NewCollectionItem,
): Promise<File> => {
  // For backwards compatibility, this now creates a file item
  const fileData: NewCollectionItem = {
    ...file,
    type: "file",
  }
  const result = await createCollectionItem(trx, fileData)
  return result as File
}

export const updateCollectionFile = async (
  trx: TxnOrClient,
  itemId: string,
  updates: Partial<NewCollectionItem>,
): Promise<File> => {
  const result = await updateCollectionItem(trx, itemId, updates)
  return result as File
}

export const softDeleteCollectionFile = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<File> => {
  const result = await softDeleteCollectionItem(trx, itemId)
  return result as File
}

// Generate unique storage key
export const generateStorageKey = (): string => {
  return createId()
}

// Generate Vespa document ID for collection files
export const generateFileVespaDocId = (): string => {
  return `clf-${createId()}`
}

// Generate Vespa document ID for collection folders
export const generateFolderVespaDocId = (): string => {
  return `clfd-${createId()}`
}

// Generate Vespa document ID for collections
export const generateCollectionVespaDocId = (): string => {
  return `cl-${createId()}`
}
