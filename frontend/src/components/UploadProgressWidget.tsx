import React, { useState } from 'react'
import { useUploadProgress } from '@/contexts/UploadProgressContext'
import { Button } from '@/components/ui/button'
import { X, ChevronUp, ChevronDown } from 'lucide-react'
import { ConfirmModal } from '@/components/ui/confirmModal'

type TabType = 'all' | 'uploaded' | 'failed'

export const UploadProgressWidget: React.FC = () => {
  const { currentUpload, cancelUpload } = useUploadProgress()
  const [isExpanded, setIsExpanded] = useState(false)
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('all')

  if (!currentUpload || !currentUpload.isUploading) {
    return null
  }

  const { collectionName, batchProgress } = currentUpload
  const progressPercentage = Math.round((batchProgress.current / batchProgress.total) * 100)

  const handleCancel = () => {
    setShowCancelModal(true)
  }

  const confirmCancel = () => {
    cancelUpload(currentUpload.id)
    setShowCancelModal(false)
  }

  return (
    <>
      {/* Main Upload Widget */}
      <div className="fixed bottom-6 right-6 z-50 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-700 rounded-3xl shadow-lg w-[480px]">
        {/* Header */}
        <div className="p-4 rounded-t-3xl">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <h3 className="font-medium font-mono text-gray-500 dark:text-gray-100 text-sm">
                  UPLOADING FILES ({batchProgress.current}/{batchProgress.total})
                </h3>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setIsExpanded(!isExpanded)}
                variant="ghost"
                size="sm"
                className="p-1 h-8 w-8"
              >
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronUp className="h-4 w-4" />
                )}
              </Button>
              <Button
                onClick={handleCancel}
                variant="ghost"
                size="sm"
                className="p-1 h-8 w-8 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
          
          {/* Progress Bar in Header */}
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-3">
            <div
              className="bg-gray-500 h-2 rounded-full transition-all duration-300 ease-out"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          
          {/* Collection name and percentage - Always visible below progress bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-sm text-gray-700 dark:text-gray-300 truncate font-medium">
                {collectionName}
              </span>
            </div>
            <div className="flex-shrink-0">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {progressPercentage}%
              </span>
            </div>
          </div>
        </div>

        {/* Tabbed File List - Only shown when expanded */}
        {isExpanded && currentUpload.files && (
          <div className="px-2 pb-2">
            <div className="border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
              {/* Tab Navigation */}
              <div className="px-4 pt-4 pb-2">
                <div className="flex space-x-6">
                  <button
                    onClick={() => setActiveTab('all')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      activeTab === 'all'
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                    }`}
                  >
                    All files
                  </button>
                  <button
                    onClick={() => setActiveTab('uploaded')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      activeTab === 'uploaded'
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                    }`}
                  >
                    Uploaded
                  </button>
                  <button
                    onClick={() => setActiveTab('failed')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                      activeTab === 'failed'
                        ? 'bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                    }`}
                  >
                    Failed
                  </button>
                </div>
              </div>

              {/* File List */}
              <div className="flex-1 overflow-y-auto px-4 pb-4 h-52">
                {(() => {
                  const filteredFiles = currentUpload.files.filter(file => {
                    if (activeTab === 'uploaded') return file.status === 'uploaded'
                    if (activeTab === 'failed') return file.status === 'failed'
                    return true // 'all' shows everything
                  })

                  if (filteredFiles.length === 0) {
                    return (
                      <div className="text-center text-gray-500 dark:text-gray-400 text-sm py-4">
                        {activeTab === 'uploaded' && 'No files uploaded yet'}
                        {activeTab === 'failed' && 'No failed files'}
                        {activeTab === 'all' && 'No files'}
                      </div>
                    )
                  }

                  return filteredFiles.map((file) => (
                    <div key={file.id} className="flex items-center gap-3 py-3">
                      {/* Status Icon */}
                      <div className="flex-shrink-0">
                        <div className="w-6 h-6 bg-gray-200 dark:bg-gray-600 rounded-sm flex items-center justify-center">
                          {(file.status === 'pending' || file.status === 'uploading') && (
                            <div className="w-3 h-3 bg-gray-400 rounded-full animate-pulse"></div>
                          )}
                          {file.status === 'uploaded' && (
                            <svg width="14" height="10" viewBox="0 0 14 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M1 5L5 9L13 1" stroke="#10B981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                          {file.status === 'failed' && (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <path d="M3 3L11 11M11 3L3 11" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          )}
                        </div>
                      </div>

                      {/* File Info */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                          {file.name}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                        {file.status === 'failed' && file.error && (
                          <p className="text-xs text-red-500 dark:text-red-400 truncate">
                            {file.error}
                          </p>
                        )}
                      </div>
                    </div>
                  ))
                })()}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Cancel Confirmation Modal */}
      <ConfirmModal
        showModal={showCancelModal}
        setShowModal={(val) => setShowCancelModal(val.open ?? false)}
        modalTitle="Cancel upload?"
        modalMessage="Your upload is not complete. Would you like to cancel the upload?"
        onConfirm={confirmCancel}
      />
    </>
  )
}

export default UploadProgressWidget
