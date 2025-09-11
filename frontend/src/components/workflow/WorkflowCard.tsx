import { useState } from "react"
import { Button } from "@/components/ui/button"
import { WorkflowExecutionModal } from "./WorkflowExecutionModal"
import botLogo from "@/assets/bot-logo.svg"

interface WorkflowTemplate {
  id: string
  name: string
  description: string
  version: string
  status: string
  config: {
    ai_model?: string
    max_file_size?: string
    auto_execution?: boolean
    schema_version?: string
    allowed_file_types?: string[]
    supports_file_upload?: boolean
  }
  createdBy: string
  rootWorkflowStepTemplateId: string
  createdAt: string
  updatedAt: string
  rootStep?: {
    id: string
    workflowTemplateId: string
    name: string
    description: string
    type: string
    timeEstimate: number
    metadata: {
      icon?: string
      step_order?: number
      schema_version?: string
      user_instructions?: string
    }
    tool?: {
      id: string
      type: string
      value: any
      config: any
      createdBy: string
      createdAt: string
      updatedAt: string
    }
  }
}

interface WorkflowCardProps {
  workflow: WorkflowTemplate
  onViewClick?: (templateId: string) => void
}

export function WorkflowCard({ workflow, onViewClick }: WorkflowCardProps) {
  const [showExecutionModal, setShowExecutionModal] = useState(false)

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


  return (
    <div
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow rounded-2xl p-6 flex flex-col min-h-52 w-full"
    >
      <div className="flex flex-col flex-1">
        <div className="w-10 h-10 bg-[#F2F2F3] dark:bg-blue-900/20 rounded-lg flex items-center justify-center mb-5">
          {getTemplateIcon()}
        </div>

        <div className="flex-1 space-y-1">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-base leading-tight">
            {workflow.name}
          </h3>

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
      />
    </div>
  )
}
