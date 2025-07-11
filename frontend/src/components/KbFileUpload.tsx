import { useState, useCallback, useRef, ChangeEvent } from "react"
import { Upload, Folder, File as FileIcon, X, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"

export interface SelectedFile {
  file: File
  id: string
  preview?: string
}

interface KbFileUploadProps {
  onFilesSelect: (files: File[]) => void;
  onRemoveFile: (id: string) => void;
  onRemoveAllFiles: () => void;
  selectedFiles: SelectedFile[];
  onUpload: () => void;
  isUploading?: boolean;
  collectionName: string;
}

const KbFileUpload = ({
  onFilesSelect,
  onRemoveFile,
  onRemoveAllFiles,
  selectedFiles,
  onUpload,
  isUploading = false,
  collectionName,
}: KbFileUploadProps) => {
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isUploading) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isUploading) {
      setIsDragging(false)
    }
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)

      if (isUploading) return

      const traverseFileTree = (entry: any, path: string): Promise<File[]> => {
        return new Promise((resolve, reject) => {
          if (entry.isFile) {
            entry.file(
              (file: File) => {
                if (!file.name.startsWith(".")) {
                  try {
                    Object.defineProperty(file, "webkitRelativePath", {
                      value: path + file.name,
                      writable: true,
                      configurable: true,
                    })
                  } catch (err) {
                    console.warn(
                      `Could not set webkitRelativePath for ${file.name}`,
                      err,
                    )
                  }
                  resolve([file])
                } else {
                  resolve([])
                }
              },
              (err: any) => reject(err),
            )
          } else if (entry.isDirectory) {
            const dirReader = entry.createReader()
            const allEntries: any[] = []
            const readAllEntries = () => {
              dirReader.readEntries(
                async (entries: any[]) => {
                  if (entries.length > 0) {
                    allEntries.push(...entries)
                    readAllEntries() // read next batch
                  } else {
                    // all entries read
                    const promises = allEntries
                      .filter((e: any) => !e.name.startsWith("."))
                      .map((subEntry: any) =>
                        traverseFileTree(subEntry, path + entry.name + "/"),
                      )
                    try {
                      const filesArrays = await Promise.all(promises)
                      resolve(filesArrays.flat())
                    } catch (err) {
                      reject(err)
                    }
                  }
                },
                (err: any) => reject(err),
              )
            }
            readAllEntries()
          } else {
            resolve([])
          }
        })
      }

      const items = e.dataTransfer.items
      const filePromises: Promise<File[]>[] = []

      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.kind === "file") {
          const entry = item.webkitGetAsEntry()
          if (entry && !entry.name.startsWith(".")) {
            filePromises.push(traverseFileTree(entry, ""))
          }
        }
      }

      Promise.all(filePromises)
        .then((filesArrays) => {
          onFilesSelect(filesArrays.flat())
        })
        .catch((err) => {
          console.error("Error traversing file tree:", err)
        })
    },
    [onFilesSelect, isUploading],
  )

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (isUploading) return
    
    if (e.target.files) {
      const filteredFiles = Array.from(e.target.files).filter(
        (file) => !file.name.startsWith("."),
      )
      onFilesSelect(filteredFiles)
    }
    // Reset input value to allow selecting the same file again
    e.target.value = ""
  }

  const handleFolderChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (isUploading) return
    
    if (e.target.files) {
      const filteredFiles = Array.from(e.target.files).filter(
        (file: File) => !file.name.startsWith("."),
      )
      onFilesSelect(filteredFiles)
    }
    // Reset input value to allow selecting the same folder again
    e.target.value = ""
  }

  const handleFolderClick = () => {
    if (!isUploading) {
      folderInputRef.current?.click()
    }
  }

  const handleFileClick = () => {
    if (!isUploading) {
      fileInputRef.current?.click()
    }
  }

  return (
    <div className="w-full">
      <div
        className="relative transition-colors flex flex-col items-center justify-center"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div
          className={`border-2 border-dashed rounded-lg p-8 w-full mx-auto h-72 min-h-72 flex flex-col items-center justify-center transition-colors relative ${
            isDragging
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/10"
              : "border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-slate-800 hover:border-gray-400 dark:hover:border-gray-500"
          } ${isUploading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
          onClick={!isUploading ? handleFileClick : undefined}
        >
          {selectedFiles.length > 0 && (
            <Button
              onClick={(e) => {
                e.stopPropagation()
                onRemoveAllFiles()
              }}
              className="absolute top-2 right-5 flex items-center space-x-1 bg-gray-800 dark:bg-slate-600 hover:bg-gray-900 dark:hover:bg-slate-500 text-white dark:text-gray-200 h-9 px-3"
            >
              <Trash2 className="w-4 h-4" />
              <span>Clear All</span>
            </Button>
          )}

          <div className="flex flex-col items-center justify-center w-full h-full">
            {selectedFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full w-full text-center">
                <Upload className="w-16 h-16 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Drag & drop files or folders here
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  or click to select files
                </p>
              </div>
            ) : (
              <div className="h-full w-full flex flex-col items-center justify-center">
                <div
                  className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3 w-full overflow-y-auto p-4 h-full"
                  style={{ maxHeight: "calc(100% - 60px)" }}
                >
                  {selectedFiles.map((selectedFile) => (
                    <div key={selectedFile.id} className="relative group">
                      <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-1.5 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors hover:shadow-sm flex flex-col items-center justify-between min-h-[70px]">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            onRemoveFile(selectedFile.id)
                          }}
                          className="absolute -top-2 -right-2 w-5 h-5 bg-gray-800 dark:bg-slate-600 text-white dark:text-gray-200 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-black dark:hover:bg-slate-500"
                          title="Remove file"
                        >
                          <X className="w-3 h-3" />
                        </button>

                        <div className="flex flex-col items-center justify-center w-full">
                          <FileIcon className="w-8 h-8 text-gray-500" />
                          <div className="w-full text-center mt-1">
                            <p
                              className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate max-w-full px-1"
                              title={selectedFile.file.name}
                            >
                              {selectedFile.file.name.length > 16
                                ? `${selectedFile.file.name.substring(
                                    0,
                                    13,
                                  )}...`
                                : selectedFile.file.name}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {(selectedFile.file.size / 1024).toFixed(2)} KB
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-between items-center w-full mt-4 px-2 absolute bottom-4 left-0 right-0">
            <div className="flex items-center space-x-2 ml-4">
              <Button
                onClick={(e) => {
                  e.stopPropagation()
                  handleFolderClick()
                }}
                variant="outline"
                disabled={isUploading}
                className="flex items-center space-x-2 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Folder className="w-4 h-4" />
                <span>Select Folder</span>
              </Button>
            </div>

            {selectedFiles.length > 0 && (
              <div className="text-sm text-gray-600 dark:text-gray-400 mr-4">
                {selectedFiles.length} file
                {selectedFiles.length !== 1 ? "s" : ""} selected
              </div>
            )}

            <Button
              onClick={(e) => {
                e.stopPropagation()
                onUpload()
              }}
              disabled={
                selectedFiles.length === 0 ||
                isUploading ||
                !collectionName.trim()
              }
              className="flex items-center space-x-2 mr-4 bg-primary text-primary-foreground shadow hover:bg-primary/90 h-9 px-4 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Upload className="w-4 h-4" />
              <span>{isUploading ? "Uploading..." : "Upload"}</span>
            </Button>
          </div>
        </div>

        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          multiple
          onChange={handleFileChange}
        />
        <input
          type="file"
          ref={folderInputRef}
          className="hidden"
          multiple
          {...{
            directory: "",
            webkitdirectory: "",
          }}
          onChange={handleFolderChange}
        />
      </div>
    </div>
  )
}

export default KbFileUpload
