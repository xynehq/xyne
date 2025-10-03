import React, { useState, useEffect } from "react"
  import { api } from "@/api"
  import { X, Search,  Bot} from "lucide-react"

    const Logger = console
  interface Agent {
    externalId: string
    name: string
    description?: string
    model?: string
    creation_source?: string
  }

  interface AgentsSidebarProps {
    isVisible: boolean
    onClose?: () => void
    onAgentSelect?: (agent: Agent) => void
  }

  export const AgentsSidebar: React.FC<AgentsSidebarProps> = ({
    isVisible,
    onClose,
    onAgentSelect,
  }) => {
    const [agents, setAgents] = useState<Agent[]>([])
    const [loading, setLoading] = useState(false)
    const [searchTerm, setSearchTerm] = useState("")

    // Fetch agents when sidebar opens
    useEffect(() => {
      const fetchAgents = async () => {
        Logger.info("Fetching agents...")
        if (!isVisible) return

        setLoading(true)
        try {
          const response = await api.agents.$get({ query: { filter: "all" } })
          if (response.ok) {
            Logger.info("Fetched agents successfully")
            const data = (await response.json()) as Agent[]
            // Filter agents where creation_source="direct"
           Logger.info("agents data", data)
            setAgents(data)
          }
        } catch (error) {
          console.error('Failed to fetch agents:', error)
        } finally {
          setLoading(false)
        }
      }

      fetchAgents()
    }, [isVisible])

    // Filter agents based on search
    const filteredAgents = agents.filter(agent =>
      agent.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      agent.description?.toLowerCase().includes(searchTerm.toLowerCase())
    )

    return (
      <div
        className={`fixed top-[80px] right-0 h-[calc(100vh-80px)] bg-white dark:bg-gray-900 border-l 
  border-slate-200 dark:border-gray-700 flex flex-col overflow-hidden transition-all duration-300 ease-in-out z-40
   ${
          isVisible ? "translate-x-0 w-[380px]" : "translate-x-full w-0"
        }`}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 border-b border-slate-200 dark:border-gray-700">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 tracking-wider uppercase">
              SELECT AGENTS
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
            Choose a direct agent to add to your workflow.
          </div>
        </div>

        {/* Search */}
        <div className="px-6 py-4 border-b border-slate-200 dark:border-gray-700">
          <div className="relative">
            <input
              type="text"
              placeholder="Search agents..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 h-10 bg-white dark:bg-gray-800 border border-gray-300
  dark:border-gray-600 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-600 dark:focus:ring-gray-400
  focus:border-gray-600 dark:focus:border-gray-400 text-gray-900 dark:text-gray-100"
            />
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400 dark:text-gray-500" />
            </div>
          </div>
        </div>

        {/* Agents List */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="text-gray-500 dark:text-gray-400">Loading agents...</p>
            </div>
          ) : filteredAgents.length > 0 ? (
            <div className="space-y-2">
              {filteredAgents.map((agent) => (
                <div
                  key={agent.externalId}
                  onClick={() => onAgentSelect?.(agent)}
                  className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all duration-150
  bg-transparent hover:bg-slate-50 dark:hover:bg-gray-800 border border-transparent hover:border-slate-200
  dark:hover:border-gray-700"
                >
                  <div className="w-8 h-8 bg-blue-100 dark:bg-blue-900/50 rounded-lg flex items-center 
  justify-center flex-shrink-0">
                    <Bot className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-700 dark:text-gray-300 leading-5 truncate">
                      {agent.name}
                    </div>
                    {agent.description && (
                      <div className="text-xs text-slate-500 dark:text-gray-400 leading-4 mt-1 line-clamp-2">
                        {agent.description}
                      </div>
                    )}
                    <div className="text-xs text-slate-400 dark:text-gray-500 mt-1">
                      Model: {agent.model || 'Default'}
                    </div>
                  </div>
                  <div className="text-slate-400 dark:text-gray-500">
                    <svg
                      className="w-4 h-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400">
                {searchTerm ? `No agents found matching "${searchTerm}"` : "No direct agents available"}
              </p>
            </div>
          )}
        </div>
      </div>
    )
  }