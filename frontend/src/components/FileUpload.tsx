import type React from "react"
import { useState, useRef, useCallback, useEffect } from "react"
import { Upload, Folder, File, X, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Input } from "@/components/ui/input"
import {
  generateFileId,
  createFileSelectionHandlers,
  validateAndDeduplicateFiles,
  createImagePreview,
  cleanupPreviewUrls,
} from "@/utils/fileUtils"
import { isValidFile } from "shared/fileUtils"
import { authFetch } from "@/utils/authFetch"

interface SelectedFile {
  file: File
  id: string
  preview?: string
}

interface FileUploadProps {
  onDatasourceCreated?: (datasourceName: string) => void
  initialDatasourceName?: string
  onUploadCompleted?: () => void // New prop to signal upload process finished
  existingDataSourceNames?: string[] // New prop for existing names
}

interface BatchProgress {
  currentFile: number
  totalFiles: number
  isProcessing: boolean
}

export default function FileUpload({
  onDatasourceCreated,
  initialDatasourceName = "",
  onUploadCompleted,
  existingDataSourceNames = [], // Default to empty array
}: FileUploadProps = {}) {
  const { toast } = useToast()
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [batchProgress, setBatchProgress] = useState<BatchProgress>({
    currentFile: 0,
    totalFiles: 0,
    isProcessing: false,
  })
  const [datasourceName, setDatasourceName] = useState(initialDatasourceName)
  const [datasourceNameError, setDatasourceNameError] = useState<string | null>(
    null,
  )
  const folderInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Configuration for batch processing
  const BATCH_CONFIG = {
    MAX_PAYLOAD_SIZE: 45 * 1024 * 1024,
    MIN_FILES_PER_BATCH: 1,
    MAX_FILES_PER_BATCH: 50,
  }

  const isEditingExisting = !!initialDatasourceName

  // Calculate FormData size estimation
  const estimateFormDataSize = (
    files: File[],
    datasourceName: string,
  ): number => {
    let size = 0

    // Add datasource name and flag overhead
    size += new TextEncoder().encode(datasourceName).length + 100
    size += 20

    // Add file sizes with FormData overhead
    files.forEach((file) => {
      size += file.size
      size += file.name.length * 2
      size += 200
    })

    return size
  }

  // Create batches based on payload size limit
  const createBatches = (files: SelectedFile[]): SelectedFile[][] => {
    const batches: SelectedFile[][] = []
    let currentBatch: SelectedFile[] = []
    let currentBatchSize = 0

    const baseOverhead = estimateFormDataSize([], datasourceName)

    for (const selectedFile of files) {
      const fileOverhead =
        selectedFile.file.size + selectedFile.file.name.length * 2 + 200
      const newBatchSize = currentBatchSize + fileOverhead

      // Check if adding this file would exceed the limit
      if (
        currentBatch.length > 0 &&
        (baseOverhead + newBatchSize > BATCH_CONFIG.MAX_PAYLOAD_SIZE ||
          currentBatch.length >= BATCH_CONFIG.MAX_FILES_PER_BATCH)
      ) {
        // Start a new batch
        batches.push([...currentBatch])
        currentBatch = [selectedFile]
        currentBatchSize = fileOverhead
      } else {
        // Add to current batch
        currentBatch.push(selectedFile)
        currentBatchSize = newBatchSize
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch)
    }

    return batches
  }

  const uploadBatch = async (
    batch: SelectedFile[],
    batchIndex: number,
    totalBatches: number,
  ): Promise<any> => {
    const formData = new FormData()
    formData.append("datasourceName", datasourceName.trim())
    formData.append("flag", isEditingExisting ? "addition" : "creation")
    formData.append("batchIndex", batchIndex.toString())
    formData.append("totalBatches", totalBatches.toString())

    batch.forEach((selectedFile) => {
      const fileName =
        selectedFile.file.name.split("/").pop()?.split("\\").pop() ||
        selectedFile.file.name
      formData.append("file", selectedFile.file, fileName)
    })

    const response = await authFetch("/api/v1/files/upload", {
      method: "POST",
      body: formData,
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(
        error.message || `Batch upload failed with status: ${response.status}`,
      )
    }

    return response.json()
  }

  const handleSubmit = useCallback(async () => {
    if (selectedFiles.length === 0 || !datasourceName.trim()) return

    setIsUploading(true)

    try {
      const batches = createBatches(selectedFiles)

      setBatchProgress({
        currentFile: 0,
        totalFiles: selectedFiles.length,
        isProcessing: true,
      })

      let allResults: any[] = []
      let totalProcessedFiles = 0
      let totalFailedFiles: any[] = []

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i]

        setBatchProgress((prev) => ({
          ...prev,
          currentFile: totalProcessedFiles + 1,
        }))

        try {
          const result = await uploadBatch(batch, i, batches.length)
          allResults.push(result)

          if (result.processedFiles) {
            totalProcessedFiles += result.processedFiles.length
          }
          if (result.failedFiles) {
            totalFailedFiles.push(...result.failedFiles)
          }

          setBatchProgress((prev) => ({
            ...prev,
            currentFile: totalProcessedFiles,
          }))

          if (i < batches.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
        } catch (error) {
          console.error(`Batch ${i + 1} failed:`, error)
          toast.error({
            title: `Batch ${i + 1} Failed`,
            description: `Error uploading batch ${i + 1} of ${batches.length}: ${
              typeof error === "object" && error && "message" in error
                ? (error as { message: string }).message
                : String(error)
            }`,
          })
        }
      }

      const hasSuccessfulUploads = totalProcessedFiles > 0

      if (hasSuccessfulUploads || totalFailedFiles.length > 0) {
        if (totalFailedFiles.length > 0) {
          totalFailedFiles.forEach(
            (failedFile: { name: string; error: string }) => {
              if (
                failedFile.error ===
                "Document already exists in this datasource."
              ) {
                toast.warning({
                  title: "File Skipped",
                  description: `File "${failedFile.name}" already exists and was not re-uploaded.`,
                })
              } else {
                toast.error({
                  title: "Upload Error",
                  description: `Could not upload "${failedFile.name}": ${failedFile.error}`,
                })
              }
            },
          )
        }

        if (hasSuccessfulUploads) {
          const message =
            batches.length > 1
              ? `Successfully uploaded ${totalProcessedFiles} files in ${batches.length} batches to datasource: ${datasourceName}`
              : `Successfully uploaded ${totalProcessedFiles} files to datasource: ${datasourceName}`

          toast.success({
            title: "Upload Completed",
            description: message,
          })
        }

        setSelectedFiles([])

        if (onDatasourceCreated && !isEditingExisting && hasSuccessfulUploads) {
          onDatasourceCreated(datasourceName)
        }
        if (onUploadCompleted) {
          onUploadCompleted()
        }
      } else {
        toast.error({
          title: "Upload Failed",
          description: "No files were successfully uploaded.",
        })
      }
    } catch (error) {
      console.error("Upload error:", error)
      toast.error({
        title: "Upload Failed",
        description: "An unexpected error occurred during upload. Please try again.",
      })
    } finally {
      setIsUploading(false)
      setBatchProgress({
        currentFile: 0,
        totalFiles: 0,
        isProcessing: false,
      })
    }
  }, [
    selectedFiles,
    toast,
    datasourceName,
    onDatasourceCreated,
    onUploadCompleted,
    isEditingExisting,
  ])

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      const validFiles = validateAndDeduplicateFiles(files, toast)
      if (validFiles.length === 0) return

      // Create selected file objects from unique files
      const newFiles: SelectedFile[] = validFiles.map((file) => ({
        file,
        id: generateFileId(),
        preview: createImagePreview(file),
      }))

      // Check if any files with the same name already exist in selectedFiles
      setSelectedFiles((prev) => {
        const existingFileNames = new Set(prev.map((f) => f.file.name))
        const filteredNewFiles = newFiles.filter(
          (f) => !existingFileNames.has(f.file.name),
        )

        // If we filtered any files due to existing names, notify the user
        const filteredCount = newFiles.length - filteredNewFiles.length
        if (filteredCount > 0) {
          toast.warning({
            title: "Files already selected",
            description: `${filteredCount} file(s) were already selected and skipped.`,
          })
        }

        return [...prev, ...filteredNewFiles]
      })
    },
    [toast],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()

      const items = Array.from(e.dataTransfer.items)
      const files: File[] = []
      let totalItems = 0

      // Process files from drop event
      const processEntry = async (entry: FileSystemEntry) => {
        totalItems++

        if (entry.name.startsWith(".")) {
          return
        }

        if (entry.isFile) {
          const fileEntry = entry as FileSystemFileEntry
          return new Promise<void>((resolve) => {
            fileEntry.file((file) => {
              if (isValidFile(file)) {
                files.push(file)
              }
              resolve()
            })
          })
        } else if (entry.isDirectory) {
          const dirEntry = entry as FileSystemDirectoryEntry
          const reader = dirEntry.createReader()
          return new Promise<void>((resolve) => {
            reader.readEntries(async (entries) => {
              await Promise.all(entries.map(processEntry))
              resolve()
            })
          })
        }
      }

      Promise.all(
        items.map((item) => {
          const entry = item.webkitGetAsEntry()
          return entry ? processEntry(entry) : Promise.resolve()
        }),
      ).then(() => {
        if (files.length > 0) {
          processFiles(files)
        }

        // Show warning if any files were ignored due to size
        if (files.length === 0 && totalItems > 0) {
          toast.error({
            title: "No valid files found",
            description: "Files must be under 40MB. All oversized files were ignored.",
          })
        }
      })
    },
    [processFiles, toast, isValidFile],
  )

  const handleFolderSelect = useCallback(() => {
    folderInputRef.current?.click()
  }, [])

  const { handleFileSelect, handleFileChange } = createFileSelectionHandlers(
    fileInputRef,
    processFiles,
  )

  const handleFolderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        processFiles(files)
      }
      // Reset the input value so the same folder can be selected again
      e.target.value = ""
    },
    [processFiles],
  )

  const removeFile = useCallback((id: string) => {
    setSelectedFiles((prev) => {
      const fileToRemove = prev.find((f) => f.id === id)
      if (fileToRemove?.preview) {
        URL.revokeObjectURL(fileToRemove.preview)
      }
      return prev.filter((f) => f.id !== id)
    })
  }, [])

  const removeAllFiles = useCallback(() => {
    setSelectedFiles((prev) => {
      const previewUrls = prev.map((f) => f.preview).filter(Boolean) as string[]
      cleanupPreviewUrls(previewUrls)
      return []
    })
  }, [])

  // Cleanup preview URLs when component unmounts
  const selectedFilesRef = useRef(selectedFiles)
  selectedFilesRef.current = selectedFiles

  useEffect(() => {
    return () => {
      const previewUrls = selectedFilesRef.current
        .map((f) => f.preview)
        .filter(Boolean) as string[]
      cleanupPreviewUrls(previewUrls)
    }
  }, [])

  return (
    <div className="w-full">
      {/* Remove the header text for existing datasources */}
      {!isEditingExisting && (
        <div className="text-center mb-4">
          <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-200">
            Upload Text Files
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Supported formats include text, image, CSV, PDF, Word, Excel, and
            PowerPoint files (max 40MB per file).
          </p>
        </div>
      )}

      {/* Only show datasource input field when creating a new datasource */}
      {!isEditingExisting && (
        <div className="mb-4">
          <label
            htmlFor="datasourceName"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Datasource Name <span className="text-red-500">*</span>
          </label>
          <Input
            id="datasourceName"
            type="text"
            placeholder="Enter datasource name"
            value={datasourceName}
            onChange={(e) => {
              const newName = e.target.value
              setDatasourceName(newName)
              if (
                !isEditingExisting &&
                existingDataSourceNames.some(
                  (existingName) =>
                    existingName.toLowerCase() === newName.trim().toLowerCase(),
                )
              ) {
                setDatasourceNameError(
                  "Datasource name already exists. Please choose a different name.",
                )
              } else {
                setDatasourceNameError(null)
              }
            }}
            className={`w-full ${datasourceNameError ? "border-red-500 focus:border-red-500 focus:ring-red-500" : ""}`}
          />
          {datasourceNameError && !isEditingExisting && (
            <p className="mt-1 text-xs text-red-600">{datasourceNameError}</p>
          )}
        </div>
      )}

      {/* Progress Indicator */}
      {batchProgress.isProcessing && (
        <div className="mb-4 p-3 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Processing...
            </span>
            <span className="text-sm text-slate-600 dark:text-slate-300">
              {batchProgress.currentFile} / {batchProgress.totalFiles} files
            </span>
          </div>
          <div className="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-2">
            <div
              className="bg-slate-600 dark:bg-slate-400 h-2 rounded-full transition-all duration-300"
              style={{
                width: `${(batchProgress.currentFile / batchProgress.totalFiles) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      <div
        className="relative transition-colors flex flex-col items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className={`border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-lg p-8 w-full mx-auto h-72 min-h-72 flex flex-col items-center justify-center transition-colors relative bg-gray-50 dark:bg-slate-800 ${
            isUploading
              ? "cursor-not-allowed"
              : "cursor-pointer hover:border-gray-400 dark:hover:border-gray-500"
          }`}
          onClick={isUploading ? undefined : handleFileSelect}
        >
          {selectedFiles.length > 0 && (
            <Button
              onClick={(e) => {
                e.stopPropagation()
                removeAllFiles()
              }}
              disabled={isUploading}
              className="absolute top-2 right-5 flex items-center space-x-1 bg-gray-800 dark:bg-slate-600 hover:bg-gray-900 dark:hover:bg-slate-500 text-white dark:text-gray-200 h-9 px-3"
            >
              <Trash2 className="w-4 h-4" />
              <span>Clear All</span>
            </Button>
          )}

          <div className="flex flex-col items-center justify-center w-full h-full">
            {selectedFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full w-full">
                <Upload className="w-16 h-16 text-gray-400 dark:text-gray-500 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Drag-drop or click here to select
                </h3>
                {isEditingExisting && (
                  <div className="text-center mt-2">
                    <p className="text-gray-600 dark:text-gray-400">
                      Upload More Files
                    </p>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Supported formats include text, CSV, PDF, Word, Excel, and
                      PowerPoint files (max 40MB per file).
                    </p>
                  </div>
                )}
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
                        {!isUploading && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              removeFile(selectedFile.id)
                            }}
                            className="absolute -top-2 -right-2 w-5 h-5 bg-gray-800 dark:bg-slate-600 text-white dark:text-gray-200 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:bg-black dark:hover:bg-slate-500"
                            title="Remove file"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}

                        <div className="flex flex-col items-center justify-center w-full">
                          {selectedFile.preview ? (
                            <img
                              src={selectedFile.preview}
                              alt={selectedFile.file.name}
                              className="w-12 h-12 object-cover rounded border border-gray-200 dark:border-gray-600"
                            />
                          ) : (
                            <File className="w-6 h-6 text-gray-500 dark:text-gray-400" />
                          )}
                          <div className="w-full text-center mt-1">
                            <p
                              className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate max-w-full px-1"
                              title={selectedFile.file.name}
                            >
                              {selectedFile.file.name.length > 16
                                ? `${selectedFile.file.name.substring(0, 13)}...`
                                : selectedFile.file.name}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">
                              {Math.round(selectedFile.file.size / 1024)} KB
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
                  handleFolderSelect()
                }}
                variant="outline"
                disabled={isUploading}
                className="flex items-center space-x-2 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600"
              >
                <Folder className="w-4 h-4" />{" "}
                {/* Icon color will inherit from text-gray-700 dark:text-gray-200 */}
                <span>Select Folder</span>
              </Button>
            </div>

            {selectedFiles.length > 0 && (
              <div className="text-sm text-gray-600 dark:text-gray-400">
                {selectedFiles.length} file
                {selectedFiles.length !== 1 ? "s" : ""} selected
              </div>
            )}

            <Button
              onClick={(e) => {
                e.stopPropagation()
                handleSubmit()
              }}
              disabled={
                selectedFiles.length === 0 ||
                !datasourceName.trim() ||
                isUploading ||
                !!datasourceNameError // Disable if there's a name error
              }
              className={`flex items-center space-x-2 mr-4 ${
                !datasourceName.trim() || !!datasourceNameError // Also consider name error for styling
                  ? "bg-gray-400 text-gray-100 dark:bg-gray-700 dark:text-gray-400 cursor-not-allowed" // Disabled-like style
                  : "bg-primary text-primary-foreground shadow hover:bg-primary/90" // Active style using primary button theme
              } h-9 px-4`}
            >
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  <span>Uploading...</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  <span>Upload</span>
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Hidden inputs for file selection */}
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-ignore - webkitdirectory is a non-standard attribute
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={handleFolderChange}
          accept=".txt,.md,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,image/jpeg,image/jpg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
          accept=".txt,.md,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,image/jpeg,image/jpg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv"
        />
      </div>
    </div>
  )
}
