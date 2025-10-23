import React from "react"
import { ChevronRight, AlertOctagon } from "lucide-react"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { api } from "@/api"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

interface CollectionNavigationProps {
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
  selectedIntegrations: Record<string, boolean>
  setSelectedIntegrations: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >
  selectedItemsInCollection: Record<string, Set<string>>
  setSelectedItemsInCollection: React.Dispatch<
    React.SetStateAction<Record<string, Set<string>>>
  >
  selectedItemDetailsInCollection: Record<string, Record<string, any>>
  setSelectedItemDetailsInCollection: React.Dispatch<
    React.SetStateAction<Record<string, Record<string, any>>>
  >
  allAvailableIntegrations: Array<{
    id: string
    name: string
    app: string
    entity: string
    icon: React.ReactNode
  }>
  toggleIntegrationSelection: (integrationId: string) => void
  navigateToCl: (clId: string, clName: string) => Promise<void>
}

// Helper function to check if an item should be non-selectable based on upload status
function isItemNonSelectable(item: { uploadStatus?: string }): boolean {
  const uploadStatus = item.uploadStatus
  return uploadStatus === "pending" || uploadStatus === "processing" || uploadStatus === "failed"
}

// Reusable indexing tooltip component
const IndexingTooltip = () => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertOctagon className="w-4 h-4 ml-2 text-gray-500" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Indexing is in progress</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// Utility function to check if an item is selected either directly or through parent inheritance
function isItemSelectedWithInheritance(
  item: any,
  selectedItemsInCollection: Record<string, Set<string>>,
  selectedIntegrations: Record<string, boolean>,
  selectedItemDetailsInCollection: Record<string, Record<string, any>>,
): boolean {
  const collectionId = item.collectionId
  if (!collectionId) return false

  const selectedSet = selectedItemsInCollection[collectionId] || new Set()

  // Check if item is directly selected
  if (selectedSet.has(item.id)) {
    return true
  }

  // Check if collection is in selectAll mode
  const hasCollectionIntegrationSelected =
    !!selectedIntegrations[`cl_${collectionId}`]
  const isCollectionSelectAll =
    hasCollectionIntegrationSelected && selectedSet.size === 0
  if (isCollectionSelectAll) {
    return true
  }

  // Check if any parent folder is selected (inheritance)
  if (item.path && item.type !== "collection") {
    const itemDetails = selectedItemDetailsInCollection[collectionId] || {}

    // Check if any selected folder in this collection is a parent of this item
    for (const selectedId of selectedSet) {
      const selectedItemDetail = itemDetails[selectedId]
      if (selectedItemDetail && selectedItemDetail.type === "folder") {
        const folderPath = selectedItemDetail.path || ""
        const itemPath = item.path || ""

        // Normalize paths by removing leading/trailing slashes
        const normalizedFolderPath = folderPath.replace(/^\/+|\/+$/g, "")
        const normalizedItemPath = itemPath.replace(/^\/+|\/+$/g, "")

        // Check if this item's path starts with the selected folder's path
        if (
          normalizedItemPath.startsWith(normalizedFolderPath + "/") ||
          (normalizedFolderPath === "" && normalizedItemPath !== "") ||
          normalizedItemPath === normalizedFolderPath
        ) {
          return true
        }
      }
    }
  }

  return false
}

export const CollectionNavigation: React.FC<CollectionNavigationProps> = ({
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
  selectedIntegrations,
  setSelectedIntegrations,
  selectedItemsInCollection,
  setSelectedItemsInCollection,
  selectedItemDetailsInCollection,
  setSelectedItemDetailsInCollection,
  allAvailableIntegrations,
  toggleIntegrationSelection,
  navigateToCl,
}) => {
  const navigateToFolder = async (folderId: string, folderName: string) => {
    const clId = navigationPath.find((item) => item.type === "cl")?.id
    if (!clId) return

    setNavigationPath((prev) => [
      ...prev,
      {
        id: folderId,
        name: folderName,
        type: "folder",
      },
    ])
    setIsLoadingItems(true)
    try {
      const response = await api.cl[":clId"].items.$get({
        param: { clId },
        query: { parentId: folderId },
      })
      if (response.ok) {
        const data = await response.json()
        setCurrentItems(data)
      }
    } catch (error) {
      console.error("Failed to fetch folder items:", error)
    } finally {
      setIsLoadingItems(false)
    }
  }

  // Determine if we're showing Collection list or Collection contents
  const isShowingKbList =
    navigationPath.length === 1 && navigationPath[0].type === "cl-root"
  const isShowingKbContents =
    navigationPath.length > 1 ||
    (navigationPath.length === 1 && navigationPath[0].type === "cl")

  if (!isShowingKbList && !isShowingKbContents) {
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
                // Check if the item is directly selected vs inherited from parent
                const isDirectlySelected =
                  result.type === "collection"
                    ? selectedIntegrations[`cl_${result.id}`]
                    : selectedItemsInCollection[result.collectionId]?.has(
                        result.id,
                      )

                const isSelected =
                  result.type === "collection"
                    ? selectedIntegrations[`cl_${result.id}`]
                    : isItemSelectedWithInheritance(
                        result,
                        selectedItemsInCollection,
                        selectedIntegrations,
                        selectedItemDetailsInCollection,
                      )

                const isInherited = isSelected && !isDirectlySelected
                const isNonSelectable = isItemNonSelectable(result)

                const handleResultSelect = () => {
                  // Don't allow selection changes for inherited items
                  if (isInherited) return
                  
                  // For non-selectable items, prevent all interactions (no navigation or selection)
                  if (isNonSelectable) return

                  if (result.type === "collection") {
                    // Toggle collection selection
                    const integrationId = `cl_${result.id}`
                    toggleIntegrationSelection(integrationId)
                  } else if (
                    result.type === "folder" ||
                    result.type === "file"
                  ) {
                    // For folders and files, first make sure the collection is selected
                    const collectionIntegrationId = `cl_${result.collectionId}`

                    // Ensure collection is selected
                    if (!selectedIntegrations[collectionIntegrationId]) {
                      toggleIntegrationSelection(collectionIntegrationId)
                    }

                    // Then handle the specific item selection
                    const clId = result.collectionId
                    const itemId = result.id

                    setSelectedItemsInCollection((prev) => {
                      const currentSelection = prev[clId] || new Set()
                      const newSelection = new Set(currentSelection)

                      if (newSelection.has(itemId)) {
                        newSelection.delete(itemId)
                      } else {
                        newSelection.add(itemId)
                      }

                      return {
                        ...prev,
                        [clId]: newSelection,
                      }
                    })

                    setSelectedItemDetailsInCollection((prev) => {
                      const newDetails = { ...prev }
                      if (!newDetails[clId]) {
                        newDetails[clId] = {}
                      }
                      newDetails[clId][itemId] = {
                        id: itemId,
                        name: result.name,
                        type: result.type,
                        path: result.path,
                        collectionName: result.collectionName,
                      }
                      return newDetails
                    })
                  }

                  // Close search and clear query
                  setDropdownSearchQuery("")
                }

                return (
                  <div
                    key={result.id}
                    onClick={isInherited || isNonSelectable ? undefined : handleResultSelect}
                    className={`flex items-center px-4 py-2 text-sm ${
                      isInherited || isNonSelectable
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected || false}
                      disabled={isInherited || isNonSelectable}
                      onChange={() => {}}
                      className={`w-4 h-4 mr-3 ${isInherited || isNonSelectable ? "opacity-60" : ""}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center">
                      <span className={`truncate ${isNonSelectable ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-200"}`}>
                        {result.name}
                      </span>
                        <span className="text-xs text-gray-500 dark:text-gray-400 ml-2 px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded">
                          {result.type}
                        </span>
                        {isInherited && (
                          <span className="text-xs text-blue-600 dark:text-blue-400 ml-2 px-2 py-1 bg-blue-50 dark:bg-blue-900/30 rounded">
                            Selected
                          </span>
                        )}
                        {isNonSelectable && <IndexingTooltip />}
                      </div>
                      {result.collectionName &&
                        result.type !== "collection" && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                            in {result.collectionName}
                            {result.path && ` / ${result.path}`}
                          </div>
                        )}
                      {result.description && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 truncate">
                          {result.description}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                No results found for "{dropdownSearchQuery}"
              </div>
            )}
          </>
        ) : isShowingKbList ? (
          // Show collections list
          allAvailableIntegrations
            .filter((integration) => integration.id.startsWith("cl_"))
            .map((integration) => {
              const clId = integration.id.replace("cl_", "")

              return (
                <DropdownMenuItem
                  key={integration.id}
                  onSelect={(e) => {
                    e.preventDefault()
                    // Don't navigate when clicking the checkbox area
                  }}
                  className="flex items-center justify-between cursor-pointer text-sm py-2.5 px-4 hover:!bg-transparent focus:!bg-transparent data-[highlighted]:!bg-transparent"
                >
                  <div className="flex items-center flex-1">
                    <input
                      type="checkbox"
                      checked={!!selectedIntegrations[integration.id]}
                      onChange={(e) => {
                        e.stopPropagation()
                        toggleIntegrationSelection(integration.id)
                      }}
                      className="w-4 h-4 mr-3"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <span className="mr-2 flex items-center">
                      {integration.icon}
                    </span>
                    <span
                      className="text-gray-700 dark:text-gray-200 cursor-pointer"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigateToCl(clId, integration.name)
                      }}
                    >
                      {integration.name}
                    </span>
                  </div>
                  <ChevronRight
                    className="h-4 w-4 text-gray-400 cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation()
                      navigateToCl(clId, integration.name)
                    }}
                  />
                </DropdownMenuItem>
              )
            })
        ) : (
          // Show Collection contents (files/folders)
          <>
            {isLoadingItems ? (
              <div className="px-4 py-8 text-sm text-gray-500 dark:text-gray-400 text-center">
                Loading...
              </div>
            ) : currentItems.length > 0 ? (
              currentItems.map((item: any) => {
                const isNonSelectable = isItemNonSelectable(item)
                
                return (
                <div
                  key={item.id}
                  className={`flex items-center px-4 py-2 text-sm ${
                    isNonSelectable 
                      ? "cursor-not-allowed opacity-50" 
                      : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                  }`}
                  onClick={() => {
                    if (item.type === "folder" && !isNonSelectable) {
                      // Only allow navigation to folder if it's selectable
                      navigateToFolder(item.id, item.name)
                    }
                  }}
                >
                  {(() => {
                    const clId = navigationPath.find(
                      (item) => item.type === "cl",
                    )?.id
                    if (!clId) return null

                    const selectedSet =
                      selectedItemsInCollection[clId] || new Set()
                    const isSelected = selectedSet.has(item.id)

                    // Check if any parent folder is selected (which would make this item inherit selection)
                    const isInheritedFromParent = (() => {
                      // Get all parent folder IDs from the navigation path
                      // When we're inside a folder, that folder's ID is in the navigation path
                      const parentFolders = navigationPath
                        .filter((pathItem) => pathItem.type === "folder")
                        .map((pathItem) => pathItem.id)

                      // Also check if the current collection itself is selected (selectAll case)
                      const currentClId = navigationPath.find(
                        (item) => item.type === "cl",
                      )?.id
                      const hasCollectionIntegrationSelected =
                        currentClId &&
                        !!selectedIntegrations[`cl_${currentClId}`]
                      const isCollectionSelectAll =
                        hasCollectionIntegrationSelected &&
                        selectedSet.size === 0

                      // Check if any parent folder in the current path is selected
                      const hasSelectedParentFolder = parentFolders.some(
                        (parentId) => selectedSet.has(parentId),
                      )

                      // Item should be inherited if:
                      // 1. Any parent folder is selected, OR
                      // 2. The collection is in selectAll mode (collection selected but no specific items)
                      return hasSelectedParentFolder || isCollectionSelectAll
                    })()

                    const finalIsSelected: boolean = Boolean(
                      isSelected || isInheritedFromParent,
                    )
                    const isDisabled: boolean = Boolean(
                      (isInheritedFromParent && !isSelected) || isNonSelectable,
                    )

                    return (
                      <input
                        type="checkbox"
                        checked={finalIsSelected}
                        disabled={isDisabled}
                        onChange={(e) => {
                          e.stopPropagation()
                          if (isDisabled) return // Prevent changes if inherited from parent or non-selectable

                          const isCurrentlySelected = selectedSet.has(item.id)

                          if (item.type === "folder" && !isCurrentlySelected) {
                            // When selecting a folder, we need to handle its children
                            setSelectedItemsInCollection((prev) => {
                              const newState = { ...prev }
                              if (!newState[clId]) {
                                newState[clId] = new Set()
                              }

                              const selectedSet = new Set(newState[clId])
                              selectedSet.add(item.id)

                              newState[clId] = selectedSet
                              return newState
                            })

                            // Store item details
                            setSelectedItemDetailsInCollection((prev) => {
                              const newState = { ...prev }
                              if (!newState[clId]) {
                                newState[clId] = {}
                              }
                              newState[clId][item.id] = item
                              return newState
                            })
                          } else if (
                            item.type === "folder" &&
                            isCurrentlySelected
                          ) {
                            // When deselecting a folder, remove it from the selection set
                            setSelectedItemsInCollection((prev) => {
                              const newState = { ...prev }
                              if (!newState[clId]) return newState

                              const selectedSet = new Set(newState[clId])
                              selectedSet.delete(item.id)

                              newState[clId] = selectedSet
                              return newState
                            })

                            // Remove item details
                            setSelectedItemDetailsInCollection((prev) => {
                              const newState = { ...prev }
                              if (newState[clId] && newState[clId][item.id]) {
                                delete newState[clId][item.id]
                              }
                              return newState
                            })
                          } else {
                            // Handle regular file selection
                            setSelectedItemsInCollection((prev) => {
                              const newState = { ...prev }
                              if (!newState[clId]) {
                                newState[clId] = new Set()
                              }

                              const selectedSet = new Set(newState[clId])
                              if (selectedSet.has(item.id)) {
                                selectedSet.delete(item.id)
                              } else {
                                selectedSet.add(item.id)
                              }

                              newState[clId] = selectedSet
                              return newState
                            })

                            // Also store/remove item details
                            setSelectedItemDetailsInCollection((prev) => {
                              const newState = { ...prev }
                              if (!newState[clId]) {
                                newState[clId] = {}
                              }

                              if (isCurrentlySelected) {
                                delete newState[clId][item.id]
                              } else {
                                newState[clId][item.id] = item
                              }

                              return newState
                            })
                          }

                          // Auto-select/deselect the Collection integration
                          setSelectedIntegrations((prev) => {
                            const clIntegrationId = `cl_${clId}`
                            const currentSelectedSet =
                              selectedItemsInCollection[clId] || new Set()
                            const newSelectedSet = new Set(currentSelectedSet)

                            if (isCurrentlySelected) {
                              newSelectedSet.delete(item.id)
                            } else {
                              newSelectedSet.add(item.id)
                            }

                            return {
                              ...prev,
                              [clIntegrationId]: newSelectedSet.size > 0,
                            }
                          })
                        }}
                        className={`w-4 h-4 mr-3 ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )
                  })()}
                  {item.type === "folder" && (
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`mr-2 ${isNonSelectable ? "text-gray-400" : "text-gray-800"}`}
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                    </svg>
                  )}
                  <span className={`truncate flex-1 ${isNonSelectable ? "text-gray-400 dark:text-gray-500" : "text-gray-700 dark:text-gray-200"}`}>
                    {item.name}
                  </span>
                  {isNonSelectable && <IndexingTooltip />}
                  {item.type === "folder" && !isNonSelectable && (
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
