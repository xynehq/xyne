import {
  kbItems,
  kbFiles,
  type KnowledgeBase,
  type KbItem,
  type NewKbItem,
  type KbFile,
  type NewKbFile,
} from "@/db/schema"

// For the unified schema, KnowledgeBase is a KbItem with type "knowledge_base"
type NewKnowledgeBase = Omit<
  NewKbItem,
  "type" | "parentId" | "path" | "position" | "totalCount"
> & {
  type?: "knowledge_base"
  parentId?: null
  path?: string
  position?: number
  totalCount?: number
}
import { createId } from "@paralleldrive/cuid2"
import type { TxnOrClient } from "@/types"
import { and, asc, desc, eq, isNull, sql, or } from "drizzle-orm"

// Knowledge Base CRUD operations
export const createKnowledgeBase = async (
  trx: TxnOrClient,
  kb: NewKnowledgeBase,
): Promise<KnowledgeBase> => {
  const kbData: NewKbItem = {
    ...kb,
    type: "knowledge_base",
    parentId: null,
    path: "/",
    position: 0,
    totalCount: 0,
  }

  const [result] = await trx.insert(kbItems).values(kbData).returning()
  if (!result) {
    throw new Error("Failed to create knowledge base")
  }
  return result as KnowledgeBase
}

export const getKnowledgeBaseById = async (
  trx: TxnOrClient,
  kbId: string,
): Promise<KnowledgeBase | null> => {
  const [result] = await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.id, kbId), eq(kbItems.type, "knowledge_base")))
  return (result as KnowledgeBase) || null
}

export const getKnowledgeBasesByOwner = async (
  trx: TxnOrClient,
  ownerId: number,
): Promise<KnowledgeBase[]> => {
  const results = await trx
    .select()
    .from(kbItems)
    .where(
      and(
        eq(kbItems.ownerId, ownerId),
        eq(kbItems.type, "knowledge_base"),
        isNull(kbItems.parentId),
        isNull(kbItems.deletedAt),
      ),
    )
    .orderBy(desc(kbItems.updatedAt))
  return results as KnowledgeBase[]
}

// list item by the level
// need to do the level order traversal will always have the parentId
// based on that we will go down
export const getParentItems = async (
  parentId: string,
  trx: TxnOrClient,
): Promise<KbItem[]> => {
  // since I have the id of parent
  const results = await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.parentId, parentId), isNull(kbItems.deletedAt)))
  return results
}

export const getAllFolderItems = async (parentId: string, trx: TxnOrClient) => {
  const res = []
  let queue: any[] = []
  queue.push(parentId)
  while (queue.length > 0) {
    const curr = queue.shift()
    const resp = await getParentItems(curr, trx)
    for (const a of resp) {
      if (a.type == "folder" || a.type == "knowledge_base") {
        queue.push(a.id)
      } else if (a.type == "file") {
        res.push(a.id)
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
    .select()
    .from(kbFiles)
    .where(
      sql`${kbFiles.id} IN (${sql.join(
        KbFilesId.map((id) => sql`${id}`),
        sql`, `,
      )})`,
    )

  return resp
}

export const getAccessibleKnowledgeBases = async (
  trx: TxnOrClient,
  userId: number,
): Promise<KnowledgeBase[]> => {
  // Get user's own KBs and all public KBs
  const results = await trx
    .select()
    .from(kbItems)
    .where(
      and(
        eq(kbItems.type, "knowledge_base"),
        isNull(kbItems.parentId),
        isNull(kbItems.deletedAt),
        or(eq(kbItems.ownerId, userId), eq(kbItems.isPrivate, false)),
      ),
    )
    .orderBy(desc(kbItems.updatedAt))
  return results as KnowledgeBase[]
}

export const updateKnowledgeBase = async (
  trx: TxnOrClient,
  kbId: string,
  updates: Partial<NewKnowledgeBase>,
): Promise<KnowledgeBase> => {
  const [result] = await trx
    .update(kbItems)
    .set({
      ...updates,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(kbItems.id, kbId), eq(kbItems.type, "knowledge_base")))
    .returning()
  if (!result) {
    throw new Error("Knowledge base not found")
  }
  return result as KnowledgeBase
}

export const softDeleteKnowledgeBase = async (
  trx: TxnOrClient,
  kbId: string,
): Promise<KnowledgeBase> => {
  const [result] = await trx
    .update(kbItems)
    .set({
      deletedAt: sql`NOW()`,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(kbItems.id, kbId), eq(kbItems.type, "knowledge_base")))
    .returning()
  if (!result) {
    throw new Error("Knowledge base not found")
  }
  return result as KnowledgeBase
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
    .where(eq(kbItems.id, itemId))
  return result || null
}

export const getKbItemsByParent = async (
  trx: TxnOrClient,
  kbId: string,
  parentId: string | null,
): Promise<KbItem[]> => {
  // For unified schema, if parentId is null, we want items directly under the KB
  const actualParentId = parentId || kbId

  return await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.parentId, actualParentId), isNull(kbItems.deletedAt)))
    .orderBy(desc(kbItems.type), asc(kbItems.position), asc(kbItems.name))
}

export const getKbItemByPath = async (
  trx: TxnOrClient,
  kbId: string,
  path: string,
  name: string,
): Promise<KbItem | null> => {
  // For unified schema, we need to check items under the KB hierarchy
  const kb = await getKnowledgeBaseById(trx, kbId)
  if (!kb) return null

  const [result] = await trx
    .select()
    .from(kbItems)
    .where(
      and(
        eq(kbItems.path, path),
        eq(kbItems.name, name),
        isNull(kbItems.deletedAt),
      ),
    )

  // Verify the item belongs to the correct KB by checking the hierarchy
  if (result) {
    let currentItem = result
    while (currentItem.parentId) {
      if (currentItem.parentId === kbId) return result
      const parent = await getKbItemById(trx, currentItem.parentId)
      if (!parent) return null
      currentItem = parent
    }
  }

  return null
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
  // Get the item first to know its parent
  const item = await getKbItemById(trx, itemId)
  if (!item) {
    throw new Error("KB item not found")
  }

  // If it's a folder, recursively delete all items inside it
  if (item.type === "folder") {
    // Recursively get all descendants and mark them as deleted
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

    // Update parent folder counts
    await updateFolderCounts(trx, item.parentId, -(descendantCount + 1))
  } else {
    // For files, just mark as deleted
    await trx
      .update(kbItems)
      .set({
        deletedAt: sql`NOW()`,
        updatedAt: sql`NOW()`,
      })
      .where(eq(kbItems.id, itemId))

    // Update parent folder counts
    await updateFolderCounts(trx, item.parentId, -1)
  }

  // Return the updated item
  const [result] = await trx
    .select()
    .from(kbItems)
    .where(eq(kbItems.id, itemId))

  return result
}

// KB Files operations
export const createKbFile = async (
  trx: TxnOrClient,
  file: NewKbFile,
): Promise<KbFile> => {
  const [result] = await trx.insert(kbFiles).values(file).returning()
  if (!result) {
    throw new Error("Failed to create KB file")
  }
  return result
}

export const getKbFileByItemId = async (
  trx: TxnOrClient,
  itemId: string,
): Promise<KbFile | null> => {
  const [result] = await trx
    .select()
    .from(kbFiles)
    .where(eq(kbFiles.itemId, itemId))
  return result || null
}

export const updateKbFile = async (
  trx: TxnOrClient,
  fileId: string,
  updates: Partial<NewKbFile>,
): Promise<KbFile> => {
  const [result] = await trx
    .update(kbFiles)
    .set(updates)
    .where(eq(kbFiles.id, fileId))
    .returning()
  if (!result) {
    throw new Error("KB file not found")
  }
  return result
}

export const softDeleteKbFile = async (
  trx: TxnOrClient,
  fileId: string,
): Promise<KbFile> => {
  const [result] = await trx
    .update(kbFiles)
    .set({
      deletedAt: sql`NOW()`,
    })
    .where(eq(kbFiles.id, fileId))
    .returning()
  if (!result) {
    throw new Error("KB file not found")
  }
  return result
}

// Helper function to update folder counts recursively
export const updateFolderCounts = async (
  trx: TxnOrClient,
  parentId: string | null,
  delta: number,
): Promise<void> => {
  if (!parentId) return

  // Update the parent folder
  await trx
    .update(kbItems)
    .set({
      totalCount: sql`${kbItems.totalCount} + ${delta}`,
      updatedAt: sql`NOW()`,
    })
    .where(eq(kbItems.id, parentId))

  // Get the parent to continue up the tree
  const parent = await getKbItemById(trx, parentId)
  if (parent && parent.parentId) {
    await updateFolderCounts(trx, parent.parentId, delta)
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

  // For unified schema, parentId should be the KB id if creating at root level
  const actualParentId = parentId || kbId

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

  const folder = await createKbItem(trx, {
    parentId: actualParentId,
    workspaceId: kb.workspaceId,
    ownerId: kb.ownerId,
    name,
    type: "folder",
    path,
    position: nextPosition,
    totalCount: 0,
    isPrivate: true,
    lastUpdatedById: userId,
    lastUpdatedByEmail: userEmail,
    metadata,
  })

  // Update parent folder count
  await updateFolderCounts(trx, actualParentId, 1)

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
): Promise<{ item: KbItem; file: KbFile }> => {
  // Get the KB to ensure it exists and get workspace info
  const kb = await getKnowledgeBaseById(trx, kbId)
  if (!kb) {
    throw new Error("Knowledge base not found")
  }

  // For unified schema, parentId should be the KB id if creating at root level
  const actualParentId = parentId || kbId

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

  // Create item
  const item = await createKbItem(trx, {
    parentId: actualParentId,
    workspaceId: kb.workspaceId,
    ownerId: kb.ownerId,
    name,
    type: "file",
    path,
    position: nextPosition,
    isPrivate: true,
    lastUpdatedById: userId,
    lastUpdatedByEmail: userEmail,
    metadata,
  })

  // Create file record
  const file = await createKbFile(trx, {
    itemId: item.id,
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
  })

  // Update parent folder count
  await updateFolderCounts(trx, actualParentId, 1)

  return { item, file }
}

// Get all items in a KB recursively
export const getAllKbItems = async (
  trx: TxnOrClient,
  kbId: string,
): Promise<KbItem[]> => {
  // Recursive function to get all descendants
  const getAllDescendants = async (parentIds: string[]): Promise<KbItem[]> => {
    if (parentIds.length === 0) return []

    const children = await trx
      .select()
      .from(kbItems)
      .where(
        and(
          sql`${kbItems.parentId} IN (${sql.join(
            parentIds.map((id) => sql`${id}`),
            sql`, `,
          )})`,
          isNull(kbItems.deletedAt),
        ),
      )
      .orderBy(desc(kbItems.type), asc(kbItems.position), asc(kbItems.name))

    if (children.length === 0) return []

    const childIds = children.map((child) => child.id)
    const grandchildren = await getAllDescendants(childIds)

    return [...children, ...grandchildren]
  }

  // Start with items directly under the KB
  const rootItems = await trx
    .select()
    .from(kbItems)
    .where(and(eq(kbItems.parentId, kbId), isNull(kbItems.deletedAt)))
    .orderBy(desc(kbItems.type), asc(kbItems.position), asc(kbItems.name))

  if (rootItems.length === 0) return []

  const rootIds = rootItems.map((item) => item.id)
  const descendants = await getAllDescendants(rootIds)

  return [...rootItems, ...descendants]
}

// Generate unique storage key
export const generateStorageKey = (): string => {
  return createId()
}

// Generate Vespa document ID for KB files
export const generateVespaDocId = (): string => {
  return `kbf-${createId()}`
}
