import React from "react"
import { ChevronRight } from "lucide-react"
import { Apps, DriveEntity } from "shared/types"
import { getIcon } from "@/lib/common"
import { api } from "@/api"


function isItemSelectedWithInheritance(
  itemId: string,
  selectedItemsInGoogleDrive: Set<string>,
  selectedItemDetailsInGoogleDrive: Record<string, any>,
  navigationPath: Array<{
    id: string
    name: string
    type: "cl-root" | "cl" | "folder" | "drive-root" | "drive-folder"
  }>,
): boolean {
  
  // Check if item is directly selected
  if (selectedItemsInGoogleDrive.has(itemId)) {
    return true
  }

  // Check if any parent folder in the current navigation path is selected
  const parentFolders = navigationPath
    .filter((pathItem) => pathItem.type === "drive-folder")
    .map((pathItem) => pathItem.id)

  // Check if any parent folder is selected
  for (const parentFolderId of parentFolders) {
    // Find the parent folder in selected items
    for (const selectedItemId of selectedItemsInGoogleDrive) {
      const selectedItemDetail =
        selectedItemDetailsInGoogleDrive[selectedItemId]
      if (selectedItemDetail) {
        const selectedDocId =
          selectedItemDetail.fields?.docId || selectedItemDetail.docId
        if (selectedDocId === parentFolderId) {
          // This item is inside a selected folder
          return true
        }
      }
    }
  }

  return false
}



interface GoogleDriveNavigationProps {
  navigationPath: Array<{
    id: string
    name: string
    type: "cl-root" | "cl" | "folder" | "drive-root" | "drive-folder"
  }>
  setNavigationPath: React.Dispatch<
    React.SetStateAction<
      Array<{
        id: string
        name: string
        type: "cl-root" | "cl" | "folder" | "drive-root" | "drive-folder"
      }>
    >
  >
  currentItems: any[]
  setCurrentItems: React.Dispatch<React.SetStateAction<any[]>>
  isLoadingItems: boolean
  setIsLoadingItems: React.Dispatch<React.SetStateAction<boolean>>
  dropdownSearchQuery: string
  setDropdownSearchQuery: React.Dispatch<React.SetStateAction<string>>
  searchResults: any[]
  isSearching: boolean
  selectedItemsInGoogleDrive: Set<string>
  setSelectedItemsInGoogleDrive: React.Dispatch<
    React.SetStateAction<Set<string>>
  >
  selectedItemDetailsInGoogleDrive: Record<string, any>
  setSelectedItemDetailsInGoogleDrive: React.Dispatch<
    React.SetStateAction<Record<string, any>>
  >
  setSelectedIntegrations: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >
}

export const GoogleDriveNavigation: React.FC<GoogleDriveNavigationProps> = ({
  navigationPath,
  setNavigationPath,
  currentItems,
  setCurrentItems,
  isLoadingItems,
  setIsLoadingItems,
  dropdownSearchQuery,
  setDropdownSearchQuery,
  searchResults,
  isSearching,
  selectedItemsInGoogleDrive,
  setSelectedItemsInGoogleDrive,
  selectedItemDetailsInGoogleDrive,
  setSelectedItemDetailsInGoogleDrive,
  setSelectedIntegrations,
}) => {
  // Function to get icon for Google Drive entity
  const getDriveEntityIcon = (entity: string) => {
    return getIcon(Apps.GoogleDrive, entity as any, { w: 16, h: 16, mr: 8 })
  }

  const navigateToDriveFolder = async (
    folderId: string,
    folderName: string,
  ) => {
    setNavigationPath((prev) => [
      ...prev,
      { id: folderId, name: folderName, type: "drive-folder" },
    ])
    setIsLoadingItems(true)
    try {
      const response = await api.search.driveitem.$post({
        json: { parentId: folderId },
      })
      if (response.ok) {
        const data = await response.json()
        // Extract the actual items from the Vespa response structure
        const items = data?.root?.children || []
        setCurrentItems(items)
      }
    } catch (error) {
      console.error("Failed to fetch Google Drive folder items:", error)
    } finally {
      setIsLoadingItems(false)
    }
  }
  

  // Helper function for Google Drive item selection
  function handleGoogleDriveItemSelection(
    itemId: string,
    itemDetail: any,
    selectedItemsInGoogleDrive: Set<string>,
    setSelectedItemsInGoogleDrive: React.Dispatch<
      React.SetStateAction<Set<string>>
    >,
    setSelectedItemDetailsInGoogleDrive: React.Dispatch<
      React.SetStateAction<Record<string, any>>
    >,
    setSelectedIntegrations: React.Dispatch<
      React.SetStateAction<Record<string, boolean>>
    >,
  ) {
    const isCurrentlySelected = selectedItemsInGoogleDrive.has(itemId)

    setSelectedItemsInGoogleDrive((prev) => {
      const newSet = new Set(prev)
      if (isCurrentlySelected) {
        newSet.delete(itemId)
      } else {
        newSet.add(itemId)
      }
      return newSet
    })

    setSelectedItemDetailsInGoogleDrive((prev) => {
      const newState = { ...prev }
      if (isCurrentlySelected) {
        delete newState[itemId]
      } else {
        newState[itemId] = itemDetail
      }
      return newState
    })

    setSelectedIntegrations((prev) => {
      // Compute the new size based on the current operation to avoid race condition
      const currentSize = selectedItemsInGoogleDrive.size
      const newSize = isCurrentlySelected ? currentSize - 1 : currentSize + 1

      return {
        ...prev,
        googledrive: newSize > 0,
      }
    })
  }

  const isShowingDriveContents =
    navigationPath.length > 0 &&
    (navigationPath[0].type === "drive-root" ||
      navigationPath.some((item) => item.type === "drive-folder"))

  if (!isShowingDriveContents) {
    return null
  }

  return (
    <>
      {/* Content area */}
      <div className="max-h-60 overflow-y-auto">
        {dropdownSearchQuery.trim() ? (
          // Show search results
          <>
            {isSearching ? (
              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                Searching...
              </div>
            ) : searchResults.length > 0 ? (
              searchResults.map((result: any) => {
               
                const itemId = result.docId
                const itemEntity = result.entity
                const itemTitle = result.title || result.name || "Untitled"
                const isFolder = itemEntity === DriveEntity.Folder
                  const isDirectlySelected =
                  selectedItemsInGoogleDrive.has(itemId)
                const isInheritedFromParent = isItemSelectedWithInheritance(
                  itemId,
                  selectedItemsInGoogleDrive,
                  selectedItemDetailsInGoogleDrive,
                  navigationPath,
                )
                const finalIsSelected =
                  isDirectlySelected || isInheritedFromParent
                const isDisabled = isInheritedFromParent && !isDirectlySelected

                const handleFolderNavigation = () => {
                  if (isFolder && result?.docId) {
                    // Clear search query and results when navigating
                    setDropdownSearchQuery("")
                    navigateToDriveFolder(result?.docId, itemTitle)
                  }
                }

                return (
                  <div
                    key={itemId}
                    className="flex items-center px-4 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      checked={finalIsSelected}
                      disabled={isDisabled}
                      onChange={(e) => {
                        e.stopPropagation()
                        handleGoogleDriveItemSelection(
                          itemId,
                          // Normalize the data structure for search results
                          {
                            ...result,
                            fields: {
                              docId: result.docId || itemId,
                              title: result.title || result.name || itemTitle,
                              name: result.name || result.title || itemTitle,
                              entity: result.entity || itemEntity,
                            },
                          },
                          selectedItemsInGoogleDrive,
                          setSelectedItemsInGoogleDrive,
                          setSelectedItemDetailsInGoogleDrive,
                          setSelectedIntegrations,
                        )
                      }}
                      className="mr-3 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                    />
                    {getDriveEntityIcon(itemEntity)}
                    <span
                      className={`text-gray-700 dark:text-gray-200 truncate flex-1 ${
                        isFolder
                          ? "cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
                          : ""
                      }`}
                      onClick={handleFolderNavigation}
                    >
                      {itemTitle}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                      {isFolder ? "folder" : itemEntity || "file"}
                    </span>
                  </div>
                )
              })
            ) : (
              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                No results found for "{dropdownSearchQuery}"
              </div>
            )}
          </>
        ) : (
          // Show Google Drive contents (files/folders)
          <>
            {isLoadingItems ? (
              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                Loading...
              </div>
            ) : currentItems.length > 0 ? (
              currentItems.map((item: any) => {
           
                const itemId = item.id || item.fields?.docId
                const itemDocId = item.fields?.docId
                const itemEntity = item.fields?.entity
                const itemTitle =
                  item.fields?.title || item.fields?.name || "Untitled"
                const isFolder = itemEntity === DriveEntity.Folder

                // Check if this item is inherited from a selected parent folder
                const isDirectlySelected =
                  selectedItemsInGoogleDrive.has(itemDocId || itemId)
                const isInheritedFromParent = isItemSelectedWithInheritance(
                  itemDocId || itemId,
                  selectedItemsInGoogleDrive,
                  selectedItemDetailsInGoogleDrive,
                  navigationPath,
                )
                const finalIsSelected =
                  isDirectlySelected || isInheritedFromParent
                const isDisabled = isInheritedFromParent && !isDirectlySelected

                return (
                  <div
                    key={itemId}
                    className="flex items-center px-4 py-2 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                    onClick={() => {
                      if (isFolder && itemDocId) {
                        navigateToDriveFolder(itemDocId, itemTitle)
                      }
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={finalIsSelected}
                      disabled={isDisabled}
                      onChange={(e) => {
                        e.stopPropagation()
                        if (isDisabled) return // Prevent changes if inherited from parent

                        handleGoogleDriveItemSelection(
                          itemDocId || itemId,
                          item,
                          selectedItemsInGoogleDrive,
                          setSelectedItemsInGoogleDrive,
                          setSelectedItemDetailsInGoogleDrive,
                          setSelectedIntegrations,
                        )
                      }}
                      className={`w-4 h-4 mr-3 ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="mr-2 flex items-center">
                      {getDriveEntityIcon(itemEntity)}
                    </span>
                    <span className="text-gray-700 dark:text-gray-200 truncate flex-1">
                      {itemTitle}
                    </span>
                    {isFolder && (
                      <ChevronRight className="h-4 w-4 text-gray-400 ml-2" />
                    )}
                  </div>
                )
              })
            ) : (
              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                No items found
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
