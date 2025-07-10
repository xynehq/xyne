import React, { useState } from "react"
import { AttachmentMetadata } from "shared/types"
import {
  Download,
  Eye,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  File,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface AttachmentPreviewProps {
  attachment: AttachmentMetadata
  className?: string
}

const getFileIcon = (fileType: string) => {
  if (fileType.startsWith("image/")) return Image
  if (fileType.startsWith("video/")) return Video
  if (fileType.startsWith("audio/")) return Music
  if (fileType.includes("pdf") || fileType.includes("document")) return FileText
  if (
    fileType.includes("zip") ||
    fileType.includes("tar") ||
    fileType.includes("gz")
  )
    return Archive
  return File
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return "0 Bytes"
  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
}

export const AttachmentPreview: React.FC<AttachmentPreviewProps> = ({
  attachment,
  className = "",
}) => {
  const [showImageModal, setShowImageModal] = useState(false)
  const [imageError, setImageError] = useState(false)

  const FileIcon = getFileIcon(attachment.fileType)
  const isImage = attachment.isImage && !imageError
  const thumbnailUrl = attachment.thumbnailPath
    ? `/api/v1/attachments/${attachment.fileId}/thumbnail`
    : null

  const handleDownload = async () => {
    let url: string | null = null
    try {
      const response = await fetch(`/api/v1/attachments/${attachment.fileId}`, {
        credentials: "include",
      })
      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Please log in to download attachments")
        }
        throw new Error(`Download failed: ${response.statusText}`)
      }

      const blob = await response.blob()
      url = window.URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = attachment.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (error) {
      console.error("Download failed:", error)
      alert(error instanceof Error ? error.message : "Download failed")
    } finally {
      if (url) {
        window.URL.revokeObjectURL(url)
      }
    }
  }

  const handleImageView = () => {
    if (isImage) {
      setShowImageModal(true)
    }
  }

  const handleImageError = () => {
    setImageError(true)
  }

  return (
    <div
      className={`flex items-center space-x-3 p-3 border rounded-lg bg-gray-50 dark:bg-gray-800 dark:border-gray-700 ${className}`}
    >
      {/* Thumbnail or Icon */}
      <div className="flex-shrink-0">
        {isImage && thumbnailUrl ? (
          <div
            className="w-12 h-12 rounded-md overflow-hidden cursor-pointer hover:opacity-80 transition-opacity"
            onClick={handleImageView}
            role="button"
            tabIndex={0}
            aria-label={`Preview ${attachment.fileName}`}
          >
            <img
              src={thumbnailUrl}
              alt={attachment.fileName}
              className="w-full h-full object-cover"
              onError={handleImageError}
            />
          </div>
        ) : (
          <div className="w-12 h-12 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded-md">
            <FileIcon className="w-6 h-6 text-gray-600 dark:text-gray-400" />
          </div>
        )}
      </div>

      {/* File Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {attachment.fileName}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {formatFileSize(attachment.fileSize)} • {attachment.fileType}
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center space-x-2">
        {isImage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleImageView}
            className="p-2"
            aria-label={`Preview ${attachment.fileName}`}
          >
            <Eye className="w-4 h-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDownload}
          className="p-2"
          aria-label={`Download ${attachment.fileName}`}
        >
          <Download className="w-4 h-4" />
        </Button>
      </div>

      {/* Image Modal */}
      {isImage && (
        <Dialog open={showImageModal} onOpenChange={setShowImageModal}>
          <DialogContent className="max-w-4xl max-h-[90vh] p-0">
            <DialogHeader className="p-6 pb-2">
              <DialogTitle className="text-left">
                {attachment.fileName}
              </DialogTitle>
            </DialogHeader>
            <div className="px-6 pb-6">
              <img
                src={`/api/v1/attachments/${attachment.fileId}`}
                alt={attachment.fileName}
                className="w-full h-auto max-h-[70vh] object-contain rounded-lg"
                onError={handleImageError}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
