import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { X, XCircle, FileText, AlertCircle } from "lucide-react"
import fileUpIcon from "@/assets/file-up.svg"
import checkCircleIcon from "@/assets/check-circle.svg"
import { workflowExecutionsAPI } from "./api/ApiHandlers"
import { api } from "../../api"
import { WorkflowExecutionModalProps } from "./Types"

const SUPPORTED_FILE_TYPES = {
  // Text files
  "text/plain": "text",
  // Documents
  "application/pdf": "PDF",
  "application/msword": "Word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
}

const MAX_FILE_SIZE = 40 * 1024 * 1024 // 40MB

export function WorkflowExecutionModal({
  isOpen,
  onClose,
  workflowName,
  workflowDescription,
  templateId,
  onViewExecution,
}: WorkflowExecutionModalProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [, setIsUploading] = useState(false)
  const [, setIsUploaded] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [isCompleted, setIsCompleted] = useState(false)
  const [isFailed, setIsFailed] = useState(false)
  const [processingMessage, setProcessingMessage] = useState<string>(
    "Processing the File",
  )
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const [maxPollingAttempts] = useState(150) // 5 minutes at 2-second intervals
  const [maxRetries] = useState(3)
  const [executionId, setExecutionId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Cleanup polling on component unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current)
      }
    }
  }, [])

  const resetModalState = () => {
    setSelectedFile(null)
    setIsUploading(false)
    setIsUploaded(false)
    setUploadError(null)
    setIsProcessing(false)
    setIsCompleted(false)
    setIsFailed(false)
    setProcessingMessage("")
    setExecutionId(null)
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleClose = () => {
    resetModalState()
    onClose()
  }

  // Function to extract meaningful error messages from various error sources
  const extractErrorMessage = (error: any): string => {
    // Handle HTTP response errors
    if (error?.response) {
      const response = error.response
      if (response.data?.error) {
        return response.data.error
      }
      if (response.data?.message) {
        return response.data.message
      }
      if (response.statusText) {
        return `HTTP ${response.status}: ${response.statusText}`
      }
    }

    // Handle API response errors
    if (error?.error && typeof error.error === 'string') {
      return error.error
    }
    if (error?.message && typeof error.message === 'string') {
      return error.message
    }

    // Handle Error objects
    if (error instanceof Error) {
      return error.message
    }

    // Handle network errors
    if (error?.code === 'NETWORK_ERROR' || error?.name === 'NetworkError') {
      return "Network connection failed. Please check your internet connection and try again."
    }

    // Handle timeout errors
    if (error?.code === 'ECONNABORTED' || error?.message?.includes('timeout')) {
      return "Request timed out. The operation took too long to complete."
    }

    // Handle validation errors
    if (error?.validation && Array.isArray(error.validation)) {
      return error.validation.map((v: any) => v.message || v).join(', ')
    }

    // Fallback for unknown error structures
    if (typeof error === 'string') {
      return error
    }

    // Last resort fallback
    return "An unexpected error occurred. Please try again."
  }

  if (!isOpen) return null

  const validateFile = (file: File): string | null => {
    // Check file size
    if (file.size > MAX_FILE_SIZE) {
      return `File size exceeds 40MB limit. Current size: ${(file.size / 1024 / 1024).toFixed(1)}MB`
    }

    // Check file type
    if (!SUPPORTED_FILE_TYPES[file.type as keyof typeof SUPPORTED_FILE_TYPES]) {
      return `Unsupported file type: ${file.type}. Supported formats include text, PDF, and Word files.`
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

  const executeWorkflow = async (file: File, execTemplateId?: string) => {
    const currentTemplateId = execTemplateId || templateId
    setIsUploading(true)
    try {
      // Create form data matching the curl command format
      const formData: Record<string, any> = {
        name: `${workflowName} - ${new Date().toLocaleString()}`,
        description: `Execution of ${workflowName} with file: ${file.name}`,
        file_description: `Test document: ${file.name}`,
      }

      const executionData = {
        name: formData.name,
        description: formData.description,
        file: file,
        formData: formData,
      }

      const response = await workflowExecutionsAPI.executeTemplate(
        currentTemplateId!,
        executionData,
      )

      // Extract message from response and set it for display
      if (response.message) {
        setProcessingMessage(response.message)
      }

      if (response.error || response.status === "error") {
        setIsUploaded(false)
        setIsProcessing(false)
        setIsFailed(true)
        const errorMessage = extractErrorMessage(response.error || response.message || response)
        setUploadError(`Execution failed: ${errorMessage}`)
      } else {
        setIsUploaded(true)
        setIsProcessing(true) // Set processing state

        // Extract execution ID from response.data.execution.id
        const currentExecutionId = response.data?.execution?.id

        if (currentExecutionId) {
          // Store execution ID for later use
          setExecutionId(currentExecutionId)
          // Start polling for completion with the execution ID
          startStatusPolling(currentExecutionId)
        } else {
          console.warn("No execution ID found in response")
          // Try to extract from other possible locations
          const alternativeId = response.data?.id || response.execution?.id || response.id
          if (alternativeId) {
            setExecutionId(alternativeId)
            startStatusPolling(alternativeId)
          } else {
            // If no ID found, show error
            setIsProcessing(false)
            setIsFailed(true)
            setUploadError("Execution started but could not track progress. Please check execution status manually.")
          }
        }
      }
    } catch (error) {
      console.error("Execution error:", error)
      setIsUploaded(false)
      setIsProcessing(false)
      setIsFailed(true)
      const errorMessage = extractErrorMessage(error)
      setUploadError(`Execution failed: ${errorMessage}`)
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

    setIsProcessing(true)
    
    try {
      // Only execute with existing template ID
      if (templateId) {
        await executeWorkflow(selectedFile, templateId)
      } else {
        throw new Error("No template ID provided for execution. Please save the workflow first.")
      }
    } catch (error) {
      console.error("Execution error:", error)
      setIsProcessing(false)
      setIsFailed(true)
      const errorMessage = extractErrorMessage(error)
      setUploadError(`Execution failed: ${errorMessage}`)
    }
  }

  const handleDiscardFile = () => {
    setSelectedFile(null)
    setUploadError(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const handleUploadAnother = () => {
    setSelectedFile(null)
    setIsUploaded(false)
    setIsProcessing(false)
    setIsCompleted(false)
    setIsFailed(false)
    setUploadError(null)
    setProcessingMessage("")      
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const stopPolling = () => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current)
      pollingIntervalRef.current = null
    }  
  }

  const startStatusPolling = async (executionId: string) => {

    // Clear any existing interval first
    stopPolling()      

    let currentAttempts = 0
    let currentRetryCount = 0

    const checkStatus = async () => {
      try {
        currentAttempts += 1      
        
        // Check if we've exceeded max polling attempts (timeout)
        if (currentAttempts >= maxPollingAttempts) {
          stopPolling()
          setIsProcessing(false)
          setIsFailed(true)
          setUploadError("Execution timed out. The process is taking longer than expected. Please check the execution status manually.")
          return
        }

        const response = await api.workflow.executions[executionId].status.$get()

        // Check if response is ok
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        }

        const statusData = await response.json()

        // Reset retry count on successful request
        currentRetryCount = 0        

        if (statusData.status === "completed") {
          stopPolling()
          setIsProcessing(false)
          setIsCompleted(true)
        } else if (statusData.status === "failed") {
          stopPolling()
          setIsProcessing(false)
          setIsFailed(true)
          
          // Extract error message from status data
          let errorMessage = "Execution failed"
          if (statusData.error) {
            errorMessage = extractErrorMessage(statusData.error)
          } else if (statusData.message && statusData.message !== "Execution failed") {
            errorMessage = statusData.message
          }
          
          setUploadError(errorMessage)
        } else if (statusData.status === "active" || statusData.status === "pending") {
          // Update processing message if provided
          if (statusData.message && statusData.message !== processingMessage) {
            setProcessingMessage(statusData.message)
          }
          // Continue polling - no action needed
        } else {
          // Unknown status
          console.warn("⚠️ Unknown execution status:", statusData.status)
        }
        
      } catch (error) {
        console.error("Status polling error:", error)
        currentRetryCount += 1        
        
        // If we've exceeded max retries, stop polling and show error
        if (currentRetryCount >= maxRetries) {
          stopPolling()
          setIsProcessing(false)
          setIsFailed(true)
          setUploadError(`Failed to check execution status: ${extractErrorMessage(error)}`)
          return
        }
      }
    }

    // Start polling every 2 seconds
    const interval = setInterval(checkStatus, 2000)
    pollingIntervalRef.current = interval

    // Also check immediately
    checkStatus()
  }


  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-2xl w-full mx-4 relative">
        {/* Close Button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors z-10"
        >
          <X className="w-6 h-6 text-gray-500 dark:text-gray-400" />
        </button>

        {isFailed ? (
          // Error Page
          <>
            {/* Header */}
            <div className="p-8 pb-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-base">{workflowDescription}</p>
            </div>

            {/* Error Content */}
            <div className="px-8 pb-8">
              <div className="border border-dashed border-red-300 dark:border-red-600 rounded-xl px-6 py-16 text-center bg-red-50 dark:bg-red-900/20 w-full min-h-[280px] flex flex-col items-center justify-center">
                {/* Error Icon */}
                <div className="w-16 h-16 flex items-center justify-center mb-6">
                  <div className="w-16 h-16 bg-red-100 dark:bg-red-900/40 rounded-full flex items-center justify-center">
                    <XCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
                  </div>
                </div>

                {/* Error Message */}
                <h3 className="text-red-900 dark:text-red-100 text-lg font-semibold mb-2">
                  Execution Failed
                </h3>
                <p className="text-red-700 dark:text-red-300 text-sm max-w-md">
                  {uploadError || "The workflow execution encountered an error and could not be completed."}
                </p>
              </div>

              {/* Try Again Button */}
              <div className="flex justify-end mt-6">
                <Button
                  onClick={() => {
                    setIsFailed(false)
                    setUploadError(null)
                    if (selectedFile) {
                      setIsProcessing(true)
                      executeWorkflow(selectedFile)
                    }
                  }}
                  className="bg-red-600 hover:bg-red-700 text-white px-6 py-2 rounded-full font-medium"
                >
                  Try Again
                </Button>
              </div>
            </div>
          </>
        ) : isCompleted ? (
          // Completion Page
          <>
            {/* Header */}
            <div className="p-8 pb-6">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-base">{workflowDescription}</p>
            </div>

            {/* Completion Content */}
            <div className="px-8 pb-8">
              <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-xl px-6 py-16 text-center bg-gray-50 dark:bg-gray-800 w-full min-h-[280px] flex flex-col items-center justify-center">
                {/* Success Icon */}
                <div className="w-16 h-16 flex items-center justify-center mb-6">
                  <img
                    src={checkCircleIcon}
                    alt="Success"
                    className="w-16 h-16"
                  />
                </div>

                {/* Success Message */}
                <p className="text-gray-900 dark:text-gray-100 text-lg font-medium">
                  Process completed successfully!
                </p>
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end gap-3 mt-6">
                <Button
                  onClick={() => {
                    if (executionId && onViewExecution) {
                      onViewExecution(executionId)
                      handleClose() // Close the modal after navigating
                    }
                  }}
                  disabled={!executionId}
                  className="bg-white hover:bg-gray-50 text-gray-800 border border-gray-300 px-6 py-2 rounded-full font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  View Workflow
                </Button>
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
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-base">{workflowDescription}</p>
            </div>

            {/* Processing Content */}
            <div className="px-8 pb-8">
              <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-xl px-6 py-16 text-center bg-gray-50 dark:bg-gray-800 w-full min-h-[280px] flex flex-col items-center justify-center">
                <div className="w-12 h-12 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin mb-6"></div>
                {/* <p className="text-gray-900 text-lg font-medium mb-2">Processing the File</p> */}
                {processingMessage && (
                  <p className="text-gray-900 dark:text-gray-100 text-lg font-medium mb-2">
                    {processingMessage}
                  </p>
                )}
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
              <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
                {workflowName}
              </h2>
              <p className="text-gray-600 dark:text-gray-400 text-base">{workflowDescription}</p>
            </div>

            {/* File Upload Area */}
            <div className="px-8 pb-6">
              {selectedFile ? (
                // Selected File Display
                <div className="border border-dashed border-gray-300 dark:border-gray-600 rounded-xl px-6 py-16 text-center bg-gray-50 dark:bg-gray-800 w-full min-h-[280px] flex flex-col items-center justify-center">
                  <div className="flex items-center gap-3 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-4 py-3 shadow-sm">
                    <FileText className="w-6 h-6 text-gray-600 dark:text-gray-400" />
                    <span className="text-gray-900 dark:text-gray-100 font-medium">
                      {selectedFile.name}
                    </span>
                    <button
                      onClick={handleDiscardFile}
                      className="ml-2 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              ) : (
                // Upload Area
                <div
                  className="border border-dashed border-gray-300 dark:border-gray-600 rounded-xl px-6 py-10 text-center cursor-pointer hover:border-gray-400 dark:hover:border-gray-500 transition-colors bg-gray-50 dark:bg-gray-800 w-full min-h-[280px]"
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
                      className="bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 border border-gray-300 dark:border-gray-600 px-6 py-2 rounded-full uppercase font-medium text-sm leading-6 tracking-normal"
                      style={{ fontFamily: "Inter" }}
                      onClick={(e) => {
                        e.stopPropagation()
                        fileInputRef.current?.click()
                      }}
                    >
                      BROWSE FILES
                    </Button>

                    {/* Or text */}
                    <p className="text-gray-600 dark:text-gray-400">or drag & drop files</p>

                    {/* Supported formats */}
                    <p className="text-gray-500 dark:text-gray-500 text-sm text-center leading-relaxed">
                      Supported formats include text, PDF, and Word files
                      <br />
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
                accept=".txt,.pdf,.doc,.docx"
              />

              {/* Error Display */}
              {uploadError && (
                <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0">
                      <AlertCircle className="w-5 h-5 text-red-400" />
                    </div>
                    <div className="flex-1">
                      <h3 className="text-sm font-medium text-red-800 dark:text-red-300">
                        Execution Error
                      </h3>
                      <p className="text-sm text-red-700 dark:text-red-400 mt-1">
                        {uploadError}
                      </p>
                      {(uploadError.includes("Network") || uploadError.includes("timeout") || uploadError.includes("Failed to check")) && (
                        <div className="mt-3">
                          <button
                            onClick={() => {
                              setUploadError(null)
                              if (selectedFile) {
                                setIsProcessing(true)
                                executeWorkflow(selectedFile)
                              }
                            }}
                            className="text-sm bg-red-100 hover:bg-red-200 dark:bg-red-800 dark:hover:bg-red-700 text-red-800 dark:text-red-200 px-3 py-1 rounded-md transition-colors"
                          >
                            Retry Execution
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Action Button */}
            <div className="px-8 pb-8">
              <div className="flex justify-end">
                <div className="relative group">
                  <Button
                    onClick={handleStartExecution}
                    disabled={!selectedFile || !templateId}
                    className={`px-6 py-2 rounded-full font-medium transition-all ${
                      selectedFile && templateId
                        ? "bg-black hover:bg-gray-800 text-white"
                        : "bg-gray-400 cursor-not-allowed text-gray-600"
                    }`}
                  >
                    Start Execution
                  </Button>
                  {!templateId && (
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap z-50">
                      template not saved Please save template
                      <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
