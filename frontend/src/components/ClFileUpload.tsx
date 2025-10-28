import { useState, useCallback, useRef, ChangeEvent } from "react"
import { X, FileUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import FileUploadSkeleton from "@/components/FileUploadSkeleton"
import { isValidFile } from "../../../server/shared/fileUtils"
import { getFileIcon } from "@/lib/common"
import { SmartTooltip } from "./ui/smart-tooltip"

export interface SelectedFile {
  file: File
  id: string
  preview?: string
}

interface CollectionFileUploadProps {
  onFilesSelect: (files: File[]) => void
  onRemoveFile: (id: string) => void
  onRemoveAllFiles: () => void
  selectedFiles: SelectedFile[]
  onUpload: () => void
  isUploading?: boolean
  collectionName: string
  batchProgress?: {
    total: number
    current: number
    batch: number
    totalBatches: number
  }
}

const CollectionFileUpload = ({
  onFilesSelect,
  onRemoveFile,
  onRemoveAllFiles,
  selectedFiles,
  onUpload,
  isUploading = false,
  collectionName,
  batchProgress,
}: CollectionFileUploadProps) => {
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

      interface FileSystemEntry {
        isFile: boolean
        isDirectory: boolean
        name: string
        file?: (
          success: (file: File) => void,
          error: (err: Error) => void,
        ) => void
        createReader?: () => FileSystemDirectoryReader
      }

      interface FileSystemDirectoryReader {
        readEntries: (
          success: (entries: FileSystemEntry[]) => void,
          error: (err: Error) => void,
        ) => void
      }

      const traverseFileTree = (
        entry: FileSystemEntry,
        path: string,
      ): Promise<File[]> => {
        return new Promise((resolve, reject) => {
          if (entry.isFile) {
            entry.file?.(
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
              (err: Error) => reject(err),
            )
          } else if (entry.isDirectory) {
            const dirReader = entry.createReader?.()
            if (!dirReader) {
              resolve([])
              return
            }
            const allEntries: FileSystemEntry[] = []
            const readAllEntries = () => {
              dirReader.readEntries(
                async (entries: FileSystemEntry[]) => {
                  if (entries.length > 0) {
                    allEntries.push(...entries)
                    readAllEntries() // read next batch
                  } else {
                    // all entries read
                    const promises = allEntries
                      .filter((e) => !e.name.startsWith("."))
                      .map((subEntry) =>
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
                (err: Error) => {
                  console.error(`Error reading directory ${entry.name}:`, err)
                  reject(err)
                },
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

  // Calculate supported files count 
  const supportedFilesCount = selectedFiles.filter(f => isValidFile(f.file)).length

  // Show skeleton loader when uploading
  if (isUploading && batchProgress && batchProgress.total > 0) {
    return (
      <div className="w-full">
        <FileUploadSkeleton
          totalFiles={batchProgress.total}
          processedFiles={batchProgress.current}
          currentBatch={batchProgress.batch}
          totalBatches={batchProgress.totalBatches}
        />
      </div>
    )
  }
  const getTooltipContent=()=>{
    if(!collectionName.trim()){
      return "Enter collection name"
    }
    else if(isUploading){
      return "Uploading files..."
    }
    else{
      return "Add files to upload"
    }
  }


  return (
    <div className="w-full">
      {/* Buttons above the upload area */}
      <div className="flex items-center gap-4 mb-4">
        <Button
          onClick={(e) => {
            e.stopPropagation()
            handleFileClick()
          }}
          variant="outline"
          disabled={isUploading}
          className="flex-1 rounded-full text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ADD FILES
        </Button>
        <Button
          onClick={(e) => {
            e.stopPropagation()
            handleFolderClick()
          }}
          variant="outline"
          disabled={isUploading}
          className="flex-1 rounded-full text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          UPLOAD LARGE FOLDER
        </Button>
      </div>

      {/* Show drag & drop area only when no files are selected */}
      {selectedFiles.length === 0 && (
        <div
          className="relative transition-colors flex flex-col items-center justify-center"
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={handleFileClick}
        >
          <div
            className={`border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-lg p-8 w-full mx-auto h-80 min-h-80 flex flex-col items-center justify-center transition-colors relative bg-gray-50 dark:bg-slate-800 ${
              isDragging
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/10"
                : isUploading
                  ? "cursor-not-allowed"
                  : "hover:border-gray-400 dark:hover:border-gray-500 cursor-pointer"
            }`}
          >
            <div className="flex flex-col items-center justify-center w-full h-full">
              <div className="flex flex-col items-center justify-center h-full w-full text-center">
                <div className="w-20 h-20 bg-gray-200 dark:bg-gray-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <FileUp className="w-10 h-10 text-gray-600 dark:text-gray-400" />
                </div>
                <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Drag & drop files or folders here
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  or use the buttons above to select files
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {/* Upload Queue Section - only show when files are selected */}
      {selectedFiles.length > 0 && (
        <div 
          className={`mt-6 rounded-lg transition-colors ${isDragging ? 'ring-2 ring-gray-400' : ''}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <div className="bg-white dark:bg-slate-800 rounded-lg overflow-hidden h-80 flex flex-col">
            {/* Header */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-gray-100 dark:border-slate-700 flex-shrink-0">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 font-mono uppercase tracking-wider">
                UPLOAD QUEUE
              </h3>
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {supportedFilesCount} supported file{supportedFilesCount !== 1 ? "s" : ""}
              </span>
              <Button
                onClick={onRemoveAllFiles}
                variant="ghost"
                size="sm"
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-1 h-auto"
              >
                <X className="w-3 h-3 mr-1" />
                Clear All
              </Button>
            </div>

            {/* File List - scrollable with fixed height */}
            <div className="flex-1 overflow-y-auto min-h-0">
              {selectedFiles.map((selectedFile, index) => {
                const isSupported = isValidFile(selectedFile.file)
                
                return (
                  <div
                    key={selectedFile.id}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-slate-700/50 transition-colors group"
                  >
                    {/* File Icon */}
                    <div className="flex-shrink-0">
                      {getFileIcon(selectedFile.file)}
                    </div>

                    {/* File Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate" title={selectedFile.file.name}>
                          {selectedFile.file.name}
                        </p>
                      </div>
                      {!isSupported && (
                        <p className="text-xs font-medium text-red-600 dark:text-red-400">
                          UNSUPPORTED FORMAT
                        </p>
                      )}
                      {isSupported && (
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {(selectedFile.file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                      )}
                    </div>

                    {/* Remove Button */}
                    <div className="flex-shrink-0">
                      <Button
                        onClick={() => onRemoveFile(selectedFile.id)}
                        variant="ghost"
                        size="sm"
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 h-auto"
                        title="Remove file"
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Upload Button - sticks to bottom */}
            <div className="px-4 pt-4 pb-2 flex-shrink-0">
               { (() => {
              const isDisabled= selectedFiles.length === 0 || isUploading || !collectionName.trim()
              const tooltipContent= isDisabled ? getTooltipContent() : undefined
              
            const button=(  <Button
                onClick={(e) => {
                  e.stopPropagation()
                  onUpload()
                }}
                disabled={
                  isDisabled
                }
                className={`w-full bg-slate-800 hover:bg-slate-700 dark:bg-slate-600 dark:hover:bg-slate-500 text-white disabled:opacity-50 disabled:cursor-not-allowed rounded-full h-10 text-sm font-medium `}
                
                
              >
                {isUploading ? "Uploading..." : "UPLOAD ITEMS"}
              </Button>
            )
            return tooltipContent ? <SmartTooltip content={tooltipContent} className={`w-full block ${isDisabled ? 'cursor-not-allowed' : ''}`} >{button}</SmartTooltip> : button
              })()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default CollectionFileUpload
