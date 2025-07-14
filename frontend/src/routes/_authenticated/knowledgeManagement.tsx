import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Plus, X, MoreHorizontal, Edit, Trash2 } from "lucide-react"
import { Sidebar } from "@/components/Sidebar"
import { useState, useCallback, useEffect } from "react"
import { Input } from "@/components/ui/input"
import KbFileUpload, {
  SelectedFile as FileUploadSelectedFile,
} from "@/components/KbFileUpload"
import FileUploadSkeleton from "@/components/FileUploadSkeleton"
import { useToast } from "@/hooks/use-toast"
import FileTree from "@/components/FileTree"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmModal } from "@/components/ui/confirmModal"
import {
  buildFileTree,
  type FileNode,
  uploadFileBatch,
  createKnowledgeBase,
  deleteKnowledgeBase,
  deleteItem,
} from "@/utils/fileUtils"
import type { KnowledgeBase, KbItem } from "@/types/knowledgeBase"

export const Route = createFileRoute("/_authenticated/knowledgeManagement")({
  component: RouteComponent,
})

interface Collection {
  id: string;
  name: string;
  description?: string | null;
  files: number;
  lastUpdated: string;
  updatedBy: string;
  items: FileNode[];
  isOpen?: boolean;
  // For compatibility with KnowledgeBase
  totalCount?: number;
  isPrivate?: boolean;
}



// Helper functions for localStorage
const UPLOAD_STATE_KEY = 'knowledgeManagement_uploadState'

const saveUploadState = (state: {
  isUploading: boolean
  batchProgress: { total: number, current: number, batch: number, totalBatches: number }
  uploadingCollectionName: string
}) => {
  try {
    localStorage.setItem(UPLOAD_STATE_KEY, JSON.stringify(state))
  } catch (error) {
    console.error('Failed to save upload state:', error)
  }
}

const loadUploadState = () => {
  try {
    const saved = localStorage.getItem(UPLOAD_STATE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch (error) {
    console.error('Failed to load upload state:', error)
  }
  return {
    isUploading: false,
    batchProgress: { total: 0, current: 0, batch: 0, totalBatches: 0 },
    uploadingCollectionName: ""
  }
}

const clearUploadState = () => {
  try {
    localStorage.removeItem(UPLOAD_STATE_KEY)
  } catch (error) {
    console.error('Failed to clear upload state:', error)
  }
}

function RouteComponent() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context
  const { toast } = useToast()
  const [showNewCollection, setShowNewCollection] = useState(false)
  const [collectionName, setCollectionName] = useState("")
  const [collections, setCollections] = useState<Collection[]>([]);
  const [editingCollection, setEditingCollection] = useState<Collection | null>(null);
  const [deletingCollection, setDeletingCollection] = useState<Collection | null>(null);
  const [deletingItem, setDeletingItem] = useState<{ collection: Collection, node: FileNode, path: string } | null>(null);
  const [addingToCollection, setAddingToCollection] = useState<Collection | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileUploadSelectedFile[]>([])
  
  // Load upload state from localStorage on mount
  const savedState = loadUploadState()
  const [isUploading, setIsUploading] = useState(savedState.isUploading)
  const [batchProgress, setBatchProgress] = useState(savedState.batchProgress)
  const [uploadingCollectionName, setUploadingCollectionName] = useState(savedState.uploadingCollectionName)

  // Save upload state to localStorage whenever it changes
  useEffect(() => {
    saveUploadState({
      isUploading,
      batchProgress,
      uploadingCollectionName
    })
  }, [isUploading, batchProgress, uploadingCollectionName])

  // Clean up on unmount
  useEffect(() => {
    return () => {
      // Only clear if upload is not active
      if (!isUploading) {
        clearUploadState()
      }
    }
  }, [isUploading])

  // Fallback: Clear upload state if it's been "uploading" for too long
  useEffect(() => {
    if (!isUploading) return

    // If upload state has been active for more than 10 minutes, clear it
    const timeout = setTimeout(() => {
      console.log('Upload state has been active too long, clearing it')
      setIsUploading(false)
      setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
      setUploadingCollectionName("")
      clearUploadState()
    }, 10 * 60 * 1000) // 10 minutes

    return () => clearTimeout(timeout)
  }, [isUploading])

  const showToast = useCallback(
    (title: string, description: string, isError = false) => {
      const { dismiss } = toast({
        title,
        description,
        variant: isError ? "destructive" : "default",
        duration: 2000,
        action: (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.preventDefault()
              dismiss()
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        ),
      })
    },
    [toast],
  )

  // Check for ongoing uploads on component mount
  useEffect(() => {
    const checkForOngoingUploads = async () => {
      const savedState = loadUploadState()
      if (savedState.isUploading && savedState.uploadingCollectionName) {
        // If there's an ongoing upload, check if it's actually complete
        console.log('Detected ongoing upload from previous session:', savedState)
        
        // Check if the collection exists and has files
        try {
          const response = await fetch("/api/v1/kb");
          if (response.ok) {
            const data = await response.json();
            const existingCollection = data.find((kb: KnowledgeBase) => 
              kb.name.toLowerCase() === savedState.uploadingCollectionName.toLowerCase()
            );
            
            if (existingCollection && existingCollection.totalCount >= savedState.batchProgress.total) {
              // Upload appears to be complete, clear the state
              console.log('Upload appears to be complete, clearing state')
              setIsUploading(false)
              setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
              setUploadingCollectionName("")
              clearUploadState()
              
              // Show completion toast
              showToast(
                "Upload Complete",
                `Upload of ${savedState.batchProgress.total} files to "${savedState.uploadingCollectionName}" completed while you were away.`
              )
            }
          }
        } catch (error) {
          console.error('Error checking upload status:', error)
          // If we can't check, clear the state after a timeout to avoid infinite skeleton
          setTimeout(() => {
            setIsUploading(false)
            setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
            setUploadingCollectionName("")
            clearUploadState()
          }, 5000)
        }
      }
    }

    checkForOngoingUploads()
  }, [showToast])

  // Periodic check for upload completion while on the page
  useEffect(() => {
    if (!isUploading || !uploadingCollectionName) return

    const checkUploadProgress = async () => {
      try {
        const response = await fetch("/api/v1/kb");
        if (response.ok) {
          const data = await response.json();
          const existingCollection = data.find((kb: KnowledgeBase) => 
            kb.name.toLowerCase() === uploadingCollectionName.toLowerCase()
          );
          
          if (existingCollection && existingCollection.totalCount >= batchProgress.total) {
            // Upload is complete, clear the state
            console.log('Upload completed, clearing state')
            setIsUploading(false)
            setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
            setUploadingCollectionName("")
            clearUploadState()
            
            // Refresh collections to show the new one
            const updatedCollections = data.map((kb: KnowledgeBase) => ({
              id: kb.id,
              name: kb.name,
              description: kb.description,
              files: kb.totalCount || 0,
              items: [],
              isOpen: false,
              lastUpdated: new Date(kb.updatedAt).toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              }),
              updatedBy: kb.lastUpdatedByEmail || "Unknown",
              totalCount: kb.totalCount,
              isPrivate: kb.isPrivate,
            }))
            setCollections(updatedCollections)
            
            showToast(
              "Upload Complete",
              `Successfully uploaded ${batchProgress.total} files to "${uploadingCollectionName}".`
            )
          }
        }
      } catch (error) {
        console.error('Error checking upload progress:', error)
      }
    }

    // Check every 3 seconds while upload is active
    const interval = setInterval(checkUploadProgress, 3000)
    
    return () => clearInterval(interval)
  }, [isUploading, uploadingCollectionName, batchProgress.total, showToast])

  useEffect(() => {
    const fetchCollections = async () => {
      try {
        const response = await fetch("/api/v1/kb");
        if (response.ok) {
          const data = await response.json();
          setCollections(data.map((kb: KnowledgeBase) => ({
            id: kb.id,
            name: kb.name,
            description: kb.description,
            files: kb.totalCount || 0,
            items: [],
            isOpen: false,
            lastUpdated: new Date(kb.updatedAt).toLocaleString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            updatedBy: kb.lastUpdatedByEmail || "Unknown",
            totalCount: kb.totalCount,
            isPrivate: kb.isPrivate,
          })))
        } else {
          showToast("Error", "Failed to fetch knowledge bases.", true);
        }
      } catch (error) {
        showToast("Error", "An error occurred while fetching knowledge bases.", true);
      }
    };

    fetchCollections();
  }, [showToast]);

  const handleCloseModal = () => {
    setShowNewCollection(false);
    setAddingToCollection(null);
    setCollectionName("");
    setSelectedFiles([]);
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      showToast("Upload Error", "Please select files to upload.", true)
      return
    }

    if (collections.some((c) => c.name.toLowerCase() === collectionName.trim().toLowerCase())) {
      showToast("Upload Error", "Collection name already exists. Please choose a different name.", true)
      return
    }

    setIsUploading(true)
    setUploadingCollectionName(collectionName.trim())
    setBatchProgress({ total: selectedFiles.length, current: 0, batch: 0, totalBatches: 0 })
    
    // Close the modal immediately after starting upload
    handleCloseModal()

    try {
      // First create the knowledge base
      const kb = await createKnowledgeBase(collectionName.trim(), "");
      
      // Then upload files in batches
      const batches = createBatches(selectedFiles, collectionName.trim());
      setBatchProgress((prev: typeof batchProgress) => ({ ...prev, totalBatches: batches.length }))

      for (let i = 0; i < batches.length; i++) {
        setBatchProgress((prev: typeof batchProgress) => ({ ...prev, batch: i + 1 }))
        const batchFiles = batches[i].map(f => f.file);
        console.log(`Uploading batch ${i + 1}/${batches.length} with ${batchFiles.length} files to KB ${kb.id}`);
        const uploadResult = await uploadFileBatch(batchFiles, kb.id);
        console.log('Upload batch result:', uploadResult);
        setBatchProgress((prev: typeof batchProgress) => ({ ...prev, current: prev.current + batchFiles.length }))
      }

      // Fetch the updated KB data from the backend
      const kbResponse = await fetch(`/api/v1/kb/${kb.id}`);
      const updatedKb = await kbResponse.json();
      
      const newCollection: Collection = {
        id: updatedKb.id,
        name: updatedKb.name,
        description: updatedKb.description,
        files: updatedKb.totalCount || selectedFiles.length,
        lastUpdated: new Date(updatedKb.updatedAt).toLocaleString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        updatedBy: updatedKb.lastUpdatedByEmail || user?.email || "Unknown",
        items: [],
        isOpen: false,
        totalCount: updatedKb.totalCount,
        isPrivate: updatedKb.isPrivate,
      }

      setCollections((prev) => [newCollection, ...prev])
      handleCloseModal()
      showToast(
        "Knowledge Base Created",
        `Successfully created knowledge base "${collectionName.trim()}" with ${selectedFiles.length} files.`,
      )
    } catch (error) {
      console.error("Upload failed:", error)
      showToast("Upload Failed", "Failed to create collection. Please try again.", true)
    } finally {
      setIsUploading(false)
      setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
      setUploadingCollectionName("")
      clearUploadState()
    }
  }

  const handleFilesSelect = (files: File[]) => {
    const newFiles: FileUploadSelectedFile[] = files.map((file) => ({
      file,
      id: Math.random().toString(),
      preview: URL.createObjectURL(file),
    }))
    setSelectedFiles((prev) => [...prev, ...newFiles])
  }

  const handleRemoveFile = (id: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const handleRemoveAllFiles = () => {
    setSelectedFiles([])
  }

  const handleOpenAddFilesModal = (collection: Collection) => {
    setAddingToCollection(collection);
    setCollectionName(collection.name);
    setShowNewCollection(true);
  };

  const handleAddFilesToCollection = async () => {
    if (!addingToCollection) return;

    if (selectedFiles.length === 0) {
      showToast("Upload Error", "Please select files to upload.", true);
      return;
    }

    setIsUploading(true);
    setUploadingCollectionName(addingToCollection.name)
    setBatchProgress({ total: selectedFiles.length, current: 0, batch: 0, totalBatches: 0 })
    
    // Close the modal immediately after starting upload
    handleCloseModal()

    try {
      // Upload files in batches
      const batches = createBatches(selectedFiles, addingToCollection.name);
      setBatchProgress((prev: typeof batchProgress) => ({ ...prev, totalBatches: batches.length }))

      for (let i = 0; i < batches.length; i++) {
        setBatchProgress((prev: typeof batchProgress) => ({ ...prev, batch: i + 1 }))
        const batchFiles = batches[i].map(f => f.file);
        console.log(`Uploading batch ${i + 1}/${batches.length} with ${batchFiles.length} files to KB ${addingToCollection.id}`);
        const uploadResult = await uploadFileBatch(batchFiles, addingToCollection.id);
        console.log('Upload batch result:', uploadResult);
        setBatchProgress((prev: typeof batchProgress) => ({ ...prev, current: prev.current + batchFiles.length }))
      }

      // Refresh the collection by fetching updated data from backend
      const kbResponse = await fetch(`/api/v1/kb/${addingToCollection.id}`);
      const updatedKb = await kbResponse.json();
      
      const itemsResponse = await fetch(`/api/v1/kb/${addingToCollection.id}/items`);
      const items = await itemsResponse.json();
      
      setCollections(prev => prev.map(c => {
        if (c.id === addingToCollection.id) {
          return {
            ...c,
            files: updatedKb.totalCount || 0,
            items: buildFileTree(items.map((item: KbItem) => ({
              name: item.name,
              type: item.type as 'file' | 'folder',
              totalCount: item.totalCount,
              updatedAt: item.updatedAt,
              id: item.id,
              updatedBy: item.lastUpdatedByEmail || user?.email || "Unknown",
            }))),
            lastUpdated: new Date(updatedKb.updatedAt).toLocaleString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
            updatedBy: updatedKb.lastUpdatedByEmail || "Unknown",
          };
        }
        return c;
      }));

      showToast(
        "Files Added",
        `Successfully added ${selectedFiles.length} files to collection "${addingToCollection.name}".`,
      );
      handleCloseModal();
    } catch (error) {
      console.error("Add files failed:", error);
      showToast("Add Files Failed", "Failed to add files to collection. Please try again.", true);
    } finally {
      setIsUploading(false);
      setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
      setUploadingCollectionName("")
      clearUploadState()
    }
  };

  const handleDeleteItem = async () => {
    if (!deletingItem) return;

    setIsUploading(true);
    try {
      // Find the item to delete based on the path
      const itemToDelete = findItemByPath(deletingItem.collection.items, deletingItem.path);
      if (itemToDelete) {
        await deleteItem(deletingItem.collection.id, itemToDelete.id);
      }

      // Refresh the collection data from backend
      const kbResponse = await fetch(`/api/v1/kb/${deletingItem.collection.id}`);
      const updatedKb = await kbResponse.json();
      
      const itemsResponse = await fetch(`/api/v1/kb/${deletingItem.collection.id}/items`);
      const items = await itemsResponse.json();
      
      setCollections(prev => prev.map(c => {
        if (c.id === deletingItem.collection.id) {
          return {
            ...c,
            files: updatedKb.totalCount || 0,
            items: buildFileTree(items.map((item: KbItem) => ({
              name: item.name,
              type: item.type as 'file' | 'folder',
              totalCount: item.totalCount,
              updatedAt: item.updatedAt,
              id: item.id,
              updatedBy: item.lastUpdatedByEmail || user?.email || "Unknown",
            }))),
            lastUpdated: new Date(updatedKb.updatedAt).toLocaleString("en-GB", {
              day: "numeric",
              month: "short",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          };
        }
        return c;
      }));

      showToast("Item Deleted", `Successfully deleted "${deletingItem.node.name}".`);
    } catch (error) {
      console.error("Delete failed:", error);
      showToast("Delete Failed", "Failed to delete item. Please try again.", true);
    } finally {
      setDeletingItem(null);
      setIsUploading(false);
    }
  };

  const handleEditCollection = (collection: Collection) => {
    setEditingCollection(collection);
    setCollectionName(collection.name);
  };

  const handleUpdateCollection = async () => {
    if (!editingCollection || !collectionName.trim()) return;

    try {
      const response = await fetch(`/api/v1/kb/${editingCollection.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: collectionName.trim() }),
      });

      if (response.ok) {
        const updatedKb = await response.json();
        setCollections(prev => prev.map(c => c.id === editingCollection.id ? { 
          ...c, 
          name: updatedKb.name,
          lastUpdated: new Date(updatedKb.updatedAt).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
        } : c));
        setEditingCollection(null);
        setCollectionName("");
        showToast("Collection Updated", "Successfully updated collection name.");
      } else {
        const errorText = await response.text();
        showToast("Update Failed", `Failed to update collection name: ${errorText}`, true);
      }
    } catch (error) {
      console.error("Update failed:", error);
      showToast("Update Failed", "Failed to update collection name.", true);
    }
  };

  const handleDeleteCollection = async () => {
    if (!deletingCollection) return;

    setIsUploading(true)
    
    try {
      // Delete the knowledge base
      await deleteKnowledgeBase(deletingCollection.id)
      
      // Remove from state
      setCollections(prev => prev.filter(c => c.id !== deletingCollection.id));
      setDeletingCollection(null);
      showToast("Collection Deleted", "Successfully deleted collection and all associated files.");
    } catch (error) {
      console.error("Delete failed:", error)
      showToast("Delete Failed", "Failed to delete collection. Please try again.", true);
    } finally {
      setIsUploading(false)
    }
  };

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-white dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="flex-1 flex flex-col h-full md:ml-[60px]">
        <div className="p-4 md:py-4 md:px-8">
          <div className="w-full max-w-7xl mx-auto">
            <div className="flex justify-between items-center mt-6">
              <h1 className="text-[26px] font-display text-gray-700 dark:text-gray-100 tracking-wider">
                KNOWLEDGE MANAGEMENT
              </h1>
              <div className="flex items-center gap-4">
                {/* <Search className="text-gray-400 h-6 w-6" /> */}
                <Button
                  onClick={() => setShowNewCollection(true)}
                  disabled={isUploading}
                  className="bg-slate-800 hover:bg-slate-700 text-white rounded-full px-4 py-2 flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus size={16} />
                  <span className="font-mono text-[12px] font-medium">
                    NEW COLLECTION
                  </span>
                </Button>
              </div>
            </div>
            <div className="mt-12">
              {/* Show skeleton loader when uploading */}
              {isUploading && batchProgress.total > 0 && (
                <div className="mb-8">
                  <div className="flex justify-between items-center mb-4">
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200">
                        {uploadingCollectionName}
                      </h2>
                      <span className="text-sm text-gray-500 dark:text-gray-400">
                        uploading files...
                      </span>
                    </div>
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      {batchProgress.current} / {batchProgress.total} files processed
                    </div>
                  </div>
                  <FileUploadSkeleton
                    totalFiles={batchProgress.total}
                    processedFiles={batchProgress.current}
                    currentBatch={batchProgress.batch}
                    totalBatches={batchProgress.totalBatches}
                  />
                </div>
              )}
              
              {collections.map((collection, index) => (
                <div key={index} className="mb-8">
                  <div className="flex justify-between items-center mb-4 cursor-pointer" onClick={async () => {
                      const updatedCollections = [...collections];
                      const coll = updatedCollections.find(c => c.id === collection.id);
                      if (coll) {
                        coll.isOpen = !coll.isOpen;
                        if (coll.isOpen) {
                          const response = await fetch(`/api/v1/kb/${collection.id}/items`);
                          const data = await response.json();
                          coll.items = buildFileTree(data.map((item: KbItem) => ({
                            name: item.name,
                            type: item.type as 'file' | 'folder',
                            totalCount: item.totalCount,
                            updatedAt: item.updatedAt,
                            id: item.id,
                            updatedBy: item.lastUpdatedByEmail || user?.email || "Unknown",
                          })));
                        } else {
                          // coll.items = []; // This would clear the items, maybe not desired
                        }
                        setCollections(updatedCollections);
                      }
                  }}>
                    <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-200">
                      {collection.name}
                    </h2>
                    <div className="flex items-center gap-4">
                      <Plus 
                        size={16} 
                        className={`cursor-pointer ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`} 
                        onClick={(e) => {
                          e.stopPropagation();
                          !isUploading && handleOpenAddFilesModal(collection)
                        }} 
                      />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <MoreHorizontal 
                            size={16} 
                            className={`cursor-pointer ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}`} 
                            onClick={(e) => e.stopPropagation()}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation();
                              !isUploading && handleEditCollection(collection)
                            }}
                            disabled={isUploading}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            <span>Edit</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation();
                              !isUploading && setDeletingCollection(collection)
                            }}
                            disabled={isUploading}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            <span>Delete</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                  {collection.isOpen && (
                    <>
                      <div className="grid grid-cols-12 gap-4 text-sm text-gray-500 dark:text-gray-400 pb-2 border-b border-gray-200 dark:border-gray-700">
                        <div className="col-span-5">FOLDER</div>
                        <div className="col-span-2"></div>
                        <div className="col-span-1 text-center">FILES</div>
                        <div className="col-span-2">LAST UPDATED</div>
                        <div className="col-span-2">UPDATED&nbsp;BY</div>
                      </div>
                      <FileTree
                        items={collection.items}
                        onAddFiles={(node, path) => {
                          const collection = collections.find(c => c.items.some(item => findNode(item, node)));
                          if (collection) {
                            handleOpenAddFilesModal(collection);
                          }
                        }}
                        onDelete={(node, path) => {
                          const collection = collections.find(c => c.items.some(item => findNode(item, node)));
                          if (collection) {
                            if (node.type === 'folder' && node.name === collection.name) {
                              setDeletingCollection(collection);
                            } else {
                              setDeletingItem({ collection, node, path });
                            }
                          }
                        }}
                        onToggle={async (node) => {
                          if (node.type !== 'folder') return;
                          
                          const updatedCollections = [...collections];
                          const coll = updatedCollections.find(c => c.id === collection.id);
                          if (coll) {
                            // Toggle the folder state
                            const toggleNode = async (nodes: FileNode[]): Promise<FileNode[]> => {
                              const updatedNodes = [...nodes];
                              for (let i = 0; i < updatedNodes.length; i++) {
                                const n = updatedNodes[i];
                                if (n === node) {
                                  n.isOpen = !n.isOpen;
                                  
                                  // If opening the folder and it has an ID, fetch its contents
                                  if (n.isOpen && n.id) {
                                    try {
                                      console.log(`Fetching contents for folder ${n.name} with id ${n.id}`);
                                      const response = await fetch(`/api/v1/kb/${collection.id}/items?parentId=${n.id}`);
                                      if (response.ok) {
                                        const items = await response.json();
                                        console.log(`Fetched ${items.length} items for folder ${n.name}`);
                                        
                                        // Build the children structure
                                        n.children = items.map((item: KbItem) => ({
                                          id: item.id,
                                          name: item.name,
                                          type: item.type as 'file' | 'folder',
                                          files: item.totalCount,
                                          lastUpdated: item.updatedAt,
                                          updatedBy: item.lastUpdatedByEmail || user?.email || "Unknown",
                                          isOpen: false,
                                          children: item.type === 'folder' ? [] : undefined,
                                        }));
                                      }
                                    } catch (error) {
                                      console.error(`Failed to fetch folder contents for ${n.name}:`, error);
                                      showToast("Error", `Failed to load folder contents`, true);
                                    }
                                  } else if (!n.isOpen) {
                                    // Optionally clear children when closing
                                    // n.children = [];
                                  }
                                } else if (n.children) {
                                  n.children = await toggleNode(n.children);
                                }
                              }
                              return updatedNodes;
                            };
                            
                            coll.items = await toggleNode(coll.items);
                            setCollections(updatedCollections);
                          }
                        }}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {deletingCollection && (
        <ConfirmModal
          showModal={!!deletingCollection}
          setShowModal={(val) => {
            if (!val.open) {
              setDeletingCollection(null)
            }
          }}
          modalTitle="Delete Collection"
          modalMessage={`Are you sure you want to delete the collection "${deletingCollection.name}"? This action cannot be undone.`}
          onConfirm={handleDeleteCollection}
        />
      )}
      {deletingItem && (
        <ConfirmModal
          showModal={!!deletingItem}
          setShowModal={(val) => {
            if (!val.open) {
              setDeletingItem(null)
            }
          }}
          modalTitle={`Delete ${deletingItem.node.type}`}
          modalMessage={`Are you sure you want to delete "${deletingItem.node.name}"? This action cannot be undone.`}
          onConfirm={handleDeleteItem}
        />
      )}
      {editingCollection && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl w-[90%] max-w-md max-h-[90vh] overflow-hidden flex flex-col p-2">
            <div className="pb-1">
              <div className="flex justify-between items-center">
                <h2 className="pl-2 font-medium text-gray-400 dark:text-gray-200 font-mono">
                  EDIT COLLECTION NAME
                </h2>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setEditingCollection(null);
                    setCollectionName("");
                  }}
                  className="p-1"
                >
                  <X className="h-5 w-5 text-gray-400" />
                </Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-6 bg-white dark:bg-gray-800">
                <div className="mb-6">
                  <label
                    htmlFor="editCollectionName"
                    className="block text-sm text-gray-700 dark:text-gray-300 mb-2"
                  >
                    Collection title
                  </label>
                  <Input
                    id="editCollectionName"
                    type="text"
                    placeholder="Enter collection name"
                    value={collectionName}
                    onChange={(e) => setCollectionName(e.target.value)}
                    className="w-full text-xl placeholder:text-gray-400 placeholder:opacity-60 dark:placeholder:text-gray-500 dark:placeholder:opacity-50 !outline-none !focus:outline-none !focus:ring-0 !focus:shadow-none !bg-transparent !px-0 !shadow-none !ring-0 border-0 border-b border-gray-300 dark:border-gray-600 focus:border-b focus:border-gray-400 dark:focus:border-gray-500 !rounded-none"
                    autoComplete="off"
                  />
                  <div className="h-2 mt-1">
                    {collections.some((c) => c.name.toLowerCase() === collectionName.trim().toLowerCase() && c.id !== editingCollection?.id) && (
                      <p className="text-sm text-gray-500">Collection name already exists</p>
                    )}
                  </div>
                </div>
                <div className="flex justify-end gap-4 mt-4">
                  <Button variant="ghost" onClick={() => {
                    setEditingCollection(null);
                    setCollectionName("");
                  }}>
                    Cancel
                  </Button>
                  <Button 
                    onClick={handleUpdateCollection}
                    disabled={!collectionName.trim() || collections.some((c) => c.name.toLowerCase() === collectionName.trim().toLowerCase() && c.id !== editingCollection?.id)}
                  >
                    Update
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {(showNewCollection || addingToCollection) && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-gray-100 dark:bg-gray-700 rounded-2xl w-[90%] max-w-4xl max-h-[90vh] overflow-hidden flex flex-col p-2">
            <div className="pb-1">
              <div className="flex justify-between items-center">
                <h2 className="pl-2  font-medium text-gray-400 dark:text-gray-200 font-mono">
                  {addingToCollection ? `Add files to ${addingToCollection.name}` : "CREATE NEW COLLECTION"}
                </h2>
                <Button
                  variant="ghost"
                  onClick={handleCloseModal}
                  className="p-1"
                >
                  <X className="h-5 w-5 text-gray-400" />
                </Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1">
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-6 bg-white dark:bg-gray-800">
                <div className="mb-6">
                  <label
                    htmlFor="collectionName"
                    className="block text-sm text-gray-700 dark:text-gray-300 mb-2"
                  >
                    {addingToCollection ? "Adding to collection" : "Collection title"}
                  </label>
                  <Input
                    id="collectionName"
                    type="text"
                    placeholder="Frontend documentation"
                    value={collectionName}
                    onChange={(e) => setCollectionName(e.target.value)}
                    className="w-full text-xl placeholder:text-gray-400 placeholder:opacity-60 dark:placeholder:text-gray-500 dark:placeholder:opacity-50 !outline-none !focus:outline-none !focus:ring-0 !focus:shadow-none !bg-transparent !px-0 !shadow-none !ring-0 border-0 border-b border-gray-300 dark:border-gray-600 focus:border-b focus:border-gray-400 dark:focus:border-gray-500 !rounded-none"
                    disabled={isUploading || !!addingToCollection}
                    autoComplete="off"
                  />
                  <div className="h-2 mt-1">
                    {collections.some((c) => c.name.toLowerCase() === collectionName.trim().toLowerCase() && !addingToCollection) && (
                      <p className="text-sm text-gray-500">Collection name already exists</p>
                    )}
                  </div>
                </div>
                <KbFileUpload
                  onFilesSelect={handleFilesSelect}
                  onRemoveFile={handleRemoveFile}
                  onRemoveAllFiles={handleRemoveAllFiles}
                  selectedFiles={selectedFiles}
                  onUpload={addingToCollection ? handleAddFilesToCollection : handleUpload}
                  isUploading={isUploading}
                  collectionName={collectionName}
                  batchProgress={batchProgress}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function getAllFileNames(node: FileNode, path = ''): {name: string}[] {
  const currentPath = path ? `${path}/${node.name}` : node.name;
  if (node.type === 'file') {
    return [{ name: currentPath }];
  }
  if (node.children) {
    return node.children.flatMap(child => getAllFileNames(child, currentPath));
  }
  return [];
}

function findNode(root: FileNode, target: FileNode): boolean {
  if (root === target) {
    return true;
  }
  if (root.children) {
    for (const child of root.children) {
      if (findNode(child, target)) {
        return true;
      }
    }
  }
  return false;
}

function removeItemByPath(items: FileNode[], path: string): FileNode[] {
  const pathParts = path.split('/');
  const itemNameToRemove = pathParts[pathParts.length - 1];

  const removeItem = (nodes: FileNode[], currentPath: string): FileNode[] => {
    return nodes.filter(node => {
      const newPath = currentPath ? `${currentPath}/${node.name}` : node.name;
      if (newPath === path) {
        return false;
      }
      if (node.children) {
        node.children = removeItem(node.children, newPath);
      }
      return true;
    });
  };

  return removeItem(items, '');
}

function countFilesInTree(nodes: FileNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === 'file') {
      count++;
    } else if (node.children) {
      count += countFilesInTree(node.children);
    }
  }
  return count;
}

function findItemByPath(items: FileNode[], targetPath: string): any | null {
  const findInNodes = (nodes: FileNode[], currentPath: string): any | null => {
    for (const node of nodes) {
      const nodePath = currentPath ? `${currentPath}/${node.name}` : node.name;
      if (nodePath === targetPath) {
        return node;
      }
      if (node.children) {
        const found = findInNodes(node.children, nodePath);
        if (found) return found;
      }
    }
    return null;
  };
  
  return findInNodes(items, '');
}

const estimateFormDataSize = (
  files: File[],
  collectionName: string,
): number => {
  let size = 0
  size += new TextEncoder().encode(collectionName).length + 100
  files.forEach((file) => {
    size += file.size
    size += file.name.length * 2
    size += 200
  })
  return size
}

const createBatches = (files: FileUploadSelectedFile[], collectionName: string): FileUploadSelectedFile[][] => {
  const BATCH_CONFIG = {
    MAX_PAYLOAD_SIZE: 45 * 1024 * 1024,
    MAX_FILES_PER_BATCH: 50,
  }
  const batches: FileUploadSelectedFile[][] = []
  let currentBatch: FileUploadSelectedFile[] = []
  let currentBatchSize = 0

  const baseOverhead = estimateFormDataSize([], collectionName)

  for (const selectedFile of files) {
    const fileOverhead =
      selectedFile.file.size + selectedFile.file.name.length * 2 + 200
    const newBatchSize = currentBatchSize + fileOverhead

    if (
      currentBatch.length > 0 &&
      (baseOverhead + newBatchSize > BATCH_CONFIG.MAX_PAYLOAD_SIZE ||
        currentBatch.length >= BATCH_CONFIG.MAX_FILES_PER_BATCH)
    ) {
      batches.push([...currentBatch])
      currentBatch = [selectedFile]
      currentBatchSize = fileOverhead
    } else {
      currentBatch.push(selectedFile)
      currentBatchSize = newBatchSize
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}
