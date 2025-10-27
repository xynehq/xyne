import { useState } from "react"
import { Button } from "@/components/ui/button"
import { WorkflowExecutionModal } from "./WorkflowExecutionModal"
import { WorkflowShareModal } from "./WorkflowShareModal"
import { ConfirmationPopup } from "@/components/ui/ConfirmationPopup"
import botLogo from "@/assets/bot-logo.svg"
import { WorkflowCardProps } from "./Types"
import { Users, Lock, Share2 } from "lucide-react"

export function WorkflowCard({
  workflow,
  onViewClick,
  onViewExecution,
}: WorkflowCardProps) {
  const [showExecutionModal, setShowExecutionModal] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [showSuccessPopup, setShowSuccessPopup] = useState(false)

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return (
      date.toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      }) +
      " " +
      date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    )
  }

  const getTemplateIcon = () => {
    // Always use bot-logo.svg for workflow cards
    return <img src={botLogo} alt="Bot Logo" className="w-5 h-5" />
  }

  // Check if workflow is public
  const isPublic = workflow.isPublic === true
  
  // Check if user can share this workflow (owned and not public)
  const canShare = workflow.role === "owner" && !workflow.isPublic

  const isShared = workflow.role === "shared" && !workflow.isPublic

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow rounded-2xl p-6 flex flex-col min-h-56 w-full max-w-[450px]">
      <div className="flex flex-col flex-1">
        {/* Icon, Visibility Badge, and Menu */}
        <div className="flex items-start justify-between mb-5">
          <div className="w-10 h-10 bg-[#F2F2F3] dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
            {getTemplateIcon()}
          </div>

          <div className="flex items-center gap-2">
            {/* Visibility Badge */}
            {isPublic ? (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-gray-600">
                <Users className="w-3 h-3" />
                <span>Public</span>
              </div>
            ) : isShared? (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-gray-600">
                <Users className="w-3 h-3" />
                <span>Shared</span>
              </div>
              ) : (
              <div className="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-50 dark:bg-gray-700 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-600">
                <Lock className="w-3 h-3" />
                <span>Private</span>
              </div>
            )}

            {/* Share Icon */}
            {canShare && (
              <button 
                onClick={() => setShowShareModal(true)}
                className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
                title="Share workflow"
              >
                <Share2 className="w-4 h-4 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 space-y-1">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-base leading-tight">
            {workflow.name}
          </h3>

          {/* Show "shared by" section for shared workflows */}
          {workflow.SharedUserMetadata && (
            <div className="relative group">
              <p className="text-sm text-gray-600 dark:text-gray-400 font-medium">
                Shared by{' '}
                <button
                  className="border border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-900/20 px-1.5 py-0.5 rounded-full transition-colors text-gray-600 dark:text-gray-400"
                >
                  {workflow.SharedUserMetadata.name}
                </button>
              </p>
              
              {/* Tooltip on hover */}
              <div className="absolute bottom-full left-0 mb-2 px-2 py-1 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-xs rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                {workflow.SharedUserMetadata.email}
                <div className="absolute top-full left-2 w-0 h-0 border-l-2 border-r-2 border-t-2 border-transparent border-t-gray-900 dark:border-t-gray-100"></div>
              </div>
            </div>
          )}

          <p className="text-sm text-gray-500 dark:text-gray-400">
            Edited at {formatDate(workflow.updatedAt)}
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-5 pt-2 border-t border-transparent">
        <Button
          size="sm"
          className="bg-gray-800 hover:bg-gray-700 text-white rounded-full w-16 px-3"
          onClick={() => setShowExecutionModal(true)}
        >
          Run
        </Button>
        <Button
          size="sm"
          className="bg-white hover:bg-gray-50 text-gray-800 border border-gray-300 rounded-full w-16 px-3"
          onClick={() => onViewClick?.(workflow.id)}
        >
          View
        </Button>
      </div>

      <WorkflowExecutionModal
        isOpen={showExecutionModal}
        onClose={() => setShowExecutionModal(false)}
        workflowName={workflow.name}
        workflowDescription={workflow.description}
        templateId={workflow.id}
        workflowTemplate={workflow}
        onViewExecution={onViewExecution}
      />

      <WorkflowShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        workflow={workflow}
        onSuccess={() => {
          setShowSuccessPopup(true)
        }}
      />

      <ConfirmationPopup
        isVisible={showSuccessPopup}
        title="Success"
        message="Workflow shared successfully"
        confirmText="OK"
        cancelText="Close"
        onConfirm={() => setShowSuccessPopup(false)}
        onCancel={() => setShowSuccessPopup(false)}
      />
    </div>
  )
}
