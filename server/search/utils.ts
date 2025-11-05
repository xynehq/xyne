import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  Apps,
  DriveEntity,
  fileSchema,
  type VespaQueryConfig,
  type CollectionVespaIds,
} from "@xyne/vespa-ts/types"
import { db } from "@/db/connector"
import {
  getAllFolderItems,
  getAllFolderIds,
  getCollectionFilesVespaIds,
  getAllCollectionAndFolderItems,
  getCollectionFoldersItemIds,
} from "@/db/knowledgeBase"
import { collections } from "@/db/schema"
import type { SelectAgent } from "@/db/agent"
import { sharedVespaService } from "./vespaService"
import { and, inArray, isNull } from "drizzle-orm"

const Logger = getLogger(Subsystem.Vespa).child({ module: "search-utils" })

export function expandSheetIds(fileId: string): string[] {
  // Check if the fileId matches the pattern docId_sheet_number
  const sheetMatch = fileId.match(/^(.+)_sheet_(\d+)$/)

  if (!sheetMatch) {
    // Not a sheet ID, return as is
    return [fileId]
  }

  const [, docId, sheetNumberStr] = sheetMatch
  const sheetNumber = parseInt(sheetNumberStr, 10)
  // Generate IDs from docId_sheet_0 to docId_sheet_number
  const expandedIds: string[] = []
  const upper = Number.isFinite(sheetNumber) ? sheetNumber : 1
  for (let i = 0; i < upper; i++) {
    expandedIds.push(`${docId}_sheet_${i}`)
  }

  return expandedIds
}

export function replaceSheetIndex(
  vespaDocId: string,
  newSheetIndex: number,
): string {
  // Check if the vespaDocId matches the pattern docId_sheet_number
  const sheetMatch = vespaDocId.match(/^(.+)_sheet_(\d+)$/)

  if (!sheetMatch) {
    // Not a sheet ID, return as is
    return vespaDocId
  }

  const [, docId] = sheetMatch
  return `${docId}_sheet_${newSheetIndex}`
}

export function removePrefixesFromItemIds(itemIds: string[]): string[] {
  return itemIds.map((itemId) => {
    // Remove prefixes: clfd-, clf-, cl-
    if (itemId.startsWith("clfd-")) {
      return itemId.substring(5) // Remove 'clfd-'
    } else if (itemId.startsWith("clf-")) {
      return itemId.substring(4) // Remove 'clf-'
    } else if (itemId.startsWith("cl-")) {
      return itemId.substring(3) // Remove 'cl-'
    }
    return itemId // Return as-is if no prefix matches
  })
}

export async function getCollectionVespaIds(
  collectionDbIds: string[],
): Promise<string[]> {
  try {
    if (collectionDbIds.length === 0) return []

    const result = await db
      .select({ vespaDocId: collections.vespaDocId })
      .from(collections)
      .where(
        and(
          inArray(collections.id, collectionDbIds),
          isNull(collections.deletedAt),
        ),
      )

    return result.map((item) => item.vespaDocId).filter(Boolean)
  } catch (error) {
    Logger.error("Error getting collection vespaIds:", error)
    return []
  }
}

export async function getVespaIdsFromPrefixedItemIds(
  prefixedItemIds: string[],
): Promise<string[]> {
  try {
    // Separate itemIds by type based on their prefixes
    const collectionIds: string[] = []
    const folderFileIds: string[] = []

    for (const itemId of prefixedItemIds) {
      if (itemId.startsWith("cl-")) {
        // Collection ID - remove 'cl-' prefix
        collectionIds.push(itemId.substring(3))
      } else if (itemId.startsWith("clfd-") || itemId.startsWith("clf-")) {
        // Folder or file ID - will be cleaned by removePrefixesFromItemIds
        folderFileIds.push(itemId)
      } else {
        Logger.error("Invalid collection item")
      }
    }

    const allVespaDocIds: string[] = []

    // Handle collection IDs
    if (collectionIds.length > 0) {
      const collectionVespaIds = await getCollectionVespaIds(collectionIds)
      allVespaDocIds.push(...collectionVespaIds)
    }

    // Handle folder/file IDs
    if (folderFileIds.length > 0) {
      const cleanedFolderFileIds = removePrefixesFromItemIds(folderFileIds)
      const ids = await getCollectionFoldersItemIds(cleanedFolderFileIds, db)
      const folderFileVespaIds = ids
        .map((doc) => doc.vespaDocId)
        .filter((id): id is string => id !== null)
      allVespaDocIds.push(...folderFileVespaIds)
    }

    // Get all their children db Ids using the combined vespa doc IDs
    const { fileIds, folderIds } = await getAllCollectionAndFolderItems(
      allVespaDocIds,
      db,
    )

    // Start with the original collection vespa doc IDs
    const finalVespaIds = [...allVespaDocIds]

    // Get vespaIds for all file items
    const fileVespaIds = await getCollectionFilesVespaIds(fileIds, db)
    const fileVespaDocIds = fileVespaIds
      .map((item: any) => item.vespaDocId)
      .filter(Boolean)
    finalVespaIds.push(...fileVespaDocIds)

    // Also get vespaIds for folder items
    if (folderIds.length > 0) {
      const folderVespaIds = await getCollectionFoldersItemIds(folderIds, db)
      const folderVespaDocIds = folderVespaIds
        .map((item: any) => item.vespaDocId)
        .filter(Boolean)
      finalVespaIds.push(...folderVespaDocIds)
    }
    return finalVespaIds
  } catch (error) {
    Logger.error("Error getting vespaIds from prefixed itemIds:", error)
    return []
  }
}

export async function extractDriveIds(
  options: Partial<VespaQueryConfig>,
  email: string,
): Promise<string[]> {
  let driveItem: string[] = []
  if (options.selectedItem && options.selectedItem[Apps.GoogleDrive]) {
    driveItem = [...options.selectedItem[Apps.GoogleDrive]]
  }
  const driveIds = []
  while (driveItem.length) {
    let curr = driveItem.shift()
    // Ensure email is defined before passing it to getFolderItems\
    if (curr) driveIds.push(curr)
    if (curr && email) {
      try {
        const folderItem = await sharedVespaService.getFolderItems(
          [curr],
          fileSchema,
          DriveEntity.Folder,
          email,
        )
        if (
          folderItem.root &&
          folderItem.root.children &&
          folderItem.root.children.length > 0
        ) {
          for (const item of folderItem.root.children) {
            if (
              item.fields &&
              (item.fields as any).entity === DriveEntity.Folder
            ) {
              driveItem.push((item.fields as any).docId)
            } else {
              driveIds.push((item.fields as any).docId)
            }
          }
        }
      } catch (error) {
        Logger.error("failed to fetch drive items")
      }
    }
  }
  return driveIds
}

export async function extractCollectionVespaIds(
  options: Partial<VespaQueryConfig>,
): Promise<CollectionVespaIds> {
  if (
    !options.collectionSelections ||
    options.collectionSelections.length === 0
  ) {
    return {}
  }

  const result: CollectionVespaIds = {}

  for (const selection of options.collectionSelections) {
    // Handle collections - merge with existing
    if (selection.collectionIds) {
      if (!result.collectionIds) result.collectionIds = []
      result.collectionIds.push(...selection.collectionIds)
    }

    // Handle folders - add original folders PLUS all their subfolders recursively
    if (
      selection.collectionFolderIds &&
      selection.collectionFolderIds.length > 0
    ) {
      const allFolderIds = [...selection.collectionFolderIds]
      const allSubFolderIds = await getAllFolderIds(
        selection.collectionFolderIds,
        db,
      )
      if (allSubFolderIds.length > 0) {
        allFolderIds.push(...allSubFolderIds)
      }

      if (!result.collectionFolderIds) result.collectionFolderIds = []
      result.collectionFolderIds.push(...allFolderIds)
    }

    // Handle files - convert database IDs to Vespa document IDs
    if (selection.collectionFileIds && selection.collectionFileIds.length > 0) {
      const ids = await getCollectionFilesVespaIds(
        selection.collectionFileIds,
        db,
      )
      const vespaDocIds = ids
        .filter((item: any) => item.vespaDocId !== null)
        .map((item: any) => item.vespaDocId!)
        .flatMap((i) => expandSheetIds(i))

      if (!result.collectionFileIds) result.collectionFileIds = []
      result.collectionFileIds.push(...vespaDocIds)
    }
  }

  return result
}

export async function validateVespaIdInAgentIntegrations(
  agentForDb: SelectAgent | null,
  vespaId: string,
): Promise<boolean> {
  if (!agentForDb || !agentForDb.appIntegrations) {
    return false
  }

  let itemIds: string[] = []

  if (Array.isArray(agentForDb.appIntegrations)) {
    itemIds = agentForDb.appIntegrations
  } else if (typeof agentForDb.appIntegrations === "object") {
    const knowledgeBaseConfig = agentForDb.appIntegrations["knowledge_base"]
    if (
      knowledgeBaseConfig &&
      typeof knowledgeBaseConfig === "object" &&
      "itemIds" in knowledgeBaseConfig
    ) {
      if (
        knowledgeBaseConfig.itemIds &&
        Array.isArray(knowledgeBaseConfig.itemIds)
      ) {
        itemIds = knowledgeBaseConfig.itemIds
      }
    }
  }

  if (itemIds.length === 0) {
    return false
  }

  try {
    const allVespaIds = await getVespaIdsFromPrefixedItemIds(itemIds)
    // Check if the target vespaId exists in the expanded list
    return allVespaIds.includes(vespaId)
  } catch (error) {
    Logger.error("Error during BFS validation:", error)
    return false
  }
}
