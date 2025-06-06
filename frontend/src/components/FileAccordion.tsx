import { useState, useEffect } from "react"
import {
  FileText,
  ChevronLeft,
  ChevronRight as ChevronRightArrow,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/api"
interface FileItem {
  docId?: string
  fileName: string
  createdAt: number
  fileSize?: number
}

interface FileAccordionProps {
  className?: string
  activeDataSourceName?: string | null
}

export default function FileAccordion({
  className = "",
  activeDataSourceName,
}: FileAccordionProps) {
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false) // Start with false, set to true when fetching
  const [error, setError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const filesPerPage = 10

  useEffect(() => {
    if (activeDataSourceName && activeDataSourceName.trim() !== "") {
      fetchFiles(activeDataSourceName)
    } else {
      setFiles([]) // Clear files if no active datasource
      setLoading(false)
      setError(null) // Or set a message like "No data source selected"
    }
  }, [activeDataSourceName]) // Re-fetch when activeDataSourceName changes

  const fetchFiles = async (dataSourceName: string) => {
    setLoading(true)
    setError(null)
    try {
      const response = await api.datasources[":dataSourceName"].files.$get({
        param: { dataSourceName },
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(errorText || "Failed to fetch files")
      }

      const data = await response.json()
      setFiles(data || []) // Assuming data is the array of files
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "An unexpected error occurred"
      setError(`Failed to fetch files: ${errorMessage}`)
      console.error("Error fetching files:", err)
      setFiles([]) // Clear files on error
    } finally {
      setLoading(false)
    }
  }

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return "Unknown size"
    if (bytes === 0) return "0 Bytes"
    const k = 1024
    const sizes = ["Bytes", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  }

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  // Calculate pagination
  const totalPages = Math.ceil(files.length / filesPerPage)
  const startIndex = (currentPage - 1) * filesPerPage
  const endIndex = Math.min(startIndex + filesPerPage, files.length)
  const currentFiles = files.slice(startIndex, endIndex)

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1)
    }
  }

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1)
    }
  }

  const renderPagination = () => {
    if (totalPages <= 1) return null

    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-600 mr-2">
          Page {currentPage} of {totalPages}
        </span>

        {currentPage > 1 && (
          <Button
            variant="outline"
            size="sm"
            onClick={handlePrevPage}
            className="flex items-center gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>Previous</span>
          </Button>
        )}

        {currentPage < totalPages && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            className="flex items-center gap-1"
          >
            <span>Next</span>
            <ChevronRightArrow className="h-4 w-4" />
          </Button>
        )}
      </div>
    )
  }

  if (loading) {
    return (
      <div className="w-full max-w-4xl mx-auto flex items-center justify-center min-h-[200px]">
        <div className="text-slate-600">Loading files...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="w-full max-w-4xl mx-auto flex items-center justify-center min-h-[200px]">
        <div className="text-red-600">{error}</div>
      </div>
    )
  }

  return (
    <div className={`w-full max-w-4xl mx-auto ${className}`}>
      <div className="w-full border rounded-lg">
        <div className="px-6 py-4 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <FileText className="h-5 w-5 text-slate-600" />
            <span className="text-lg font-medium">
              Files in {activeDataSourceName || "Selected Datasource"} (
              {files.length})
            </span>
          </div>

          {files.length > 0 && (
            <div className="flex items-center gap-4">
              <span className="text-sm text-slate-600">
                Records {startIndex + 1}-{endIndex} of {files.length}
              </span>
              {renderPagination()}
            </div>
          )}
        </div>

        <div className="px-6 pb-6">
          {!activeDataSourceName ? (
            <div className="min-h-[680px] flex items-center justify-center">
              <div className="text-center text-slate-500">
                Please select a data source to view files.
              </div>
            </div>
          ) : files.length === 0 && !loading ? (
            <div className="min-h-[680px] flex items-center justify-center">
              <div className="text-center text-slate-500">
                No files found in this datasource.
              </div>
            </div>
          ) : (
            <div className="min-h-[680px]">
              <div className="space-y-2">
                {currentFiles.map((file) => (
                  <div
                    key={`${file.fileName}-${file.createdAt}`}
                    className="flex items-center justify-between p-4 bg-slate-50 rounded-lg border hover:bg-slate-100 transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <FileText className="h-5 w-5 text-slate-600 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {file.fileName}
                        </p>
                        <p className="text-xs text-slate-500">
                          {formatFileSize(file.fileSize)} •{" "}
                          {formatDate(file.createdAt)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
