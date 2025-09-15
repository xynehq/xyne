import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  Apps,
  DriveEntity,
  fileSchema,
  type VespaQueryConfig,
} from "@xyne/vespa-ts/types"
import { getFolderItems } from "./vespa"
import { db } from "@/db/connector"
import {
  getAllFolderItems,
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
): Promise<string[]> {
  const collectionIds: string[] = []
  const collectionFolderIds: string[] = []
  const collectionFileIds: string[] = []

  if (options.collectionSelections) {
    for (const selection of options.collectionSelections) {
      if (selection.collectionIds) {
        collectionIds.push(...selection.collectionIds)
      }
      if (selection.collectionFolderIds) {
        collectionFolderIds.push(...selection.collectionFolderIds)
      }
      if (selection.collectionFileIds) {
        collectionFileIds.push(...selection.collectionFileIds)
      }
    }
  }

  let clVespaIds: string[] = []
  // Handle specific folders - need to get file IDs (less efficient but necessary)
  if (collectionFolderIds.length > 0) {
    const clFileIds = await getAllFolderItems(collectionFolderIds, db)
    if (clFileIds.length > 0) {
      const ids = await getCollectionFilesVespaIds(clFileIds, db)
      const clIds = ids
        .filter((item: any) => item.vespaDocId !== null)
        .map((item: any) => item.vespaDocId!)
      clVespaIds.push(...clIds)
    }
  }

  // Handle specific files - use file IDs directly (most efficient for individual files)
  if (collectionFileIds.length > 0) {
    const ids = await getCollectionFilesVespaIds(collectionFileIds, db)
    const clfIds = ids
      .filter((item: any) => item.vespaDocId !== null)
      .map((item: any) => item.vespaDocId!)
    clVespaIds.push(...clfIds)
  }

  return clVespaIds
}
