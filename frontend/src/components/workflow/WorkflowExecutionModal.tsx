import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { X, Upload } from "lucide-react"
import fileUpIcon from "@/assets/file-up.svg"
import checkCircleIcon from "@/assets/check-circle.svg"

interface WorkflowExecutionModalProps {
  isOpen: boolean
  onClose: () => void
  workflowName: string
  workflowDescription: string
  uploadApiUrl: string
}

const SUPPORTED_FILE_TYPES = {
  // Text files
  'text/plain': 'text',
  'text/csv': 'text',
  // Images
  'image/jpeg': 'image',
  'image/jpg': 'image', 
  'image/png': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  // Documents
  'application/pdf': 'PDF',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
}

const MAX_FILE_SIZE = 40 * 1024 * 1024 // 40MB

export function WorkflowExecutionModal({
  isOpen,
  onClose,
  workflowName,
  workflowDescription,
  uploadApiUrl
}: WorkflowExecutionModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [isUploaded, setIsUploaded] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isCompleted, setIsCompleted] = useState(false)
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const resetModalState = () => {
    setSelectedFile(null)
    setIsUploading(false)
    setIsUploaded(false)
    setUploadError(null)
    setIsProcessing(false)
    setIsCompleted(false)
    if (pollingInterval) {
      clearInterval(pollingInterval)
      setPollingInterval(null)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleClose = () => {
    resetModalState()
    onClose()
  }

  if (!isOpen) return null

  const validateFile = (file: File): string | null => {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return `File size exceeds 40MB limit. Current size: ${(file.size / 1024 / 1024).toFixed(1)}MB`
    }

    // Check file type
    if (!SUPPORTED_FILE_TYPES[file.type as keyof typeof SUPPORTED_FILE_TYPES]) {
      return `Unsupported file type: ${file.type}. Supported formats include text, image, CSV, PDF, Word, Excel, and PowerPoint files.`
    }

    return null
  }

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      const error = validateFile(file)
      if (error) {
        setUploadError(error)
        return
      }
      setUploadError(null)
      setSelectedFile(file)
      setIsUploaded(false)
    }
  }

  const uploadFile = async (file: File) => {
    setIsUploading(true)
    try {
      console.log('Uploading file to:', uploadApiUrl)
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch(uploadApiUrl, {
        method: 'POST',
        body: formData
      })

      console.log('Upload response status:', response.status)
      console.log('Upload response ok:', response.ok)

      if (response.ok) {
        setIsUploaded(true)
        // Start polling for completion
        startPolling()
      } else {
        setIsUploaded(false)
        setIsProcessing(false)
        const errorText = await response.text()
        console.error('Upload failed with status:', response.status, 'Error:', errorText)
        setUploadError(`Upload failed (${response.status}): ${errorText || 'Please try again.'}`)
      }
    } catch (error) {
      console.error('Upload error:', error)
      setIsUploaded(false)
      setIsProcessing(false)
      setUploadError(`Upload failed: ${error instanceof Error ? error.message : 'Please check your connection and try again.'}`)
    } finally {
      setIsUploading(false)
    }
  }

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) {
      const error = validateFile(file)
      if (error) {
        setUploadError(error)
        return
      }
      setUploadError(null)
      setSelectedFile(file)
      setIsUploaded(false)
    }
  }

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault()
  }

  const handleStartExecution = async () => {
    if (!selectedFile) return
    
    console.log('Starting execution for workflow:', workflowName)
    console.log('Selected file:', selectedFile.name)
    console.log('File size:', selectedFile.size, 'bytes')
    console.log('File type:', selectedFile.type)
    
    setIsProcessing(true)
    await uploadFile(selectedFile)
  }

  const handleDiscardFile = () => {
    setSelectedFile(null)
    setUploadError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleUploadAnother = () => {
    setSelectedFile(null)
    setIsUploaded(false)
    setIsProcessing(false)
    setIsCompleted(false)
    setUploadError(null)
    if (pollingInterval) {
      clearInterval(pollingInterval)
      setPollingInterval(null)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const startPolling = () => {
    console.log('Starting polling for process completion...')
    const interval = setInterval(async () => {
      try {
        const response = await fetch('http://localhost:8000/status', {
          method: 'GET',
        })
        
        if (response.ok) {
          const data = await response.json()
          console.log('Polling response:', data)
          
          if (data.status === 'completed' || data.message === 'process completed') {
            console.log('Process completed!')
            clearInterval(interval)
            setPollingInterval(null)
            setIsProcessing(false)
            setIsCompleted(true)
          }
        }
      } catch (error) {
        console.error('Polling error:', error)
      }
    }, 2000) // Poll every 2 seconds
    
    setPollingInterval(interval)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full mx-4 relative">
        {/* Close Button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-1 hover:bg-gray-100 rounded-full transition-colors z-10"
        >
          <X className="w-6 h-6 text-gray-500" />
        </button>

        {isCompleted ? (
          // Completion Page
          <>
            {/* Header */}
            <div className="p-8 pb-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 text-base">
                {workflowDescription}
              </p>
            </div>

            {/* Completion Content */}
            <div className="px-8 pb-8">
              <div className="border border-dashed border-gray-300 rounded-xl px-6 py-16 text-center bg-gray-50 w-full min-h-[280px] flex flex-col items-center justify-center">
                {/* Success Icon */}
                <div className="w-16 h-16 flex items-center justify-center mb-6">
                  <img src={checkCircleIcon} alt="Success" className="w-16 h-16" />
                </div>
                
                {/* Success Message */}
                <p className="text-gray-900 text-lg font-medium">Process completed successfully!</p>
              </div>
              
              {/* Upload Another Button */}
              <div className="flex justify-end mt-6">
                <Button
                  onClick={handleUploadAnother}
                  className="bg-black hover:bg-gray-800 text-white px-6 py-2 rounded-full font-medium"
                >
                  Upload Another
                </Button>
              </div>
            </div>
          </>
        ) : isProcessing ? (
          // Processing Page
          <>
            {/* Header */}
            <div className="p-8 pb-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 text-base">
                {workflowDescription}
              </p>
            </div>

            {/* Processing Content */}
            <div className="px-8 pb-8">
              <div className="border border-dashed border-gray-300 rounded-xl px-6 py-16 text-center bg-gray-50 w-full min-h-[280px] flex flex-col items-center justify-center">
                <div className="w-12 h-12 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin mb-6"></div>
                <p className="text-gray-900 text-lg font-medium mb-2">Processing the File</p>
              </div>
              
              {/* Executing Button */}
              <div className="flex justify-end mt-6">
                <Button
                  disabled
                  className="bg-gray-400 cursor-not-allowed text-gray-600 px-6 py-2 rounded-full font-medium"
                >
                  Executing...
                </Button>
              </div>
            </div>
          </>
        ) : (
          // Upload Page
          <>
            {/* Header */}
            <div className="p-8 pb-6">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 text-base">
                {workflowDescription}
              </p>
            </div>

        {/* File Upload Area */}
        <div className="px-8 pb-6">
          {selectedFile ? (
            // Selected File Display
            <div className="border border-dashed border-gray-300 rounded-xl px-6 py-16 text-center bg-gray-50 w-full min-h-[280px] flex flex-col items-center justify-center">
              <div className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-4 py-3 shadow-sm">
                <svg className="w-6 h-6 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <span className="text-gray-900 font-medium">{selectedFile.name}</span>
                <button
                  onClick={handleDiscardFile}
                  className="ml-2 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            // Upload Area
            <div
              className="border border-dashed border-gray-300 rounded-xl px-6 py-10 text-center cursor-pointer hover:border-gray-400 transition-colors bg-gray-50 w-full min-h-[280px]"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
            >
            <div className="flex flex-col items-center space-y-4">
              {/* File Icon */}
              <div className="w-16 h-16 flex items-center justify-center">
                <img src={fileUpIcon} alt="Upload" className="w-8 h-8" />
              </div>

              {/* Upload Button */}
              <Button 
                className="bg-gray-800 hover:bg-gray-700 text-white px-6 py-2 rounded-full font-mono font-medium text-xs leading-none tracking-wider uppercase"
                onClick={(e) => {
                  e.stopPropagation()
                  fileInputRef.current?.click()
                }}
              >
                <Upload className="w-4 h-4 mr-2" />
                UPLOAD FILE
              </Button>

              {/* Or text */}
              <p className="text-gray-600">or drag & drop files</p>

              {/* Supported formats */}
              <p className="text-gray-500 text-sm text-center leading-relaxed">
                Supported formats include text, image, CSV, PDF, Word, Excel, and PowerPoint files<br />
                (max 40MB per file).
              </p>
            </div>
          </div>
          )}
          
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            className="hidden"
            accept=".txt,.csv,.jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          />

          {/* Error Display */}
          {uploadError && (
            <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-800">{uploadError}</p>
            </div>
          )}
        </div>

            {/* Action Button */}
            <div className="px-8 pb-8">
              <div className="flex justify-end">
                <Button
                  onClick={handleStartExecution}
                  disabled={!selectedFile}
                  className={`px-6 py-2 rounded-full font-medium transition-all ${
                    selectedFile 
                      ? 'bg-black hover:bg-gray-800 text-white' 
                      : 'bg-gray-400 cursor-not-allowed text-gray-600'
                  }`}
                >
                  Start Execution
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}