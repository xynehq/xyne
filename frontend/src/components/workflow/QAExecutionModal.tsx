import { useState, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X, Bot, FileSpreadsheet, AlertCircle, CheckCircle, Loader } from "lucide-react"

interface QAExecutionModalProps {
  isOpen: boolean
  onClose: () => void
  stepId: string
  toolId: string
  workflowData?: any // Full workflow execution data
  onProgress?: () => void // Callback to trigger polling from parent
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
export function QAExecutionModal({
  isOpen,
  onClose,
  stepId,
  toolId,
  workflowData,
  onProgress,
}: QAExecutionModalProps) {
  // State for user selections and local errors (these remain as state since they're user inputs)
  const [selectedSheetName, setSelectedSheetName] = useState<string>('')
  const [selectedColumnName, setSelectedColumnName] = useState<string>('')
  const [localError, setLocalError] = useState<string | null>(null)


  const stepData = workflowData?.stepExecutions?.find((step: any) => 
    step.id === stepId
  )
  const toolData = workflowData?.toolExecutions?.find((toolExec: any) => 
    toolExec.id === toolId
  )

  
  // Get step status from stepData  
  const stepStatus = stepData?.status
  
  // Computed state derived from props
  const excelMetadata = useMemo(() => {
    // Extract metadata from toolData.result
    if (toolData?.result) {
      return toolData.result.qaMetadata || 
             toolData.result.excelMetadata ||
             toolData.result.metadata ||
             (toolData.result.awaitingUserSelection && toolData.result.sheets ? {
               filename: toolData.result.filename || 'Excel File',
               fileId: toolData.result.fileId || '',
               filePath: toolData.result.filePath || '',
               sheets: toolData.result.sheets || []
             } : null)
    }
    return null
  }, [toolData])

  const questions = useMemo(() => {
    if (stepStatus === 'completed' && toolData?.result?.qaResults) {
      const qaResults = toolData.result.qaResults
      return qaResults.questionsAndAnswers.map((qa: any) => ({
        question: qa.question,
        answer: qa.answer,
        status: qa.answer.startsWith('Error:') || qa.answer.includes('Failed to get answer') ? 'error' : 'completed'
      }))
    }
    return []
  }, [stepStatus, toolData])

  const error = useMemo(() => {
    // Local error takes priority (user-triggered errors)
    if (localError) return localError
    
    // Then check prop-derived errors
    if (!isOpen) return null
    if (stepStatus === 'failed') {
      if (toolData?.result?.error) return toolData.result.error
      if (!toolData?.result?.awaitingUserSelection) return 'Q&A processing failed'
    }
    if (stepStatus && !['completed', 'processing', 'failed', 'active'].includes(stepStatus)) {
      return `Unexpected step status: ${stepStatus}`
    }
    return null
  }, [localError, isOpen, stepStatus, toolData])

  const currentStep = useMemo(() => {
    if (!isOpen) return 'loading'
    if (stepStatus === 'completed') {
      return 'completed'
    }
    if (stepStatus === 'processing') return 'processing'
    if (stepStatus === 'failed') {
      if (toolData?.result?.awaitingUserSelection && toolData?.result?.qaMetadata) return 'selectSheet'
      return 'completed' // Show error state
    }
    if (stepStatus === 'active') {
      if (excelMetadata) {
        // If both sheet and column are selected, show column selection with button
        if (selectedSheetName && selectedColumnName) return 'selectColumn'
        // If sheet is selected but no column, show column selection
        if (selectedSheetName && !selectedColumnName) return 'selectColumn'
        // If no sheet is selected, show sheet selection
        return 'selectSheet'
      }
      return 'loading'
    }
    
    const result = 'loading'
    return result
  }, [isOpen, stepStatus, toolData, excelMetadata, selectedSheetName, selectedColumnName])

  const isProcessing = stepStatus === 'processing'

  // Agent info
  const agentName = toolData?.result?.agentName
  const agentId = toolData?.result?.agentId
  const executionId = workflowData?.id || workflowData?.execution?.id || stepData?.executionId
  

  // Function to process questions with the new async backend API
  const processQAQuestions = async () => {
    if (!selectedSheetName || !selectedColumnName || !agentId || !executionId) {
      const missing = []
      if (!selectedSheetName) missing.push('selectedSheetName')
      if (!selectedColumnName) missing.push('selectedColumnName') 
      if (!agentId) missing.push('agentId')
      if (!executionId) missing.push('executionId')
      
      const errorMsg = `Missing required information: ${missing.join(', ')}`
      setLocalError(errorMsg)
      return
    }

    setLocalError(null)

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
        // Processing started successfully - trigger parent polling
        onProgress?.()
      } else if (result.status === 'completed' && result.data) {
        // Already completed - show results immediately
        // Results will be shown via props when polling updates
      } else {
        throw new Error(`Unexpected response status: ${result.status}`)
      }

    } catch (error) {
      console.error('Error processing Q&A questions:', error)
      setLocalError(`Failed to start Q&A processing: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  const handleSheetSelection = (sheetName: string) => {
    setSelectedSheetName(sheetName)
    setSelectedColumnName('') // Reset column selection
    setLocalError(null) // Clear any previous errors
  }

  const handleColumnSelection = (columnName: string) => {
    setSelectedColumnName(columnName)
  }

  const handleClose = () => {
    // Reset user selections and local state
    setSelectedSheetName('')
    setSelectedColumnName('')
    setLocalError(null)
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
                    {excelMetadata.sheets.map((sheet: ExcelSheetMeta) => (
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
                    {excelMetadata.sheets.find((s: ExcelSheetMeta) => s.name === selectedSheetName)?.columns.map((column: string) => (
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
          {(() => {
            return currentStep === 'completed' && questions.length > 0
          })() && (
            <div className="space-y-6">
              <div className="text-center">
                <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                  Q&A Processing Complete!
                </h3>
                <p className="text-gray-600 dark:text-gray-400 mb-6">
                  {questions.filter((q: QAQuestion) => q.status === 'completed').length} of {questions.length} questions processed successfully.
                </p>
              </div>

              {/* Results */}
              <div className="max-h-96 overflow-y-auto space-y-4">
                {questions.map((qa: QAQuestion, index: number) => (
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