import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { ArrowLeft, X, Play, CheckCircle, AlertTriangle, Clock } from "lucide-react"
import { api } from "../../api"

interface TriggerExecutionUIProps {
  isVisible: boolean
  onBack: () => void
  onClose?: () => void
  stepExecutionId: string
  stepName?: string
  builder?: boolean // true for builder mode, false for execution mode
  onTriggerSubmitted?: () => void // Callback to restart polling
}

const TriggerExecutionUI: React.FC<TriggerExecutionUIProps> = ({
  isVisible,
  onBack,
  onClose,
  stepExecutionId,
  stepName = "Trigger Step",
  builder = true,
  onTriggerSubmitted,
}) => {
  const [isTriggering, setIsTriggering] = useState(false)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [triggerStatus, setTriggerStatus] = useState<'pending' | 'triggered' | 'error'>('pending')

  const handleTrigger = async () => {
    console.log("🔍 Trigger button clicked:", { stepExecutionId })
    setIsTriggering(true)
    setTriggerError(null)

    try {
      console.log("🔍 Making trigger API call to:", `/api/v1/workflow/steps/${stepExecutionId}/trigger`)
      const response = await api.workflow.steps[":stepId"].trigger.$post({
        param: { stepId: stepExecutionId }
      })
      console.log("🔍 Trigger API response:", response)
      
      const data = await response.json()
      console.log("🔍 Trigger API response data:", data)

      if (data.success) {
        setTriggerStatus('triggered')
        
        // Call the callback to restart workflow polling
        if (onTriggerSubmitted) {
          onTriggerSubmitted()
        }

        // Auto-close the sidebar after successful trigger
        setTimeout(() => {
          if (onClose) {
            onClose()
          }
        }, 2000)
      } else {
        throw new Error(data.message || 'Failed to trigger step')
      }
    } catch (error: any) {
      console.error('Error triggering step:', error)
      setTriggerError(error.response?.data?.message || error.message || 'Failed to trigger step')
      setTriggerStatus('error')
    } finally {
      setIsTriggering(false)
    }
  }

  const getStatusIcon = () => {
    switch (triggerStatus) {
      case 'triggered':
        return <CheckCircle className="w-5 h-5 text-green-500" />
      case 'error':
        return <AlertTriangle className="w-5 h-5 text-orange-500" />
      default:
        return <Clock className="w-5 h-5 text-blue-500" />
    }
  }

  const getStatusMessage = () => {
    switch (triggerStatus) {
      case 'triggered':
        return 'Step triggered successfully! Workflow will continue.'
      case 'error':
        return triggerError || 'An error occurred while triggering the step.'
      default:
        return 'Click the trigger button to continue the workflow.'
    }
  }

  if (!isVisible) return null

  // In builder mode, don't show any sidebar (return null or empty div)
  if (builder) {
    return null
  }

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
            TRIGGER STEP
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
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Status */}
        <div className="flex items-start space-x-3 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
          {getStatusIcon()}
          <div className="flex-1">
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Manual Trigger Required
            </div>
            <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {getStatusMessage()}
            </div>
          </div>
        </div>

        {/* Trigger Description */}
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Ready to Continue
          </h3>
          <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              This is a manual trigger step. Click the trigger button below to continue the workflow execution.
            </div>
          </div>
        </div>

        {/* Error Message */}
        {triggerError && (
          <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-red-500" />
              <div className="text-sm font-medium text-red-800 dark:text-red-200">
                Error
              </div>
            </div>
            <div className="text-sm text-red-700 dark:text-red-300 mt-1">
              {triggerError}
            </div>
          </div>
        )}
      </div>

      {/* Trigger Button - Only show in execution mode when pending */}
      {triggerStatus === 'pending' && (
        <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <Button
            onClick={handleTrigger}
            disabled={isTriggering}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white"
          >
            {isTriggering ? (
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Triggering...</span>
              </div>
            ) : (
              <div className="flex items-center space-x-2">
                <Play className="w-4 h-4" />
                <span>Trigger</span>
              </div>
            )}
          </Button>
        </div>
      )}

      {/* Success State */}
      {triggerStatus === 'triggered' && (
        <div className="p-6 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="text-center">
            <div className="text-sm text-gray-600 dark:text-gray-400">
              Step triggered successfully! Workflow will continue automatically.
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

export default TriggerExecutionUI