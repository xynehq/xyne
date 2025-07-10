import { Card, CardTitle } from "@/components/ui/card"
import { SelectPublicAgent } from "shared/types"
import { Star } from "lucide-react"

const getIconStyling = (agentName: string) => {
  // Simple hash function to get a color based on agent name
  let hash = 0
  for (let i = 0; i < agentName.length; i++) {
    hash = agentName.charCodeAt(i) + ((hash << 5) - hash)
    hash = hash & hash // Convert to 32bit integer
  }
  const colors = [
    "bg-blue-100 text-blue-500 dark:bg-blue-900/50 dark:text-blue-400",
    "bg-green-100 text-green-500 dark:bg-green-900/50 dark:text-green-400",
    "bg-purple-100 text-purple-500 dark:bg-purple-900/50 dark:text-purple-400",
    "bg-orange-100 text-orange-500 dark:bg-orange-900/50 dark:text-orange-400",
    "bg-pink-100 text-pink-500 dark:bg-pink-900/50 dark:text-pink-400",
    "bg-cyan-100 text-cyan-500 dark:bg-cyan-900/50 dark:text-cyan-400",
    "bg-red-100 text-red-500 dark:bg-red-900/50 dark:text-red-400",
    "bg-yellow-100 text-yellow-500 dark:bg-yellow-900/50 dark:text-yellow-400",
  ]
  return (
    colors[Math.abs(hash) % colors.length] ||
    "bg-gray-100 text-gray-500 dark:bg-slate-700 dark:text-slate-300"
  )
}

export const AgentIconDisplay = ({
  agentName,
  size = "small",
}: { agentName: string; size?: "default" | "small" }) => {
  const styling = getIconStyling(agentName)
  const sizeClasses = size === "small" ? "w-8 h-8" : "w-10 h-10" // Corresponds to image
  const textSizeClasses = size === "small" ? "text-sm" : "text-lg" // Corrected: text-sm for small icons
  return (
    <div
      className={`${sizeClasses} rounded-md flex items-center justify-center ${styling} flex-shrink-0`}
    >
      <span className={`${textSizeClasses} font-semibold`}>
        {agentName.charAt(0).toUpperCase()}
      </span>
    </div>
  )
}

export function AgentCard({
  agent,
  isFavorite,
  onToggleFavorite,
  onClick,
}: {
  agent: SelectPublicAgent
  isFavorite: boolean
  onToggleFavorite: (id: string) => void
  onClick: () => void
}) {
  return (
    <Card
      className="bg-gray-50 dark:bg-slate-800 p-6 rounded-3xl relative hover:bg-gray-100 dark:hover:bg-slate-700/60 transition-colors flex flex-col border-none shadow-none cursor-pointer h-full"
      onClick={onClick}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite(agent.externalId)
        }}
        className="absolute top-4 right-4 text-amber-400 hover:text-amber-500 z-10"
      >
        <Star fill={isFavorite ? "currentColor" : "none"} size={20} />
      </button>
      <div>
        <AgentIconDisplay agentName={agent.name} size="default" />
        <div className="mt-4">
          <CardTitle
            className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate"
            title={agent.name}
          >
            {agent.name}
          </CardTitle>
        </div>
        <p className="text-gray-500 dark:text-gray-400 text-sm mt-1 line-clamp-2 min-h-10">
          {agent.description || <span className="italic">No description</span>}
        </p>
      </div>
    </Card>
  )
}
