import React from "react"
import {
  Bot,
  Mail,
  Globe,
  GitBranch,
  Code,
  Users,
  ChevronRight,
  X,
} from "lucide-react"

interface WhatHappensNextUIProps {
  isVisible: boolean
  onClose: () => void
  onSelectAction: (actionId: string) => void
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
}) => {
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
            What Happens Next?
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 rounded-md transition-colors"
          >
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>
      </div>

      {/* Actions List */}
      <div className="flex-1 overflow-y-auto px-6 py-4 flex flex-col gap-1">
        {/* Available Actions */}
        {availableActions.map((action) => (
          <div
            key={action.id}
            onClick={() => onSelectAction(action.id)}
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
    </div>
  )
}

export default WhatHappensNextUI
