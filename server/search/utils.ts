import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  Apps,
  DriveEntity,
  fileSchema,
  type VespaQueryConfig,
  type CollectionVespaIds,
} from "@xyne/vespa-ts/types"
import { getFolderItems } from "./vespa"
import { db } from "@/db/connector"
import {
  getAllFolderItems,
  getAllFolderIds,
  getCollectionFilesVespaIds,
} from "@/db/knowledgeBase"

const Logger = getLogger(Subsystem.Vespa).child({ module: "search-utils" })

export async function extractDriveIds(
  options: Partial<VespaQueryConfig>,
  email: string,
): Promise<string[]> {
  let driveItem: string[] = []
  if ((options.selectedItem as any)[Apps.GoogleDrive]) {
    driveItem = [...(options.selectedItem as any)[Apps.GoogleDrive]]
  }
  const driveIds = []
  while (driveItem.length) {
    let curr = driveItem.shift()
    // Ensure email is defined before passing it to getFolderItems\
    if (curr) driveIds.push(curr)
    if (curr && email) {
      try {
        const folderItem = await getFolderItems(
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
