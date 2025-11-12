import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X, Bot, FileSpreadsheet, AlertCircle, CheckCircle, Loader } from "lucide-react"

interface QAExecutionModalProps {
  isOpen: boolean
  onClose: () => void
  nodeId: string
  stepData?: any
  toolData?: any
  workflowData?: any // Full workflow execution data
  onWorkflowUpdate?: (updatedWorkflowData: any) => void // Callback to update parent with fresh data
}

interface QAQuestion {
  question: string
  answer: string
  status: 'pending' | 'processing' | 'completed' | 'error'
}

interface ExcelSheetMeta {
  name: string
  columns: string[]
  rowCount: number
}

interface ExcelMetadata {
  filename: string
  fileId: string
  filePath: string
  sheets: ExcelSheetMeta[]
}

export function QAExecutionModal({
  isOpen,
  onClose,
  nodeId,
  stepData,
  toolData,
  workflowData,
  onWorkflowUpdate,
}: QAExecutionModalProps) {
  // State for Excel metadata and selection
  const [excelMetadata, setExcelMetadata] = useState<ExcelMetadata | null>(null)
  const [selectedSheetName, setSelectedSheetName] = useState<string>('')
  const [selectedColumnName, setSelectedColumnName] = useState<string>('')
  const [questions, setQuestions] = useState<QAQuestion[]>([])
  
  // State for processing flow
  const [currentStep, setCurrentStep] = useState<'loading' | 'selectSheet' | 'selectColumn' | 'processing' | 'completed'>('loading')
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null)

  // Agent info
  const agentName = toolData?.config?.agentName || toolData?.val?.agentName || 'Q&A Agent'
  const agentId = toolData?.config?.agentId || toolData?.val?.agentId
  const executionId = workflowData?.id || workflowData?.execution?.id || stepData?.executionId
  
  // Get step status from stepData
  const stepStatus = stepData?.status

  // Initialize modal state based on step status when modal opens
  useEffect(() => {
    if (isOpen) {
      console.log("🔍 QA Modal opened, step status:", stepStatus, { stepData, toolData })
      setError(null) // Clear any previous errors
      
      if (stepStatus === 'completed') {
        // Step is completed - show results immediately
        console.log("✅ Step completed - loading results from toolData")
        if (toolData?.result?.qaResults) {
          const qaResults = toolData.result.qaResults
          const processedQuestions = qaResults.questionsAndAnswers.map((qa: any) => ({
            question: qa.question,
            answer: qa.answer,
            status: qa.answer.startsWith('Error:') || qa.answer.includes('Failed to get answer') ? 'error' : 'completed'
          }))
          setQuestions(processedQuestions)
          setCurrentStep('completed')
        } else {
          setError('Q&A results not found in completed step')
        }
        
      } else if (stepStatus === 'failed') {
        // Step failed - check if it's a genuine error or just awaiting user input
        console.log("❌ Step failed - checking failure reason")
        
        // If there's an explicit error message, this is a genuine failure
        if (toolData?.result?.error) {
          console.log("💥 Genuine failure with error:", toolData.result.error)
          setError(toolData.result.error)
          setCurrentStep('completed') // Show error state
        } else if (toolData?.result?.awaitingUserSelection && toolData?.result?.qaMetadata) {
          // No error but awaiting user selection - treat as active
          console.log("🔄 Failed step is awaiting user selection - treating as active")
          setExcelMetadata(toolData.result.qaMetadata)
          setCurrentStep('selectSheet')
        } else {
          // Generic failure
          console.log("❌ Generic failure - no specific error or metadata")
          setError('Q&A processing failed')
          setCurrentStep('completed') // Show error state
        }
        
      } else if (stepStatus === 'processing') {
        // Step is processing - show loader and start polling
        console.log("⏳ Step is processing - starting polling")
        setCurrentStep('processing')
        setIsProcessing(true)
        startPolling()
        
      } else if (stepStatus === 'active') {
        // Step is active - load metadata and show questions interface
        console.log("🚀 Step is active - loading Excel metadata")
        loadExcelMetadata()
      } else {
        setError(`Unexpected step status: ${stepStatus}`)
      }
    } else {
      // Clean up polling when modal closes
      stopPolling()
    }
  }, [isOpen, stepStatus, stepData, toolData])

  // Load Excel metadata for active steps
  const loadExcelMetadata = () => {
    // Check multiple possible locations for metadata
    let metadata = null
    
    // Check toolData.result (most likely location for execution workflows)
    if (toolData?.result) {
      console.log("📋 Tool data result:", toolData.result)
      
      // Look for various possible metadata structures
      metadata = toolData.result.qaMetadata || 
                toolData.result.excelMetadata ||
                toolData.result.metadata ||
                (toolData.result.awaitingUserSelection && toolData.result.sheets ? {
                  filename: toolData.result.filename || 'Excel File',
                  fileId: toolData.result.fileId || '',
                  filePath: toolData.result.filePath || '',
                  sheets: toolData.result.sheets || []
                } : null)
    }
    
    // Fallback: check stepData.result
    if (!metadata && stepData?.result?.qaMetadata) {
      metadata = stepData.result.qaMetadata
    }
    
    if (metadata) {
      console.log("✅ Found Excel metadata:", metadata)
      setExcelMetadata(metadata)
      setCurrentStep('selectSheet')
    } else {
      console.log("❌ No Excel metadata found in:", { 
        toolDataResult: toolData?.result, 
        stepDataResult: stepData?.result 
      })
      setError('No Excel metadata found. Please ensure the Q&A agent has processed the Excel file.')
    }
  }

  // Start polling for workflow execution status
  const startPolling = () => {
    if (pollingInterval) {
      clearInterval(pollingInterval)
    }
    
    console.log("🔄 Starting Q&A status polling")
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/v1/workflow/executions/${executionId}`, {
          credentials: 'include'
        })
        
        if (response.ok) {
          const data = await response.json()
          console.log("📊 Polling response:", data)
          console.log("🔍 Looking for Q&A step with templateId:", stepData?.workflowStepTemplateId)
          
          // Update parent UI with fresh workflow data
          if (onWorkflowUpdate && data.success) {
            onWorkflowUpdate(data.data)
          }
          
          // Find the Q&A step in the execution data
          const qaStep = data.data?.stepExecutions?.find((step: any) => 
            step.name?.toLowerCase().includes('q&a') || 
            step.name?.toLowerCase().includes('qa') ||
            step.workflowStepTemplateId === stepData?.workflowStepTemplateId
          )
          
          if (qaStep) {
            console.log("📝 Found Q&A step in polling:", qaStep.status)
            
            // Get the associated tool execution
            const qaToolExecution = data.data?.toolExecutions?.find((tool: any) => 
              tool.toolType === 'qa_agent' && qaStep.toolExecIds?.includes(tool.id)
            )
            console.log("🔧 Q&A tool execution:", qaToolExecution?.status, qaToolExecution?.result)
            
            if (qaStep.status === 'completed') {
              stopPolling()
              
              if (qaToolExecution?.result?.qaResults) {
                const qaResults = qaToolExecution.result.qaResults
                const processedQuestions = qaResults.questionsAndAnswers.map((qa: any) => ({
                  question: qa.question,
                  answer: qa.answer,
                  status: qa.answer.startsWith('Error:') || qa.answer.includes('Failed to get answer') ? 'error' : 'completed'
                }))
                setQuestions(processedQuestions)
                console.log("📋 Loaded Q&A results from polling data:", processedQuestions.length, "questions")
              } else {
                console.log("⚠️ Q&A completed but no results found in polling data")
              }
              
              setCurrentStep('completed')
              setIsProcessing(false)
              
            } else if (qaStep.status === 'failed') {
              stopPolling()
              
              // Check if there's an explicit error message - prioritize showing errors
              if (qaToolExecution?.result?.error) {
                console.log("💥 Polling found genuine failure with error:", qaToolExecution.result.error)
                setError(qaToolExecution.result.error)
                setCurrentStep('completed')
                setIsProcessing(false)
              } else if (qaToolExecution?.result?.awaitingUserSelection && qaToolExecution?.result?.qaMetadata) {
                console.log("🔄 Polling found failed step awaiting user selection - treating as active")
                // No error but awaiting user selection - treat as active
                setExcelMetadata(qaToolExecution.result.qaMetadata)
                setCurrentStep('selectSheet')
                setIsProcessing(false)
                setError(null)
              } else {
                // Generic failure
                console.log("❌ Polling found generic failure")
                setError('Q&A processing failed')
                setCurrentStep('completed')
                setIsProcessing(false)
              }
            }
            // Continue polling for 'processing' status
          }
        }
      } catch (error) {
        console.error('❌ Polling error:', error)
        // Continue polling despite errors
      }
    }, 5000) // Poll every 5 seconds
    
    setPollingInterval(interval)
  }

  // Stop polling
  const stopPolling = () => {
    if (pollingInterval) {
      console.log("⏹️ Stopping Q&A status polling")
      clearInterval(pollingInterval)
      setPollingInterval(null)
    }
  }

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      stopPolling()
    }
  }, [])

  // Function to process questions with the new async backend API
  const processQAQuestions = async () => {
    if (!selectedSheetName || !selectedColumnName || !agentId || !executionId) {
      setError('Missing required information to process questions')
      return
    }

    setIsProcessing(true)
    setCurrentStep('processing')
    setError(null)

    try {
      const response = await fetch('/api/v1/workflow/qa/process', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          executionId,
          sheetName: selectedSheetName,
          columnName: selectedColumnName,
          agentId,
        }),
      })

      const result = await response.json()

      if (!response.ok || !result.success) {
        throw new Error(result.error || result.message || 'Failed to start Q&A processing')
      }

      // Check the response status
      if (result.status === 'processing') {
        // Processing started successfully - start polling
        console.log("✅ Q&A processing started - beginning polling")
        startPolling()
      } else if (result.status === 'completed' && result.data) {
        // Already completed - show results immediately
        console.log("✅ Q&A already completed - showing results")
        const processedQuestions = result.data.questionsAndAnswers.map((qa: any) => ({
          question: qa.question,
          answer: qa.answer,
          status: qa.answer.startsWith('Error:') || qa.answer.includes('Failed to get answer') ? 'error' : 'completed'
        }))
        setQuestions(processedQuestions)
        setCurrentStep('completed')
        setIsProcessing(false)
      } else {
        throw new Error(`Unexpected response status: ${result.status}`)
      }

    } catch (error) {
      console.error('Error processing Q&A questions:', error)
      setError(`Failed to start Q&A processing: ${error instanceof Error ? error.message : 'Unknown error'}`)
      setIsProcessing(false)
    }
  }

  const handleSheetSelection = (sheetName: string) => {
    setSelectedSheetName(sheetName)
    setSelectedColumnName('') // Reset column selection
    setCurrentStep('selectColumn')
  }

  const handleColumnSelection = (columnName: string) => {
    setSelectedColumnName(columnName)
  }

  const handleClose = () => {
    // Reset state
    setExcelMetadata(null)
    setSelectedSheetName('')
    setSelectedColumnName('')
    setQuestions([])
    setCurrentStep('loading')
    setIsProcessing(false)
    setError(null)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-green-100 dark:bg-green-900/50 rounded-lg flex items-center justify-center">
              <Bot className="w-5 h-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Q&A Processing - {agentName}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Processing Excel questions with AI
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* Error State */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
              <div className="flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
                <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Error</h3>
              </div>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          {/* Loading */}
          {currentStep === 'loading' && !error && (
            <div className="text-center py-8">
              <Loader className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
              <p className="text-gray-600 dark:text-gray-400">Loading Excel metadata...</p>
            </div>
          )}

          {/* Sheet Selection */}
          {currentStep === 'selectSheet' && excelMetadata && !error && (
            <div className="space-y-6">
              <div className="text-center">
                <FileSpreadsheet className="w-12 h-12 text-blue-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Step 1: Select the sheet containing questions
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Your Excel file "{excelMetadata.filename}" has {excelMetadata.sheets.length} sheets. Please select the one containing questions.
                </p>
              </div>
              
              <div className="max-w-md mx-auto">
                <Select value={selectedSheetName} onValueChange={handleSheetSelection}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a sheet..." />
                  </SelectTrigger>
                  <SelectContent>
                    {excelMetadata.sheets.map((sheet) => (
                      <SelectItem key={sheet.name} value={sheet.name}>
                        {sheet.name} ({sheet.rowCount} rows)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Column Selection */}
          {currentStep === 'selectColumn' && selectedSheetName && excelMetadata && !error && (
            <div className="space-y-6">
              <div className="text-center">
                <CheckCircle className="w-8 h-8 text-green-600 mx-auto mb-2" />
                <p className="text-sm text-green-600 dark:text-green-400 mb-4">Sheet "{selectedSheetName}" selected</p>
                
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Step 2: Select the column containing questions
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Choose the column that contains the questions you want the AI to answer.
                </p>
              </div>
              
              <div className="max-w-md mx-auto">
                <Select value={selectedColumnName} onValueChange={handleColumnSelection}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a column..." />
                  </SelectTrigger>
                  <SelectContent>
                    {excelMetadata.sheets.find(s => s.name === selectedSheetName)?.columns.map((column) => (
                      <SelectItem key={column} value={column}>
                        {column}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedColumnName && (
                <div className="text-center">
                  <Button
                    onClick={processQAQuestions}
                    className="bg-green-600 hover:bg-green-700"
                    disabled={isProcessing}
                  >
                    {isProcessing ? (
                      <>
                        <Loader className="w-4 h-4 animate-spin mr-2" />
                        Processing Questions...
                      </>
                    ) : (
                      'Start Processing Questions'
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Processing */}
          {currentStep === 'processing' && !error && (
            <div className="space-y-6">
              {/* Previous Steps Summary */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  <div className="text-sm">
                    <span className="text-green-700 dark:text-green-300 font-medium">Sheet:</span>{' '}
                    <span className="text-gray-700 dark:text-gray-300">{selectedSheetName}</span>
                  </div>
                </div>
                
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <CheckCircle className="w-4 h-4 text-green-600" />
                  <div className="text-sm">
                    <span className="text-green-700 dark:text-green-300 font-medium">Column:</span>{' '}
                    <span className="text-gray-700 dark:text-gray-300">{selectedColumnName}</span>
                  </div>
                </div>
              </div>

              <div className="text-center">
                <Loader className="w-8 h-8 animate-spin text-blue-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Processing Questions with AI Agent
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  The backend is processing all questions. This may take a few minutes...
                </p>
              </div>
            </div>
          )}

          {/* Completed */}
          {currentStep === 'completed' && questions.length > 0 && (
            <div className="space-y-6">
              <div className="text-center">
                <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Q&A Processing Complete!
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-6">
                  {questions.filter(q => q.status === 'completed').length} of {questions.length} questions processed successfully.
                </p>
              </div>

              {/* Results */}
              <div className="max-h-96 overflow-y-auto space-y-4">
                {questions.map((qa, index) => (
                  <div 
                    key={index}
                    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg"
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-1">
                        {qa.status === 'completed' && (
                          <CheckCircle className="w-4 h-4 text-green-600" />
                        )}
                        {qa.status === 'error' && (
                          <AlertCircle className="w-4 h-4 text-red-600" />
                        )}
                      </div>
                      <div className="flex-1">
                        <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                          Q{index + 1}: {qa.question}
                        </p>
                        <div className={`text-sm ${qa.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'}`}>
                          <strong>A:</strong> {qa.answer}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-center">
                <Button variant="outline" onClick={handleClose}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}