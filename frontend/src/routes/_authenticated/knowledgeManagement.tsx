import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { Search, Plus, X, MoreHorizontal, Edit, Trash2 } from "lucide-react"
import { Sidebar } from "@/components/Sidebar"
import { useState, useCallback, useRef, useEffect } from "react"
import { Input } from "@/components/ui/input"
import KbFileUpload, {
  SelectedFile as FileUploadSelectedFile,
} from "@/components/KbFileUpload"
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
  saveFilesToTempFolder,
  removeCollectionFromTempFolder,
  addFilesToExistingCollection,
  removeFileFromTempFolder,
  buildFileTree,
  type FileNode,
  uploadFileBatch,
} from "@/utils/fileUtils"

export const Route = createFileRoute("/_authenticated/knowledgeManagement")({
  component: RouteComponent,
})


interface Collection {
  id: string;
  name: string;
  files: number;
  lastUpdated: string;
  updatedBy: string;
  items: FileNode[];
  folders?: any[];
  isOpen?: boolean;
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
  const [isUploading, setIsUploading] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ total: 0, current: 0, batch: 0, totalBatches: 0 })

  useEffect(() => {
    const fetchCollections = async () => {
      try {
        const response = await fetch("/api/v1/kb/collections");
        if (response.ok) {
          const data = await response.json();
          setCollections(data.map((c: Collection) => ({ ...c, files: 0, items: [], folders: [], isOpen: false })));
        } else {
          showToast("Error", "Failed to fetch collections.", true);
        }
      } catch (error) {
        showToast("Error", "An error occurred while fetching collections.", true);
      }
    };

    fetchCollections();
  }, []);

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
              e.stopPropagation()
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
    setBatchProgress({ total: selectedFiles.length, current: 0, batch: 0, totalBatches: 0 })

    try {
      const batches = createBatches(selectedFiles, collectionName.trim());
      setBatchProgress(prev => ({ ...prev, totalBatches: batches.length }))

      for (let i = 0; i < batches.length; i++) {
        setBatchProgress(prev => ({ ...prev, batch: i + 1 }))
        const batchFiles = batches[i].map(f => f.file);
        await uploadFileBatch(batchFiles, collectionName.trim());
        setBatchProgress(prev => ({ ...prev, current: prev.current + batchFiles.length }))
      }

      const newCollection: Collection = {
        id: crypto.randomUUID(),
        name: collectionName.trim(),
        files: selectedFiles.length,
        lastUpdated: new Date().toLocaleString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
        updatedBy: "rahim.h@rbi.gov.in",
        items: buildFileTree(selectedFiles.map(f => ({ name: (f.file as any).webkitRelativePath || f.file.name, type: 'file' }))),
      }

      setCollections((prev) => [...prev, newCollection])
      handleCloseModal()
      showToast(
        "Collection Created",
        `Successfully created collection "${collectionName.trim()}" with ${selectedFiles.length} files.`,
      )
    } catch (error) {
      console.error("Upload failed:", error)
      showToast("Upload Failed", "Failed to create collection. Please try again.", true)
    } finally {
      setIsUploading(false)
      setBatchProgress({ total: 0, current: 0, batch: 0, totalBatches: 0 })
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

    try {
      await addFilesToExistingCollection(selectedFiles, addingToCollection.name);

      setCollections(prev => prev.map(c => {
        if (c.name === addingToCollection.name) {
          const allFileNames = [...c.items.flatMap(item => getAllFileNames(item)), ...selectedFiles.map(f => ({ name: (f.file as any).webkitRelativePath || f.file.name, type: 'file' }))]
          const uniqueFiles = Array.from(new Set(allFileNames.map(f => f.name))).map(name => ({name, type: 'file' as 'file' | 'folder'}))

          return {
            ...c,
            files: uniqueFiles.length,
            items: buildFileTree(uniqueFiles),
            lastUpdated: new Date().toLocaleString("en-GB", {
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
    }
  };

  const handleDeleteItem = async () => {
    if (!deletingItem) return;

    setIsUploading(true);
    try {
      await removeFileFromTempFolder(deletingItem.collection.name, deletingItem.path);

      // Optimistically update the UI
      const updatedCollections = collections.map(c => {
        if (c.name === deletingItem.collection.name) {
          const newItems = removeItemByPath(c.items, deletingItem.path);
          return { ...c, items: newItems, files: countFilesInTree(newItems) };
        }
        return c;
      });
      setCollections(updatedCollections);

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

    const response = await fetch(`/api/v1/files/${editingCollection.name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: collectionName }),
    });

    if (response.ok) {
      setCollections(prev => prev.map(c => c.name === editingCollection.name ? { ...c, name: collectionName } : c));
      setEditingCollection(null);
      setCollectionName("");
      showToast("Collection Updated", "Successfully updated collection name.");
    } else {
      showToast("Update Failed", "Failed to update collection name.", true);
    }
  };

  const handleDeleteCollection = async () => {
    if (!deletingCollection) return;

    setIsUploading(true)
    
    try {
      // Remove collection from temp folder
      await removeCollectionFromTempFolder(deletingCollection.name)
      
      // Remove from state
      setCollections(prev => prev.filter(c => c.name !== deletingCollection.name));
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
          <div className="w-full max-w-5xl mx-auto">
            <div className={`flex justify-between items-center mt-6 ${showNewCollection ? "opacity-50 pointer-events-none" : ""}`}>
              <h1 className="text-[26px] font-display text-gray-700 dark:text-gray-100 tracking-wider">
                KNOWLEDGE MANAGEMENT
              </h1>
              <div className="flex items-center gap-4">
                <Search className="text-gray-400 h-6 w-6" />
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
            {showNewCollection && (
              <div className="mt-8">
                <div className="flex justify-between items-center mb-4">
                  <div className="w-1/3">
                    <label
                      htmlFor="collectionName"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      {addingToCollection ? "Adding to collection" : "Collection name"}
                    </label>
                    <Input
                      id="collectionName"
                      type="text"
                      placeholder="Frontend documentation"
                      value={collectionName}
                      onChange={(e) => setCollectionName(e.target.value)}
                      className="w-full bg-transparent border-0 border-b border-gray-300 dark:border-gray-600 rounded-none px-0 py-2 ring-0 outline-0 shadow-none focus:ring-0 focus:outline-0 focus:border-b-2 transition-colors duration-200"
                      disabled={isUploading || !!addingToCollection}
                    />
                    {collections.some((c) => c.name.toLowerCase() === collectionName.trim().toLowerCase() && !addingToCollection) && (
                      <p className="text-sm text-red-500 mt-1">Collection name already exists.</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    onClick={handleCloseModal}
                    className="flex items-center gap-2 text-gray-500 dark:text-gray-400"
                  >
                    <X size={16} />
                    DISCARD CHANGES
                  </Button>
                </div>
                <KbFileUpload
                  onFilesSelect={handleFilesSelect}
                  onRemoveFile={handleRemoveFile}
                  onRemoveAllFiles={handleRemoveAllFiles}
                  selectedFiles={selectedFiles}
                  onUpload={addingToCollection ? handleAddFilesToCollection : handleUpload}
                  isUploading={isUploading}
                  collectionName={collectionName}
                />
              </div>
            )}
            <div
              className={`mt-12 ${showNewCollection ? "opacity-50 pointer-events-none" : ""}`}
            >
              {collections.map((collection, index) => (
                <div key={index} className="mb-8">
                  <div className="flex justify-between items-center mb-4 cursor-pointer" onClick={async () => {
                      const updatedCollections = [...collections];
                      const coll = updatedCollections.find(c => c.id === collection.id);
                      if (coll) {
                        coll.isOpen = !coll.isOpen;
                        if (coll.isOpen) {
                          const response = await fetch(`/api/v1/kb/collections/${collection.id}/folders`);
                          const data = await response.json();
                          coll.items = buildFileTree(data);
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
                          const updatedCollections = [...collections];
                          const coll = updatedCollections.find(c => c.id === collection.id);
                          if (coll) {
                            const toggleNode = (nodes: FileNode[]): FileNode[] => {
                              return nodes.map(n => {
                                if (n === node) {
                                  n.isOpen = !n.isOpen;
                                } else if (n.children) {
                                  n.children = toggleNode(n.children);
                                }
                                return n;
                              });
                            };
                            coll.items = toggleNode(coll.items);
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg">
            <h2 className="text-lg font-semibold mb-4">Edit Collection Name</h2>
            <Input
              type="text"
              value={collectionName}
              onChange={(e) => setCollectionName(e.target.value)}
              className="w-full"
            />
            <div className="flex justify-end gap-4 mt-4">
              <Button variant="ghost" onClick={() => setEditingCollection(null)}>Cancel</Button>
              <Button onClick={handleUpdateCollection}>Update</Button>
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
