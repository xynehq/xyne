import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {  X, CheckCircle, XCircle, Clock, AlertTriangle, Trash2, CornerDownLeft, Download } from "lucide-react"
import { api } from "../../api"
import { workflowToolsAPI } from "./api/ApiHandlers"

interface ReviewExecutionUIProps {
  isVisible: boolean
  onBack: () => void
  onClose?: () => void
  stepExecutionId: string
  stepName?: string
  reviewContent?: any
  previousStepResult?: any
  onReviewSubmitted?: () => void // Callback to restart polling
  builder?: boolean // true for builder mode (email config), false for execution mode (approve/reject buttons)
  onSave?: (config: ReviewEmailConfig) => void // Callback to save email configuration
  stepData?: any // Step data for loading existing configuration
  toolId?: string // Tool ID for API updates
  toolData?: any // Tool data for loading existing configuration
  workflowExecutionId?: string // Workflow execution ID for file downloads
  isStepActive?: boolean // Whether the step is currently active and can be reviewed
}

interface ReviewEmailConfig {
  email_addresses: string[]
  email_message: string
}

const ReviewExecutionUI: React.FC<ReviewExecutionUIProps> = ({
  isVisible,
  onBack,
  onClose,
  stepExecutionId,
  stepName = "Review Step",
  reviewContent,
  previousStepResult,
  onReviewSubmitted,
  builder = true,
  onSave,
  stepData,
  toolId,
  toolData,
  workflowExecutionId,
  isStepActive = true,
}) => {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submissionStatus, setSubmissionStatus] = useState<'pending' | 'approved' | 'rejected' | 'error'>('pending')
  
  // Debug logging
  React.useEffect(() => {
    console.log("🔍 ReviewExecutionUI props changed:", { 
      isVisible, 
      stepExecutionId, 
      stepName, 
      builder, 
      submissionStatus: submissionStatus 
    })
  }, [isVisible, stepExecutionId, stepName, builder, submissionStatus])

  console.log("🔍 ReviewExecutionUI render:", { 
    isVisible, 
    builder, 
    stepExecutionId, 
    submissionStatus 
  })
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [showFileSelection, setShowFileSelection] = useState(false)
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])

  // Email configuration state (for builder mode)
  const [emailConfig, setEmailConfig] = useState<ReviewEmailConfig>({
    email_addresses: [],
    email_message: "",
  })
  const [newEmailAddress, setNewEmailAddress] = useState("")
  const [emailValidationError, setEmailValidationError] = useState<string | null>(null)
  const [isEmailValid, setIsEmailValid] = useState<boolean>(false)

  // Email validation regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/

  const handleReviewDecision = async (decision: 'approved' | 'rejected') => {
    console.log("🔍 Review decision clicked:", { decision, stepExecutionId })
    setIsSubmitting(true)
    setSubmitError(null)

    try {
      console.log("🔍 Making API call to:", `/api/v1/workflow/steps/${stepExecutionId}/review`)
      const response = await api.workflow.steps[":stepId"].review.$post({
        param: { stepId: stepExecutionId },
        json: { input: decision }
      })
      console.log("🔍 API response:", response)
      
      const data = await response.json()
      console.log("🔍 API response data:", data)

      if (data.success) {
        setSubmissionStatus(decision)
        
        // Call the callback to restart workflow polling
        if (onReviewSubmitted) {
          onReviewSubmitted()
        }

        // Auto-close the sidebar after successful submission
        setTimeout(() => {
          if (onClose) {
            onClose()
          }
        }, 2000)
      } else {
        console.log("🔍 API returned error:", data)
        throw new Error(data.error?.message || data.message || 'Failed to submit review')
      }
    } catch (error: any) {
      console.error('Error submitting review:', error)
      setSubmitError(error.response?.data?.message || error.message || 'Failed to submit review decision')
      setSubmissionStatus('error')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDownloadFiles = async (selectedFiles?: string[]) => {
    setIsDownloading(true)
    setDownloadError(null)

    try {
      // Use the provided workflowExecutionId prop or try to extract from previousStepResult
      const executionId = workflowExecutionId || 
                         previousStepResult?.workflowExecutionId || 
                         stepExecutionId.split('-')[0]
      
      if (!executionId) {
        throw new Error('Workflow execution ID not available')
      }

      console.log('Downloading files for execution:', executionId)
      
      let response: Response
      
      if (selectedFiles && selectedFiles.length > 0) {
        // POST request with specific files
        console.log('Downloading specific files:', selectedFiles)
        response = await fetch(`/api/v1/workflow/executions/${executionId}/download`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ files: selectedFiles }),
        })
      } else {
        // GET request for all files (backward compatibility)
        console.log('Downloading all files')
        response = await fetch(`/api/v1/workflow/executions/${executionId}/download`, {
          method: 'GET',
          credentials: 'include',
        })
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Download failed' }))
        throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`)
      }

      // Create blob from response
      const blob = await response.blob()
      
      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('content-disposition')
      let filename = selectedFiles && selectedFiles.length === 1 
        ? selectedFiles[0] 
        : 'review-files.zip'
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
        if (filenameMatch) {
          filename = filenameMatch[1].replace(/['"]/g, '')
        }
      }

      // Create download link and trigger download
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      
      // Cleanup
      window.URL.revokeObjectURL(url)
      document.body.removeChild(link)

      console.log('Files downloaded successfully')
    } catch (error: any) {
      console.error('Error downloading files:', error)
      setDownloadError(error.message || 'Failed to download files')
    } finally {
      setIsDownloading(false)
    }
  }

  // Get available extracted files
  const getExtractedFiles = (): string[] => {
    try {
      if (previousStepResult?.extractedFiles && Array.isArray(previousStepResult.extractedFiles)) {
        return previousStepResult.extractedFiles
      }
    } catch (error) {
      console.log('Error getting extracted files:', error)
    }
    return []
  }

  // Check if there are extracted files available for download
  const hasExtractedFiles = () => {
    return getExtractedFiles().length > 0
  }

  // Initialize selected files when extracted files are available
  React.useEffect(() => {
    const availableFiles = getExtractedFiles()
    if (availableFiles.length > 0 && selectedFiles.length === 0) {
      setSelectedFiles(availableFiles) // Select all files by default
    }
  }, [previousStepResult])

  // Email validation function (for builder mode)
  const validateEmail = (email: string): { isValid: boolean; error: string | null } => {
    if (!email.trim()) {
      return { isValid: false, error: null }
    }
    
    if (email.length > 254) {
      return { isValid: false, error: "Email address is too long (max 254 characters)" }
    }
    
    if (!emailRegex.test(email)) {
      return { isValid: false, error: "Please enter a valid email address" }
    }
    
    // Check for consecutive dots
    if (email.includes('..')) {
      return { isValid: false, error: "Email cannot contain consecutive dots" }
    }
    
    // Check if email starts or ends with dot
    const [localPart] = email.split('@')
    if (localPart.startsWith('.') || localPart.endsWith('.')) {
      return { isValid: false, error: "Email cannot start or end with a dot" }
    }
    
    return { isValid: true, error: null }
  }

  // Handle email input change with validation
  const handleEmailInputChange = (value: string) => {
    setNewEmailAddress(value)
    const validation = validateEmail(value)
    setIsEmailValid(validation.isValid)
    setEmailValidationError(validation.error)
  }

  // Add email address to the list
  const handleAddEmail = () => {
    const validation = validateEmail(newEmailAddress)
    
    if (!validation.isValid) {
      setEmailValidationError(validation.error || "Please enter a valid email address")
      setIsEmailValid(false)
      return
    }
    
    if (emailConfig.email_addresses.includes(newEmailAddress.toLowerCase())) {
      setEmailValidationError("This email address is already added")
      setIsEmailValid(false)
      return
    }
    
    // Add the email (normalize to lowercase for consistency)
    setEmailConfig((prev) => ({
      ...prev,
      email_addresses: [...prev.email_addresses, newEmailAddress.toLowerCase()],
    }))
    
    // Reset input and validation state
    setNewEmailAddress("")
    setEmailValidationError(null)
    setIsEmailValid(false)
  }

  // Remove email address from the list
  const handleRemoveEmail = (emailToRemove: string) => {
    setEmailConfig((prev) => ({
      ...prev,
      email_addresses: prev.email_addresses.filter((email) => email !== emailToRemove),
    }))
  }

  // Handle Enter key press for adding email
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleAddEmail()
    }
  }

  // Save email configuration (for builder mode)
  const handleSaveEmailConfig = async () => {
    console.log("handleSaveEmailConfig called with:", {
      toolId,
      builder,
      emailConfig,
      toolData,
      onSave: !!onSave
    })

    try {
      // If we have a toolId, update the tool via API
      if (toolId) {
        console.log("Making API call to update tool...")
        const updatedToolData = {
          type: "review",
          value: emailConfig,
          config: {
            ...toolData?.config,
            email_addresses: emailConfig.email_addresses,
            email_message: emailConfig.email_message,
          },
        }

        await workflowToolsAPI.updateTool(toolId, updatedToolData)
        console.log("Review tool updated successfully")
      } else {
        console.log("API call skipped:", {
          reason: "No toolId provided"
        })
      }

      // Call the parent save handler
      if (onSave) {
        console.log("Calling parent onSave handler...")
        onSave(emailConfig)
      } else {
        console.log("No onSave handler provided")
      }
    } catch (error) {
      console.error("Failed to save review configuration:", error)
      // Still call the parent handler even if API call fails
      if (onSave) {
        onSave(emailConfig)
      }
    }
  }

  // Load existing configuration when component becomes visible
  React.useEffect(() => {
    if (isVisible && builder) {
      // Try to load from toolData first, then stepData, otherwise use defaults
      let existingConfig = null
      
      if (toolData?.config) {
        existingConfig = toolData.config
      } else if (toolData?.value) {
        existingConfig = toolData.value
      } else if (stepData?.data?.tools?.[0]?.config) {
        existingConfig = stepData.data.tools[0].config
      }
      
      if (existingConfig) {
        setEmailConfig({
          email_addresses: existingConfig.email_addresses || [],
          email_message: existingConfig.email_message || "",
        })
      } else {
        // Reset to defaults for new review step
        setEmailConfig({
          email_addresses: [],
          email_message: "",
        })
      }
    }
  }, [isVisible, builder, stepData, toolData])

  const renderReviewContent = () => {
    if (!previousStepResult) {
      return (
        <div className="text-sm text-gray-500 italic">
          No content available for review
        </div>
      )
    }

    // Handle different types of previous step results
    if (typeof previousStepResult === 'string') {
      return (
        <div className="text-sm text-gray-700 whitespace-pre-wrap">
          {previousStepResult}
        </div>
      )
    }

    // Handle form data
    if (previousStepResult.formData) {
      return (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-900">Form Submission:</h4>
          {Object.entries(previousStepResult.formData).map(([key, value]: [string, any]) => (
            <div key={key} className="border-l-2 border-blue-200 pl-3">
              <div className="text-xs font-medium text-gray-600 uppercase tracking-wide">
                {key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase())}
              </div>
              <div className="text-sm text-gray-800 mt-1">
                {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
              </div>
            </div>
          ))}
        </div>
      )
    }

    // Handle AI output
    if (previousStepResult.aiOutput) {
      return (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-900">AI Generated Content:</h4>
          <div className="bg-gray-50 p-3 rounded-md text-sm text-gray-700 whitespace-pre-wrap">
            {previousStepResult.aiOutput}
          </div>
          {previousStepResult.agentName && (
            <div className="text-xs text-gray-500">
              Generated by: {previousStepResult.agentName}
            </div>
          )}
        </div>
      )
    }

    // Fallback: render as JSON
    return (
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-gray-900">Content for Review:</h4>
        <pre className="bg-gray-50 p-3 rounded-md text-xs text-gray-700 overflow-auto max-h-64">
          {JSON.stringify(previousStepResult, null, 2)}
        </pre>
      </div>
    )
  }

  const getStatusIcon = () => {
    switch (submissionStatus) {
      case 'approved':
        return <CheckCircle className="w-5 h-5 text-green-500" />
      case 'rejected':
        return <XCircle className="w-5 h-5 text-red-500" />
      case 'error':
        return <AlertTriangle className="w-5 h-5 text-orange-500" />
      default:
        return <Clock className="w-5 h-5 text-blue-500" />
    }
  }

  const getStatusMessage = () => {
    switch (submissionStatus) {
      case 'approved':
        return 'Review approved! Workflow will continue with the approval path.'
      case 'rejected':
        return 'Review rejected! Workflow will continue with the rejection path.'
      case 'error':
        return submitError || 'An error occurred while submitting the review.'
      default:
        return 'Please review the content and make a decision.'
    }
  }

  if (!isVisible) return null

  return (
    <div
      className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-gray-700">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wider uppercase">
            REVIEW STEP
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md transition-colors"
            >
              <X className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            </button>
          )}
        </div>
        <div className="text-sm text-slate-500 dark:text-gray-400 leading-5 font-normal">
          {stepName}
        </div>
      </div>

      {/* Content */}
      {!builder && <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Status */}
        <div className="flex items-start space-x-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
          {getStatusIcon()}
          <div className="flex-1">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Review Required
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {getStatusMessage()}
            </div>
          </div>
        </div>

        {/* Review Content */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Content to Review
            </h3>
            {hasExtractedFiles() && (
              <div className="flex items-center space-x-2">
                {/* File Selection Toggle */}
                <Button
                  onClick={() => setShowFileSelection(!showFileSelection)}
                  size="sm"
                  variant="ghost"
                  className="text-sm"
                >
                  {showFileSelection ? 'Hide Files' : 'Select Files'}
                </Button>
                
                {/* Download Button */}
                <Button
                  onClick={() => handleDownloadFiles(selectedFiles)}
                  disabled={isDownloading || selectedFiles.length === 0}
                  size="sm"
                  variant="outline"
                  className="flex items-center space-x-2 text-sm"
                >
                  {isDownloading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                      <span>Downloading...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-4 h-4" />
                      <span>Download {selectedFiles.length === getExtractedFiles().length ? 'All' : selectedFiles.length} File{selectedFiles.length !== 1 ? 's' : ''}</span>
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
          
          {/* File Selection Panel */}
          {showFileSelection && hasExtractedFiles() && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-blue-50 dark:bg-blue-900/20">
              <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-3">
                Select Files to Download ({selectedFiles.length} of {getExtractedFiles().length} selected)
              </h4>
              <div className="space-y-2">
                {/* Select All / None Toggle */}
                <div className="flex items-center space-x-2">
                  <Button
                    onClick={() => {
                      const allFiles = getExtractedFiles()
                      setSelectedFiles(selectedFiles.length === allFiles.length ? [] : allFiles)
                    }}
                    size="sm"
                    variant="outline"
                    className="text-xs"
                  >
                    {selectedFiles.length === getExtractedFiles().length ? 'Select None' : 'Select All'}
                  </Button>
                </div>
                
                {/* File List */}
                <div className="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto">
                  {getExtractedFiles().map((file) => (
                    <label
                      key={file}
                      className="flex items-center space-x-2 p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={selectedFiles.includes(file)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedFiles([...selectedFiles, file])
                          } else {
                            setSelectedFiles(selectedFiles.filter(f => f !== file))
                          }
                        }}
                        className="rounded"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300 font-mono">{file}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
            {renderReviewContent()}
          </div>
        </div>

        {/* Error Messages */}
        {submitError && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <div className="text-sm font-medium text-red-800 dark:text-red-200">
                Review Error
              </div>
            </div>
            <div className="text-sm text-red-700 dark:text-red-300 mt-1">
              {submitError}
            </div>
          </div>
        )}

        {downloadError && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <div className="text-sm font-medium text-red-800 dark:text-red-200">
                Download Error
              </div>
            </div>
            <div className="text-sm text-red-700 dark:text-red-300 mt-1">
              {downloadError}
            </div>
          </div>
        )}
      </div>}

      {/* Template Mode - Show email configuration */}
      {builder && (
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Email Message */}
          <div className="space-y-2">
            <Label
              htmlFor="email-message"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Email Message
            </Label>
            <Textarea
              id="email-message"
              value={emailConfig.email_message}
              onChange={(e) =>
                setEmailConfig((prev) => ({
                  ...prev,
                  email_message: e.target.value,
                }))
              }
              placeholder="Enter the email message to send to reviewers..."
              className="w-full min-h-[120px] dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600"
              rows={5}
            />
            <p className="text-xs text-slate-500 dark:text-gray-400">
              This message will be sent to reviewers when the review step is activated
            </p>
          </div>

          {/* Add Email Address */}
          <div className="space-y-2">
            <Label
              htmlFor="add-reviewer-email"
              className="text-sm font-medium text-slate-700 dark:text-gray-300"
            >
              Add Reviewer Email Address
            </Label>
            <div className="relative">
              <Input
                id="add-reviewer-email"
                value={newEmailAddress}
                onChange={(e) => handleEmailInputChange(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter reviewer email address"
                className={`w-full pr-16 dark:bg-gray-800 dark:text-gray-300 ${
                  emailValidationError
                    ? "border-red-500 dark:border-red-400 focus:border-red-500 dark:focus:border-red-400"
                    : isEmailValid && newEmailAddress
                    ? "border-green-500 dark:border-green-400 focus:border-green-500 dark:focus:border-green-400"
                    : "dark:border-gray-600"
                }`}
              />
              <div className="absolute right-3 top-1/2 transform -translate-y-1/2">
                <div className="flex items-center justify-center w-6 h-6">
                  {emailValidationError ? (
                    <AlertTriangle className="w-4 h-4 text-red-500 dark:text-red-400" />
                  ) : isEmailValid && newEmailAddress ? (
                    <CheckCircle className="w-4 h-4 text-green-500 dark:text-green-400" />
                  ) : (
                    <CornerDownLeft className="w-4 h-4 text-slate-400 dark:text-gray-500" />
                  )}
                </div>
              </div>
            </div>
            
            {/* Email validation feedback */}
            {emailValidationError && (
              <div className="flex items-center gap-2 mt-2">
                <AlertTriangle className="w-4 h-4 text-red-500 dark:text-red-400 flex-shrink-0" />
                <p className="text-sm text-red-600 dark:text-red-400">
                  {emailValidationError}
                </p>
              </div>
            )}
            
            {isEmailValid && newEmailAddress && !emailValidationError && (
              <div className="flex items-center gap-2 mt-2">
                <CheckCircle className="w-4 h-4 text-green-500 dark:text-green-400 flex-shrink-0" />
                <p className="text-sm text-green-600 dark:text-green-400">
                  Valid email address
                </p>
              </div>
            )}

            {/* Added Email Addresses */}
            {emailConfig.email_addresses.length > 0 && (
              <div className="space-y-2 mt-4">
                <p className="text-sm font-medium text-slate-700 dark:text-gray-300">
                  Reviewers ({emailConfig.email_addresses.length})
                </p>
                {emailConfig.email_addresses.map((email, index) => {
                  // Generate avatar color based on email
                  const avatarColors = [
                    "bg-yellow-400",
                    "bg-pink-500",
                    "bg-blue-500",
                    "bg-green-500",
                    "bg-purple-500",
                    "bg-red-500",
                    "bg-orange-500",
                    "bg-teal-500",
                  ]
                  const colorIndex = email.charCodeAt(0) % avatarColors.length
                  const avatarColor = avatarColors[colorIndex]

                  // Get first letter of email for avatar
                  const firstLetter = email.charAt(0).toUpperCase()

                  return (
                    <div
                      key={index}
                      className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 ${avatarColor} rounded-full flex items-center justify-center text-white font-medium text-sm`}
                        >
                          {firstLetter}
                        </div>
                        <div className="text-sm font-medium text-slate-900 dark:text-gray-300">
                          {email}
                        </div>
                      </div>
                      <button
                        onClick={() => handleRemoveEmail(email)}
                        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                      >
                        <Trash2 className="w-4 h-4 text-gray-400 dark:text-gray-500 hover:text-red-500 dark:hover:text-red-400" />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          
          {/* Save Button */}
          <div className="pt-4">
            {emailConfig.email_addresses.length === 0 && (
              <p className="text-xs text-slate-500 dark:text-gray-400 mb-2 text-center">
                Add at least one reviewer email address to enable save
              </p>
            )}
            <Button
              onClick={handleSaveEmailConfig}
              disabled={emailConfig.email_addresses.length === 0}
              className={`w-full rounded-full shadow-none ${
                emailConfig.email_addresses.length === 0
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-500 cursor-not-allowed hover:bg-gray-100 dark:hover:bg-gray-800"
                  : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 text-white"
              }`}
            >
              Save Configuration
            </Button>
          </div>
        </div>
      )}

      {/* Execution Mode - Show action buttons */}
      {!builder && submissionStatus === 'pending' && (
        <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="space-y-3">
            {hasExtractedFiles() && (
              <Button
                onClick={() => handleDownloadFiles(selectedFiles)}
                disabled={isDownloading || selectedFiles.length === 0}
                variant="outline"
                className="w-full border-blue-300 text-blue-700 hover:bg-blue-50 hover:border-blue-400"
              >
                {isDownloading ? (
                  <div className="flex items-center space-x-2">
                    <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
                    <span>Downloading...</span>
                  </div>
                ) : (
                  <div className="flex items-center space-x-2">
                    <Download className="w-4 h-4" />
                    <span>Download {selectedFiles.length === getExtractedFiles().length ? 'All' : selectedFiles.length} File{selectedFiles.length !== 1 ? 's' : ''}</span>
                  </div>
                )}
              </Button>
            )}
            
            {isStepActive ? (
              <>
                <Button
                  onClick={() => handleReviewDecision('approved')}
                  disabled={isSubmitting}
                  className="w-full bg-green-600 hover:bg-green-700 text-white"
                >
                  {isSubmitting ? (
                    <div className="flex items-center space-x-2">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      <span>Submitting...</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2">
                      <CheckCircle className="w-4 h-4" />
                      <span>Approve</span>
                    </div>
                  )}
                </Button>
                
                <Button
                  onClick={() => handleReviewDecision('rejected')}
                  disabled={isSubmitting}
                  variant="outline"
                  className="w-full border-red-300 text-red-700 hover:bg-red-50 hover:border-red-400"
                >
                  {isSubmitting ? (
                    <div className="flex items-center space-x-2">
                      <div className="w-4 h-4 border-2 border-red-600 border-t-transparent rounded-full animate-spin" />
                      <span>Submitting...</span>
                    </div>
                  ) : (
                    <div className="flex items-center space-x-2">
                      <XCircle className="w-4 h-4" />
                      <span>Reject</span>
                    </div>
                  )}
                </Button>
              </>
            ) : (
              <>
                <div className="relative group">
                  <Button
                    disabled={true}
                    className="w-full bg-gray-400 hover:bg-gray-400 text-gray-600 cursor-not-allowed"
                  >
                    <div className="flex items-center space-x-2">
                      <CheckCircle className="w-4 h-4" />
                      <span>Approve</span>
                    </div>
                  </Button>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap z-10">
                    Complete previous steps to activate this node
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
                
                <div className="relative group">
                  <Button
                    disabled={true}
                    variant="outline"
                    className="w-full bg-gray-400 hover:bg-gray-400 text-gray-600 cursor-not-allowed border-gray-400"
                  >
                    <div className="flex items-center space-x-2">
                      <XCircle className="w-4 h-4" />
                      <span>Reject</span>
                    </div>
                  </Button>
                  <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap z-10">
                    Complete previous steps to activate this node
                    <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Success State - Only show in execution mode */}
      {!builder && (submissionStatus === 'approved' || submissionStatus === 'rejected') && (
        <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="text-center">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Review submitted successfully! Workflow will continue automatically.
            </div>
            <Button
              onClick={onClose}
              variant="outline"
              className="mt-3"
            >
              Close
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ReviewExecutionUI