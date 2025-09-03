import React from "react"

interface FileUploadSkeletonProps {
  totalFiles: number
  processedFiles: number
  currentBatch: number
  totalBatches: number
}

const FileUploadSkeleton: React.FC<FileUploadSkeletonProps> = ({
  totalFiles,
  processedFiles,
  currentBatch,
  totalBatches,
}) => {
  // Show 3-4 skeleton rows
  const skeletonCount = Math.min(4, totalFiles - processedFiles)

  return (
    <div className="w-full">
      {/* Table header */}
      <div className="grid grid-cols-12 gap-4 text-sm text-gray-500 dark:text-gray-400 pb-2 border-b border-gray-200 dark:border-gray-700">
        <div className="col-span-5">FOLDER</div>
        <div className="col-span-2"></div>
        <div className="col-span-1 text-center">FILES</div>
        <div className="col-span-2">LAST UPDATED</div>
        <div className="col-span-2">UPDATED BY</div>
      </div>

      {/* Skeleton rows */}
      <div className="mt-2">
        {Array.from({ length: skeletonCount }).map((_, index) => (
          <div key={index} className="py-3 animate-pulse">
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full w-full"></div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default FileUploadSkeleton
