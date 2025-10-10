import React from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { X, ExternalLink } from "lucide-react"

import { AgentTool, AgentToolData } from "./Types"
interface ExistingAgentConfigUIProps {
    isVisible: boolean
    onClose: () => void
    toolData?: AgentTool
}
// ✅ Type for AI agent tool data
const ExistingAgentConfigUI: React.FC<ExistingAgentConfigUIProps> = ({
    isVisible,
    onClose,
    toolData,
}) => {
    // Extract agent info from toolData
    const agentData: Partial<AgentToolData>  = toolData?.val || toolData?.value || toolData?.config || {}

    const agentId = agentData.agentId
    const agentName = agentData.name || "Unknown Agent"
    const agentDescription = agentData.description || "No description"
    const agentModel = agentData.model || "Unknown Model"

    const handleEditAgent = () => {
        if (agentId) {
            window.open(`/agent?agentId=${agentId}&mode=edit`, '_blank')  // ✅ Correct URL format
        }
    }

    return (
        <div
            className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l 
  border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden z-50 ${isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
                }`}
        >
            {/* Header */}
            <div className="flex items-center border-b p-5">
                <h2 className="flex-1 text-gray-900 dark:text-gray-100 font-semibold text-base">
                    Existing Agent
                </h2>
                <button onClick={onClose} className="p-0 border-none bg-transparent cursor-pointer">
                    <X className="w-5 h-5 text-gray-600 dark:text-gray-400" />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col">
                <div className="space-y-6 flex-1">
                    {/* Agent Name - Read-only */}
                    <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                            Agent Name
                        </Label>
                        <div className="w-full p-3 bg-slate-50 dark:bg-gray-800 border border-slate-200 
  dark:border-gray-700 rounded-md text-sm text-slate-900 dark:text-gray-300">
                            {agentName}
                        </div>
                    </div>

                    {/* Agent Description - Read-only */}
                    <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                            Agent Description
                        </Label>
                        <div className="w-full p-3 bg-slate-50 dark:bg-gray-800 border border-slate-200 
  dark:border-gray-700 rounded-md text-sm text-slate-900 dark:text-gray-300 min-h-[80px]">
                            {agentDescription}
                        </div>
                    </div>

                    {/* Model - Read-only */}
                    <div className="space-y-2">
                        <Label className="text-sm font-medium text-slate-700 dark:text-gray-300">
                            Model
                        </Label>
                        <div className="w-full p-3 bg-slate-50 dark:bg-gray-800 border border-slate-200 
  dark:border-gray-700 rounded-md text-sm text-slate-900 dark:text-gray-300">
                            {agentModel}
                        </div>
                    </div>

                    {/* Info message */}
                    <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 
  rounded-md">
                        <p className="text-sm text-blue-700 dark:text-blue-300">
                            This is a reference to an existing agent. To modify this agent, click the "Edit Agent" button
                            below.
                        </p>
                    </div>
                </div>

                {/* Edit Agent Button - Sticky to bottom */}
                <div className="pt-6 px-0">
                    <Button
                        onClick={handleEditAgent}
                        className="w-full bg-gray-900 hover:bg-gray-800 dark:bg-gray-700 dark:hover:bg-gray-600 
  text-white rounded-full flex items-center justify-center gap-2"
                    >
                        Edit Agent
                        <ExternalLink className="w-4 h-4" />
                    </Button>
                </div>
            </div>
        </div>
    )
}

export default ExistingAgentConfigUI