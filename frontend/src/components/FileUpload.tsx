import type React from "react"
import { useState, useRef, useCallback } from "react"
import { Upload, Folder, File, X, Trash2, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { Input } from "@/components/ui/input"
import { isValidFile } from "../../../shared/filesutils"

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

export default function FileUpload({
  onDatasourceCreated,
  initialDatasourceName = "",
  onUploadCompleted,
  existingDataSourceNames = [], // Default to empty array
}: FileUploadProps = {}) {
  const { toast } = useToast()
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)
  const [datasourceName, setDatasourceName] = useState(initialDatasourceName)
  const [datasourceNameError, setDatasourceNameError] = useState<string | null>(
    null,
  )
  const folderInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Check if we're editing an existing datasource
  const isEditingExisting = !!initialDatasourceName

  const showToast = useCallback(
    (title: string, description: string, isError = false) => {
      const { dismiss } = toast({
        title,
        description,
        variant: isError ? "destructive" : "default",
        duration: 2000, // Auto dismiss after 2 seconds
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

  const generateId = () => Math.random().toString(36).substring(2, 9)

  // Original processFiles function without path handling
  const processFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files)
      const validFiles = fileArray.filter(isValidFile)
      const invalidFiles = fileArray.length - validFiles.length

      if (invalidFiles > 0) {
        showToast(
          "Invalid file(s)",
          `${invalidFiles} file(s) ignored. Files must be under 15MB and of supported types.`,
          true,
        )
      }

      if (validFiles.length === 0) return

      // Create a map to track files by name for deduplication
      const fileMap = new Map<string, File>()
      let duplicateCount = 0

      // Keep only the first occurrence of each filename
      validFiles.forEach((file) => {
        if (!fileMap.has(file.name)) {
          fileMap.set(file.name, file)
        } else {
          duplicateCount++
        }
      })

      // Notify about duplicates if any were found
      if (duplicateCount > 0) {
        showToast(
          "Duplicate files",
          `${duplicateCount} duplicate file(s) were ignored.`,
          false,
        )
      }

      // Create selected file objects from unique files
      const uniqueFiles = Array.from(fileMap.values())
      const newFiles: SelectedFile[] = uniqueFiles.map((file) => ({
        file,
        id: generateId(),
        preview: undefined,
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
          showToast(
            "Files already selected",
            `${filteredCount} file(s) were already selected and skipped.`,
            false,
          )
        }

        return [...prev, ...filteredNewFiles]
      })
    },
    [showToast],
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
          showToast(
            "No valid files found",
            "Files must be under 15MB. All oversized files were ignored.",
            true,
          )
        }
      })
    },
    [processFiles, showToast, isValidFile],
  )

  const handleFolderSelect = useCallback(() => {
    folderInputRef.current?.click()
  }, [])

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        processFiles(files)
      }
      // Reset the input value so the same file can be selected again
      e.target.value = ""
    },
    [processFiles],
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
      const updated = prev.filter((f) => f.id !== id)
      return updated
    })
  }, [])

  const removeAllFiles = useCallback(() => {
    setSelectedFiles([])
  }, [])

  const handleSubmit = useCallback(async () => {
    if (selectedFiles.length === 0 || !datasourceName.trim()) return

    setIsUploading(true)

    try {
      const formData = new FormData()
      formData.append("datasourceName", datasourceName.trim())
      formData.append("flag", isEditingExisting ? "addition" : "creation")

      selectedFiles.forEach((selectedFile) => {
        const fileName =
          selectedFile.file.name.split("/").pop()?.split("\\").pop() ||
          selectedFile.file.name
        formData.append("file", selectedFile.file, fileName)
      })

      const response = await fetch("/api/v1/files/upload", {
        method: "POST",
        body: formData,
      })

      if (response.ok) {
        const result = await response.json()

        let overallSuccessMessage =
          result.message ||
          `${selectedFiles.length} file(s) processed for datasource: ${datasourceName}`
        let allFilesSkippedOrFailed = true

        if (result.processedFiles && result.processedFiles.length > 0) {
          allFilesSkippedOrFailed = false
        }

        if (result.failedFiles && result.failedFiles.length > 0) {
          let duplicateExists = false
          result.failedFiles.forEach(
            (failedFile: { name: string; error: string }) => {
              if (
                failedFile.error ===
                "Document already exists in this datasource."
              ) {
                showToast(
                  "File Skipped",
                  `File "${failedFile.name}" already exists and was not re-uploaded.`,
                  false,
                )
                duplicateExists = true
              } else {
                // Show error for other failed files
                showToast(
                  "Upload Error",
                  `Could not upload "${failedFile.name}": ${failedFile.error}`,
                  true,
                )
              }
            },
          )
          if (
            result.processedFiles &&
            result.processedFiles.length === 0 &&
            duplicateExists &&
            result.failedFiles.length === 1
          ) {
            // Special case: only one file was attempted, and it was a duplicate
            overallSuccessMessage = `File "${result.failedFiles[0].name}" already exists. No new files were uploaded.`
          } else if (
            result.processedFiles &&
            result.processedFiles.length === 0 &&
            result.failedFiles.length > 0
          ) {
            overallSuccessMessage =
              "No files were uploaded. See individual errors."
          }
        } else {
          // No failed files means all selected files were processed successfully
          allFilesSkippedOrFailed = false
        }

        if (!allFilesSkippedOrFailed) {
          showToast("Upload Processed", overallSuccessMessage)
        }

        setSelectedFiles([])

        if (onDatasourceCreated && !isEditingExisting && result.success) {
          onDatasourceCreated(datasourceName)
        }
        if (onUploadCompleted) {
          onUploadCompleted()
        }
      } else {
        const error = await response.json()
        showToast("Upload failed", error.message || "Please try again", true)
      }
    } catch (error) {
      console.error("Upload error:", error)
      showToast(
        "Upload failed",
        "An unexpected error occurred. Please try again.",
        true,
      )
    } finally {
      setIsUploading(false)
    }
  }, [
    selectedFiles,
    showToast,
    datasourceName,
    onDatasourceCreated,
    onUploadCompleted,
    isEditingExisting,
  ])

  return (
    <div className="w-full">
      {/* Remove the header text for existing datasources */}
      {!isEditingExisting && (
        <div className="text-center mb-4">
          <h2 className="text-xl font-semibold text-gray-700 dark:text-gray-200">
            Upload Text Files
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Supported formats include text, CSV, PDF, Word, Excel, and
            PowerPoint files (max 15MB per file).
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

      <div
        className="relative transition-colors flex flex-col items-center justify-center"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className="border-2 border-dashed border-gray-200 dark:border-gray-600 rounded-lg p-8 w-full mx-auto h-72 min-h-72 cursor-pointer flex flex-col items-center justify-center transition-colors hover:border-gray-400 dark:hover:border-gray-500 relative bg-gray-50 dark:bg-slate-800"
          onClick={handleFileSelect}
        >
          {selectedFiles.length > 0 && (
            <Button
              onClick={(e) => {
                e.stopPropagation()
                removeAllFiles()
              }}
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
                      PowerPoint files (max 15MB per file).
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

                        <div className="flex flex-col items-center justify-center w-full">
                          <File className="w-6 h-6 text-gray-500 dark:text-gray-400" />
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
          accept=".txt,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileChange}
          accept=".txt,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/csv"
        />
      </div>
    </div>
  )
}
