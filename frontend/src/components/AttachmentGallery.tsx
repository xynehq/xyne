import React, { useState } from "react"
import { AttachmentMetadata } from "shared/types"
import { AttachmentPreview } from "./AttachmentPreview"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight, X, Download } from "lucide-react"
import { authFetch } from "@/utils/authFetch"

interface AttachmentGalleryProps {
  attachments: AttachmentMetadata[]
  className?: string
  maxPreviewItems?: number
}

export const AttachmentGallery: React.FC<AttachmentGalleryProps> = ({
  attachments,
  className = "",
  maxPreviewItems = 3,
}) => {
  const [showGalleryModal, setShowGalleryModal] = useState(false)
  const [currentImageIndex, setCurrentImageIndex] = useState(0)

  if (!attachments || attachments.length === 0) {
    return null
  }

  const images = attachments.filter((att) => att.isImage)
  const otherFiles = attachments.filter((att) => !att.isImage)

  const handleImageGalleryOpen = (imageIndex: number) => {
    setCurrentImageIndex(imageIndex)
    setShowGalleryModal(true)
  }

  const nextImage = () => {
    setCurrentImageIndex((prev) => (prev + 1) % images.length)
  }

  const prevImage = () => {
    setCurrentImageIndex((prev) => (prev - 1 + images.length) % images.length)
  }

  const downloadCurrentImage = async () => {
    if (images[currentImageIndex]) {
      const attachment = images[currentImageIndex]
      try {
        const response = await authFetch(
          `/api/v1/attachments/${attachment.fileId}`,
          {
            credentials: "include",
          },
        )
        if (!response.ok) throw new Error("Download failed")

        const blob = await response.blob()
        const url = window.URL.createObjectURL(blob)
        const a = document.createElement("a")
        a.href = url
        a.download = attachment.fileName
        document.body.appendChild(a)
        a.click()
        window.URL.revokeObjectURL(url)
        document.body.removeChild(a)
      } catch (error) {
        console.error("Download failed:", error)
      }
    }
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Image Gallery Preview */}
      {images.length > 0 && (
        <div className="space-y-2 mt-2">
          {images.length === 1 ? (
            <div className="flex justify-end ml-auto w-fit">
              <div className="relative rounded-md overflow-hidden ml-auto">
                <img
                  src={`/api/v1/attachments/${images[0].fileId}`}
                  alt={images[0].fileName}
                  className="rounded-md shadow border border-gray-200 block ml-auto cursor-pointer hover:opacity-80 transition-opacity max-w-[50%] h-auto"
                  onClick={() => handleImageGalleryOpen(0)}
                />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-3 justify-end">
              {images.slice(0, maxPreviewItems).map((image, index) => (
                <div
                  key={image.fileId}
                  className="relative aspect-square rounded-lg overflow-hidden cursor-pointer hover:opacity-80 transition-opacity group"
                  onClick={() => handleImageGalleryOpen(index)}
                >
                  <img
                    src={`/api/v1/attachments/${image.fileId}/thumbnail`}
                    alt={image.fileName}
                    className="w-28 h-28 object-cover rounded-md shadow-sm border border-gray-200"
                  />
                  <div className="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-20 transition-opacity" />
                </div>
              ))}
              {images.length > maxPreviewItems && (
                <div
                  className="aspect-square rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                  onClick={() => handleImageGalleryOpen(0)}
                >
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                    +{images.length - maxPreviewItems} more
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Other Files */}
      {otherFiles.length > 0 && (
        <div className="space-y-1">
          <h4 className="flex flex-wrap justify-end text-xs font-medium text-gray-700 dark:text-gray-300">
            Files ({otherFiles.length})
          </h4>
          <div className="flex justify-end flex-wrap gap-2">
            {otherFiles.map((file) => (
              <AttachmentPreview
                key={file.fileId}
                attachment={file}
                className="w-[40%]"
              />
            ))}
          </div>
        </div>
      )}

      {/* Image Gallery Modal */}
      {images.length > 0 && (
        <Dialog open={showGalleryModal} onOpenChange={setShowGalleryModal}>
          <DialogContent className="max-w-6xl max-h-[95vh] p-0 overflow-hidden">
            <DialogHeader className="absolute top-0 left-0 right-0 z-10 bg-black bg-opacity-50 text-white p-4">
              <div className="flex items-center justify-between">
                <DialogTitle className="text-white">
                  {images[currentImageIndex]?.fileName} ({currentImageIndex + 1}{" "}
                  of {images.length})
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Image gallery viewer - {images.length} image
                  {images.length !== 1 ? "s" : ""} available
                </DialogDescription>
                <div className="flex items-center space-x-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={downloadCurrentImage}
                    className="text-white hover:bg-white hover:bg-opacity-20"
                  >
                    <Download className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowGalleryModal(false)}
                    className="text-white hover:bg-white hover:bg-opacity-20"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="relative h-[90vh] flex items-center justify-center bg-black">
              <img
                src={`/api/v1/attachments/${images[currentImageIndex]?.fileId}`}
                alt={images[currentImageIndex]?.fileName}
                className="max-w-full max-h-full object-contain"
              />

              {images.length > 1 && (
                <>
                  <Button
                    variant="ghost"
                    size="lg"
                    onClick={prevImage}
                    className="absolute left-4 top-1/2 transform -translate-y-1/2 text-white hover:bg-white hover:bg-opacity-20 bg-black bg-opacity-50 hover:bg-opacity-70 rounded-full p-2"
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="lg"
                    onClick={nextImage}
                    className="absolute right-4 top-1/2 transform -translate-y-1/2 text-white hover:bg-white hover:bg-opacity-20 bg-black bg-opacity-50 hover:bg-opacity-70 rounded-full p-2"
                  >
                    <ChevronRight className="w-6 h-6" />
                  </Button>
                </>
              )}
            </div>

            {/* Thumbnail strip */}
            {images.length > 1 && (
              <div className="absolute bottom-0 left-0 right-0 bg-black bg-opacity-75 p-4">
                <div className="flex space-x-2 justify-center overflow-x-auto">
                  {images.map((image, index) => (
                    <div
                      key={image.fileId}
                      className={`w-16 h-16 rounded cursor-pointer border-2 transition-all ${
                        index === currentImageIndex
                          ? "border-white"
                          : "border-transparent hover:border-gray-400"
                      }`}
                      onClick={() => setCurrentImageIndex(index)}
                    >
                      <img
                        src={`/api/v1/attachments/${image.fileId}/thumbnail`}
                        alt={image.fileName}
                        className="w-full h-full object-cover rounded"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
