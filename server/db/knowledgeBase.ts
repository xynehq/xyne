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
import { UploadStatus } from "@/shared/types"
import { getUserByEmail } from "./user"

// Collection CRUD operations
export const createCollection = async (
  trx: TxnOrClient,
  collection: Omit<NewCollection, "vespaDocId">,
): Promise<Collection> => {
  // Generate vespa doc ID for the collection
  const vespaDocId = generateCollectionVespaDocId()

  const collectionData: NewCollection = {
    ...collection,
    vespaDocId,
  }

  const [result] = await trx
    .insert(collections)
    .values(collectionData)
    .returning()
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
    .where(and(eq(collections.ownerId, ownerId), isNull(collections.deletedAt)))
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
    .where(
      and(eq(collectionItems.id, itemId), isNull(collectionItems.deletedAt)),
    )
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
        parentId
          ? eq(collectionItems.parentId, parentId)
          : isNull(collectionItems.parentId),
        isNull(collectionItems.deletedAt),
      ),
    )
    .orderBy(
      desc(collectionItems.type),
      asc(collectionItems.position),
      asc(collectionItems.name),
    )
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
        .where(
          and(
            eq(collectionItems.parentId, parentId),
            isNull(collectionItems.deletedAt),
          ),
        )

      // We only want to decrement file counts for parents
      let filesDeleted = children.filter((c) => c.type === "file").length

      // Mark children as deleted
      if (children.length > 0) {
        await trx
          .update(collectionItems)
          .set({
            deletedAt: sql`NOW()`,
            updatedAt: sql`NOW()`,
          })
          .where(
            and(
              eq(collectionItems.parentId, parentId),
              isNull(collectionItems.deletedAt),
            ),
          )

        // Recursively delete descendants of folder children
        for (const child of children) {
          if (child.type === "folder") {
            filesDeleted += await markDescendantsAsDeleted(child.id)
          }
        }
      }

      return filesDeleted
    }

    // Mark the folder itself as deleted
    await trx
      .update(collectionItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(collectionItems.id, itemId))

    // Mark all descendants as deleted and get count of files only
    const descendantFilesCount = await markDescendantsAsDeleted(itemId)

    // Get direct children count for collection total (includes both files and folders)
    const directChildren = await trx
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.parentId, itemId),
          isNull(collectionItems.deletedAt),
        ),
      )

    // Update collection total count (all descendants + the folder itself)
    await updateCollectionTotalCount(
      trx,
      item.collectionId,
      -(directChildren.length + 1),
    )

    // Update parent folder counts (decrement only file count from parent)
    if (item.parentId) {
      await updateParentFolderCounts(trx, item.parentId, -descendantFilesCount)
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
    .where(
      and(eq(collectionItems.id, folderId), eq(collectionItems.type, "folder")),
    )
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

  // Mark parent folder/collection as PROCESSING when folder is created
  if (parentId) {
    await markParentAsProcessing(trx, parentId, false)
  } else {
    await markParentAsProcessing(trx, collectionId, true)
  }

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
  statusMessage?: string,
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
    statusMessage,
    metadata,
  })

  // Update collection total count
  await updateCollectionTotalCount(trx, collectionId, 1)

  // Update parent folder counts (if the file is in a folder)
  if (parentId) {
    await updateParentFolderCounts(trx, parentId, 1)
  }

  // Mark parent folder/collection as PROCESSING when file is uploaded
  if (parentId) {
    await markParentAsProcessing(trx, parentId, false)
  } else {
    await markParentAsProcessing(trx, collectionId, true)
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
    .where(
      and(
        eq(collectionItems.collectionId, collectionId),
        isNull(collectionItems.deletedAt),
      ),
    )
    .orderBy(
      desc(collectionItems.type),
      asc(collectionItems.position),
      asc(collectionItems.name),
    )

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
    .where(
      and(
        eq(collectionItems.parentId, parentId),
        isNull(collectionItems.deletedAt),
      ),
    )
  return results
}

export const getAllCollectionAndFolderItems = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const fileIds: string[] = []
  const folderIds: string[] = []
  type Q = { itemId: string }
  const queue: Q[] = []

  // Seed traversal
  for (const input of parentIds) {
    if (input.startsWith("cl-")) {
      // Collection vespa docId -> fetch top-level items
      const [col] = await trx
        .select({ id: collections.id })
        .from(collections)
        .where(
          and(eq(collections.vespaDocId, input), isNull(collections.deletedAt)),
        )
      if (!col) continue
      const roots = await trx
        .select({ id: collectionItems.id, type: collectionItems.type })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.collectionId, col.id),
            isNull(collectionItems.parentId),
            isNull(collectionItems.deletedAt),
          ),
        )
      roots.forEach((r) => queue.push({ itemId: r.id }))
      roots.forEach((r) => {
        if (r.type == "folder") {
          folderIds.push(r.id)
        } else if (r.type == "file") {
          fileIds.push(r.id)
        }
      })
    } else if (input.startsWith("clfd-")) {
      // Folder vespa docId -> resolve to item id
      const [folder] = await trx
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.vespaDocId, input),
            isNull(collectionItems.deletedAt),
          ),
        )
      if (folder) {
        queue.push({ itemId: folder.id })
        folderIds.push(folder.id)
      }
    } else if (input.startsWith("clf-")) {
      const fileid = await trx
        .select({ id: collectionItems.id })
        .from(collectionItems)
        .where(
          and(
            eq(collectionItems.vespaDocId, input),
            isNull(collectionItems.deletedAt),
          ),
        )
      if (fileid.length) fileIds.push(fileid[0].id)
    } else {
      // Assume it's a DB item id (UUID)
      queue.push({ itemId: input })
    }
  }

  // BFS: collect all file item ids under the given seeds
  while (queue.length > 0) {
    const { itemId } = queue.shift()!
    const children = await trx
      .select()
      .from(collectionItems)
      .where(
        and(
          eq(collectionItems.parentId, itemId),
          isNull(collectionItems.deletedAt),
        ),
      )
    if (children.length === 0) {
      // If no children: either this is a file leaf or an invalid id; only push if it's a file
      const node = await getCollectionItemById(trx, itemId)
      if (node && node.type === "file") fileIds.push(itemId)
      continue
    }
    for (const child of children) {
      if (child.type === "folder") {
        folderIds.push(child.id)
        queue.push({ itemId: child.id })
      } else if (child.type === "file") {
        fileIds.push(child.id)
      }
    }
  }
  return { fileIds, folderIds }
}

// Keep the old function for backward compatibility
export const getAllFolderItems = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const res = []
  let queue = [...parentIds]
  while (queue.length > 0) {
    const curr = queue.shift()!

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

// Get all folder IDs recursively (not files) - for parentId queries
export const getAllFolderIds = async (
  parentIds: string[],
  trx: TxnOrClient,
) => {
  const res = []
  let queue = [...parentIds]
  while (queue.length > 0) {
    const curr = queue.shift()!

    const resp = await getParentItems(curr, trx)
    for (const item of resp) {
      if (item.type == "folder") {
        res.push(item.id)
        queue.push(item.id)
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
        isNull(collectionItems.deletedAt),
      ),
    )

  return resp
}

// Get collection items status for polling - with access control
export const getCollectionItemsStatusByCollections = async (
  trx: TxnOrClient,
  collectionIds: string[],
  userId: number,
) => {
  if (collectionIds.length === 0) {
    return []
  }

  // Fetch items only for collections owned by the user
  const items = await trx
    .select({
      id: collectionItems.id,
      uploadStatus: collectionItems.uploadStatus,
      statusMessage: collectionItems.statusMessage,
      retryCount: collectionItems.retryCount,
      collectionId: collectionItems.collectionId,
    })
    .from(collectionItems)
    .innerJoin(collections, eq(collectionItems.collectionId, collections.id))
    .where(
      and(
        inArray(collectionItems.collectionId, collectionIds),
        eq(collections.ownerId, userId),
        isNull(collectionItems.deletedAt),
        isNull(collections.deletedAt),
      ),
    )

  return items
}

export const getCollectionFoldersItemIds = async (
  collectionFoldersIds: string[],
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
        inArray(collectionItems.id, collectionFoldersIds),
        eq(collectionItems.type, "folder"),
        isNull(collectionItems.deletedAt),
      ),
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
        isNull(collectionItems.deletedAt),
      ),
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

// Helper function to mark parent (folder/collection) as PROCESSING when new items are added
export const markParentAsProcessing = async (
  trx: TxnOrClient,
  parentId: string | null,
  isCollection: boolean,
) => {
  if (!parentId) return

  const updateData = {
    uploadStatus: UploadStatus.PROCESSING,
    updatedAt: sql`NOW()`,
  }

  if (isCollection) {
    // Update collection status
    await trx
      .update(collections)
      .set(updateData)
      .where(eq(collections.id, parentId))
  } else {
    // Update folder status
    await trx
      .update(collectionItems)
      .set(updateData)
      .where(eq(collectionItems.id, parentId))

    // Recursively mark parent's parent as processing
    const [folder] = await trx
      .select({
        parentId: collectionItems.parentId,
        collectionId: collectionItems.collectionId,
      })
      .from(collectionItems)
      .where(eq(collectionItems.id, parentId))

    if (folder) {
      // Recursively mark parent (either another folder or the collection)
      await markParentAsProcessing(
        trx,
        folder.parentId || folder.collectionId,
        !folder.parentId, // isCollection = true if no parentId
      )
    }
  }
}

// Helper function to update parent (collection/folder) status based on children completion
export const updateParentStatus = async (
  trx: TxnOrClient,
  parentId: string | null,
  isCollection: boolean,
) => {
  if (!parentId) return

  // Fetch children based on parent type
  const children = await trx
    .select({ uploadStatus: collectionItems.uploadStatus })
    .from(collectionItems)
    .where(
      and(
        isCollection
          ? eq(collectionItems.collectionId, parentId)
          : eq(collectionItems.parentId, parentId),
        isCollection ? isNull(collectionItems.parentId) : sql`true`,
        isNull(collectionItems.deletedAt),
      ),
    )

  // Determine parent type name for logging
  const parentType = isCollection ? "collection" : "folder"

  // Handle case where parent has no children
  if (children.length === 0) {
    const updateData = {
      uploadStatus: UploadStatus.COMPLETED,
      statusMessage: `Successfully processed ${parentType}`,
      updatedAt: sql`NOW()`,
    }

    if (isCollection) {
      await trx.update(collections).set(updateData).where(eq(collections.id, parentId))
    } else {
      await trx.update(collectionItems).set(updateData).where(eq(collectionItems.id, parentId))
    }
    return
  }

  // Count completed and failed children
  const completedCount = children.filter(
    (c) => c.uploadStatus === UploadStatus.COMPLETED,
  ).length
  const failedCount = children.filter(
    (c) => c.uploadStatus === UploadStatus.FAILED,
  ).length

  // Update if all children are either completed or failed
  if (completedCount + failedCount === children.length) {
    const updateData = {
      uploadStatus: UploadStatus.COMPLETED,
      statusMessage: `Successfully processed ${parentType}: ${completedCount} completed, ${failedCount} failed`,
      updatedAt: sql`NOW()`,
    }

    if (isCollection) {
      await trx.update(collections).set(updateData).where(eq(collections.id, parentId))
    } else {
      await trx.update(collectionItems).set(updateData).where(eq(collectionItems.id, parentId))

      // For folders, recursively check the parent folder/collection
      const [folder] = await trx
        .select({
          parentId: collectionItems.parentId,
          collectionId: collectionItems.collectionId,
        })
        .from(collectionItems)
        .where(eq(collectionItems.id, parentId))

      if (folder) {
        // Recursively update parent (either another folder or the collection)
        await updateParentStatus(
          trx,
          folder.parentId || folder.collectionId,
          !folder.parentId, // isCollection = true if no parentId
        )
      }
    }
  }
}

export const getRecordBypath = async (
  path: string,
  trx: TxnOrClient,
  ownerEmail: string,
) => {
  let collectionName: string
  let directoryPath: string
  let currItem: string
  let user = await getUserByEmail(trx, ownerEmail)
  if (!user[0]) {
    throw new Error("Invalid User")
  }
  // Remove leading slash if present
  const cleanPath = path.startsWith("/") ? path.substring(1) : path
  const segments = cleanPath.split("/")

  if (segments.length === 0) {
    throw new Error("Invalid path")
  }

  if (segments.length === 1) {
    // Only collection name
    collectionName = segments[0]
    directoryPath = "/"
    currItem = ""
  } else if (segments.length === 2) {
    // Collection and item (no intermediate directories)
    collectionName = segments[0]
    directoryPath = "/"
    currItem = segments[1]
  } else {
    // Collection, directories, and item
    collectionName = segments[0]
    // Everything between collection and last segment becomes the directory path
    const middleSegments = segments.slice(1, -1)
    directoryPath = "/" + middleSegments.join("/") + "/"
    currItem = segments[segments.length - 1]
  }

  // First, get the collection by name to get its ID
  const [collection] = await trx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.name, collectionName),
        eq(collections.ownerId, user[0].id),
        isNull(collections.deletedAt),
      ),
    )

  if (!collection) {
    return null // Collection not found
  }

  const whereConditions = [
    eq(collectionItems.collectionId, collection.id),
    eq(collectionItems.path, directoryPath),
    isNull(collectionItems.deletedAt),
  ]

  if (currItem !== "") {
    whereConditions.push(eq(collectionItems.name, currItem))
  }

  let result = await trx
    .select({ docId: collectionItems.vespaDocId })
    .from(collectionItems)
    .where(and(...whereConditions))

  return result.length > 0 ? result[0].docId : null
}
