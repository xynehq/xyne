import { useState } from "react"
import { Button } from "@/components/ui/button"
import { WorkflowExecutionModal } from "./WorkflowExecutionModal"
import botLogo from "@/assets/bot-logo.svg"

interface WorkflowData {
  id: string
  name: string
  description: string
  status: "active" | "inactive" | "scheduled" | "draft"
  lastRun?: string
  createdAt: string
  updatedAt: string
  runCount: number
  icon?: string
  color?: string
}

interface WorkflowCardProps {
  workflow: WorkflowData
}

export function WorkflowCard({ workflow }: WorkflowCardProps) {
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

  return (
    <div
      className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:shadow-md transition-shadow rounded-2xl p-6 flex flex-col justify-between h-52"
      style={{ width: "327px" }}
    >
      <div className="flex flex-col space-y-5">
        <div className="w-10 h-10 bg-[#F2F2F3] dark:bg-blue-900/20 rounded-lg flex items-center justify-center">
          <img src={botLogo} alt="Bot" className="w-6 h-6" />
        </div>

        <div className="space-y-1">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-base">
            {workflow.name}
          </h3>

          <p className="text-sm text-gray-500 dark:text-gray-400">
            Edited at {formatDate(workflow.updatedAt)}
          </p>
        </div>
      </div>

      <div className="flex gap-2 mt-5">
        <Button
          size="sm"
          className="bg-gray-800 hover:bg-gray-700 text-white"
          onClick={() => setShowExecutionModal(true)}
        >
          Run
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-gray-300 dark:border-gray-600"
        >
          View
        </Button>
      </div>

      <WorkflowExecutionModal
        isOpen={showExecutionModal}
        onClose={() => setShowExecutionModal(false)}
        workflowName={workflow.name}
        workflowDescription={workflow.description}
      />
    </div>
  )
}
