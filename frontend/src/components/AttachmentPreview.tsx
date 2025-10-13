import React, { useState } from "react"
import { AttachmentMetadata } from "shared/types"
import {
  Eye,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getFileType } from "shared/fileUtils"
import { getFileIcon } from "@/components/ChatBox"

interface AttachmentPreviewProps {
  attachment: AttachmentMetadata
  className?: string
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

  const isImage = attachment.isImage && !imageError
  const thumbnailUrl = attachment.thumbnailPath
    ? `/api/v1/attachments/${attachment.fileId}/thumbnail`
    : null

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
            {getFileIcon(getFileType({type: attachment.fileType, name: attachment.fileName}))}
          </div>
        )}
      </div>

      {/* File Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {attachment.fileName}
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {formatFileSize(attachment.fileSize)} • {getFileType({type: attachment.fileType, name: attachment.fileName})}
        </p>
      </div>

      {/* Actions */}
      {isImage && (
        <div className="flex items-center space-x-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleImageView}
              className="p-2"
              aria-label={`Preview ${attachment.fileName}`}
            >
              <Eye className="w-4 h-4" />
            </Button>
          </div>
      )}

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
