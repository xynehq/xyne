import React, { useState } from "react"
import {
  Bot,
  Mail,
  Globe,
  GitBranch,
  Code,
  Users,
  ChevronRight,
  X,
  ArrowLeft,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { workflowStepsAPI } from "./api/ApiHandlers"

interface WhatHappensNextUIProps {
  isVisible: boolean
  onClose: () => void
  onSelectAction: (actionId: string) => void
  selectedNodeId?: string | null
  toolType?: string
  toolData?: any
  selectedTemplate?: any // For API calls
  onStepCreated?: (stepData: any) => void // Callback after step creation
}

interface NextAction {
  id: string
  name: string
  description: string
  icon: React.ReactNode
  isComingSoon?: boolean
}

const WhatHappensNextUI: React.FC<WhatHappensNextUIProps> = ({
  isVisible,
  onClose,
  onSelectAction,
  selectedNodeId,
  toolType,
  toolData,
  selectedTemplate,
  onStepCreated,
}) => {
  // State for different tool configurations
  const [pythonConfig, setPythonConfig] = useState({
    pythonCode: toolData?.value || "",
  })



  const [selectedAction, setSelectedAction] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  // Reset form states when component becomes visible or when selectedNodeId changes
  React.useEffect(() => {
    if (isVisible) {
      // Reset all form states to default values
      setPythonConfig({
        pythonCode: toolData?.value || "",
      })
      setSelectedAction(null)
      setIsSaving(false)
    }
  }, [isVisible, selectedNodeId, toolData])

  // Check if we should show Python code config
  const showPythonConfig =
    toolType === "python_code" || toolType === "python_script"

  // Handle save configuration - calls API and creates visual step
  const handleSaveConfiguration = async () => {
    if (!selectedNodeId) {
      console.error("Missing node ID")
      return
    }

    setIsSaving(true)

    try {
      let stepData = null

      if (showPythonConfig) {
        // Save Python code step
        stepData = {
          name: "Python Script",
          description: "Custom Python script execution",
          type: "python_script",
          tool: {
            type: "python_script",
            value: {
              code: pythonConfig.pythonCode,
            },
            config: {
              language: "python",
              timeout: 300,
            },
          },
          prevStepIds: [selectedNodeId],
          timeEstimate: 180,
          metadata: {
            icon: "🐍",
            step_order: 999,
            automated_description: "Python script execution",
          },
        }
      }

      if (stepData) {
        console.log("Creating visual step with data:", stepData)

        // Call callback to create visual step FIRST
        if (onStepCreated) {
          onStepCreated(stepData)
        }

        // Try to save to API if template is available, but don't block UI updates
        if (selectedTemplate) {
          try {
            console.log("Saving step to API:", stepData)
            const response = await workflowStepsAPI.createStep(
              selectedTemplate.id,
              stepData,
            )
            console.log("Step created successfully:", response)
          } catch (error) {
            console.error("Failed to save step to API:", error)
            // Continue with UI update even if API call fails
          }
        }

        // Close the sidebar
        onClose()
      }
    } catch (error) {
      console.error("Failed to save step:", error)
    } finally {
      setIsSaving(false)
    }
  }

  // Available actions (currently functional)
  const availableActions: NextAction[] = [
    {
      id: "ai_agent",
      name: "AI Agent",
      description: "Build autonomous agents, summarise or search documents etc",
      icon: <Bot className="w-5 h-5" />,
    },
    {
      id: "email",
      name: "Email",
      description: "Send emails to added mails",
      icon: <Mail className="w-5 h-5" />,
    },
  ]

  // Coming soon actions (upcoming features)
  const comingSoonActions: NextAction[] = [
    {
      id: "http_requests",
      name: "HTTP Requests",
      description: "HTTP requests, set webhooks",
      icon: <Globe className="w-5 h-5" />,
      isComingSoon: true,
    },
    {
      id: "conditionals",
      name: "Conditionals",
      description: "Branch, merge or loop the flow etc",
      icon: <GitBranch className="w-5 h-5" />,
      isComingSoon: true,
    },
    {
      id: "run_script",
      name: "Run Script/Code",
      description: "Run code or scripts",
      icon: <Code className="w-5 h-5" />,
      isComingSoon: true,
    },
    {
      id: "human_loop",
      name: "Human in the loop",
      description: "Wait for approval or human input before continuing",
      icon: <Users className="w-5 h-5" />,
      isComingSoon: true,
    },
  ]

  return (
    <div
      className={`h-full bg-white border-l border-slate-200 flex flex-col overflow-hidden transition-transform duration-300 ease-in-out ${
        isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
      }`}
    >
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-200">
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-sm font-semibold text-gray-700 tracking-wider uppercase">
            {showPythonConfig
              ? "Python Code Configuration"
              : "What Happens Next?"}
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
      </div>

      {/* Conditional Content Based on Tool Type */}
      {showPythonConfig ? (
        /* Python Code Configuration */
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <div className="space-y-6">
            {/* Python Code */}
            <div className="space-y-2">
              <Label
                htmlFor="python-code"
                className="text-sm font-medium text-slate-700"
              >
                Python Code
              </Label>
              <Textarea
                id="python-code"
                value={pythonConfig.pythonCode}
                onChange={(e) =>
                  setPythonConfig((prev) => ({
                    ...prev,
                    pythonCode: e.target.value,
                  }))
                }
                placeholder="# Enter your Python code here
print('Hello, World!')"
                className="w-full h-96 font-mono text-sm"
              />
            </div>

            {/* Save Button */}
            <div className="flex gap-2 pt-4">
              <Button
                onClick={handleSaveConfiguration}
                disabled={isSaving}
                className="flex-1"
              >
                {isSaving ? "Saving..." : "Save Configuration"}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        /* Default Actions List */
        <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-1">
          {/* Available Actions */}
          {availableActions.map((action) => (
            <div
              key={action.id}
              onClick={() => {
                if (action.id === "ai_agent" || action.id === "email") {
                  // For AI Agent and Email, trigger custom event to open respective ConfigUI
                  onSelectAction(action.id)
                  onClose() // Close WhatHappensNextUI
                } else {
                  setSelectedAction(action.id)
                }
              }}
              className="flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-150 min-h-[60px] bg-transparent hover:bg-slate-50 text-slate-700 cursor-pointer"
            >
              <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 text-slate-500">
                {action.icon}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium leading-5 text-slate-700">
                  {action.name}
                </div>
                <div className="text-xs leading-4 mt-1 text-slate-500">
                  {action.description}
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
            </div>
          ))}

          {/* Coming Soon Section */}
          <div className="mt-6 mb-4">
            <div className="text-xs font-semibold text-slate-500 tracking-wider uppercase mb-3">
              COMING SOON
            </div>
          </div>

          {/* Coming Soon Actions */}
          {comingSoonActions.map((action) => (
            <div
              key={action.id}
              className="flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-150 min-h-[60px] bg-transparent text-slate-400 cursor-not-allowed opacity-60"
            >
              <div className="w-5 h-5 flex items-center justify-center flex-shrink-0 text-slate-400">
                {action.icon}
              </div>
              <div className="flex-1">
                <div className="text-sm font-medium leading-5 text-slate-400">
                  {action.name}
                </div>
                <div className="text-xs leading-4 mt-1 text-slate-400">
                  {action.description}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default WhatHappensNextUI
