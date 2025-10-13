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
import type { SelectAgent } from "@/db/agent"
import { sharedVespaService } from "./vespaService"

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

export async function getVespaIdsFromPrefixedItemIds(
  prefixedItemIds: string[],
): Promise<string[]> {
  try {
    // Remove prefixes from itemIds
    const cleanedItemIds = removePrefixesFromItemIds(prefixedItemIds)
    // Get their corresponding vespaIds
    const ids = await getCollectionFoldersItemIds(cleanedItemIds, db)
    // get all their children db Ids
    const { fileIds, folderIds } = await getAllCollectionAndFolderItems(
      ids
        .map((doc) => doc.vespaDocId)
        .filter((id): id is string => id !== null),
      db,
    )

    // Get vespaIds for all file items
    const fileVespaIds = await getCollectionFilesVespaIds(fileIds, db)
    const allVespaIds = fileVespaIds
      .map((item: any) => item.vespaDocId)
      .filter(Boolean)

    // Also get vespaIds for folder items
    if (folderIds.length > 0) {
      const folderVespaIds = await getCollectionFoldersItemIds(folderIds, db)
      const folderVespaDocIds = folderVespaIds
        .map((item: any) => item.vespaDocId)
        .filter(Boolean)
      allVespaIds.push(...folderVespaDocIds)
    }
    return allVespaIds
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
