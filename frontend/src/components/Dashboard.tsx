import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useAdminUserSelectionStore } from "@/store/useAdminUserSelectionStore"
import {
  Users,
  Activity,
  MessageSquare,
  Bot,
  ThumbsUp,
  ThumbsDown,
  Search,
  Trophy,
} from "lucide-react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Sidebar } from "@/components/Sidebar"
import {
  safeNumberConversion,
  formatCostInINR,
  formatCostPerMessageInINR,
} from "@/lib/utils"
import {
  AgentUserFeedbackModal,
  UserFeedbackModal,
} from "@/components/feedback/FeedbackViewModal"
import { api } from "@/api"
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Area,
  AreaChart,
} from "recharts"
import type { AdminChat } from "@/components/AdminChatsTable"

interface Chat {
  externalId: string
  title: string
  createdAt: string
  agentId?: string | null
  isBookmarked: boolean
}

interface Agent {
  id: string
  externalId: string
  name: string
  description?: string
  isPublic?: boolean
  createdAt?: string
  userId?: number
  workspaceId?: string
}

interface TimeSeriesData {
  time: string
  totalChats: number
  normalChats: number
  agentChats: number
  totalMessages: number
  normalMessages: number
  agentMessages: number
  totalCost: number
  totalTokens: number
}

// Base interfaces for reusability
interface BaseStatsData {
  totalChats: number
  totalMessages: number
  totalCost: number
  totalTokens: number
}

interface BaseUserData {
  userId: number
  userEmail: string
  userName: string
  chatCount: number
  messageCount: number
  likes: number
  dislikes: number
  totalCost: number
  totalTokens: number
  lastUsed: string
}

interface BaseAgentData {
  agentId: string
  agentName: string
  agentDescription?: string | null
  chatCount: number
  messageCount: number
  likes: number
  dislikes: number
  totalCost: number
  totalTokens: number
  lastUsed: string
}

// Extended interfaces
interface AgentUsageData extends Omit<BaseAgentData, "agentDescription"> {
  // AgentUsageData doesn't need description, so we omit it
}

interface AgentUserUsage extends BaseUserData {
  // No additional properties needed
}

interface FeedbackMessage {
  messageId: string
  chatExternalId: string
  type: "like" | "dislike"
  feedbackText: string[]
  timestamp: string
}

interface FeedbackStats {
  totalLikes: number
  totalDislikes: number
  feedbackByChat: Record<string, { likes: number; dislikes: number }>
  feedbackMessages: FeedbackMessage[]
}

interface DashboardStats extends BaseStatsData {
  activeAgents: number
  normalChats: number
  agentChats: number
  recentActivity: TimeSeriesData[]
  agentUsage: AgentUsageData[]
  feedbackStats: FeedbackStats
}

interface SharedAgentUsageData extends BaseAgentData, BaseStatsData {
  userUsage: AgentUserUsage[]
}

interface SharedAgentUsageStats {
  sharedAgents: SharedAgentUsageData[]
  totalUsage: BaseStatsData & {
    totalLikes: number
    totalDislikes: number
    uniqueUsers: number
  }
}

interface AdminDashboardStats extends BaseStatsData {
  totalUsers: number
  totalAgents: number
  totalSharedAgents: number
  recentActivity: TimeSeriesData[]
  topUsers: AdminUserUsage[]
  agentUsage: AgentUsageData[]
  feedbackStats: FeedbackStats
}

interface AdminUserUsage extends Omit<BaseUserData, "lastUsed"> {
  role: string
  agentChats: number
  normalChats: number
  lastActive: string
  createdAt: string
}

interface UserAgentLeaderboard extends BaseAgentData {
  rank: number
}

interface AgentAnalysisData extends BaseAgentData, BaseStatsData {
  totalUsers: number
  createdAt: string
  userLeaderboard: AgentUserLeaderboard[]
}

interface AgentUserLeaderboard extends BaseUserData {
  rank: number
}

// Shared utility function for calculating date ranges
const getDateRangeFromTimeRange = (
  timeRange: "today" | "1w" | "1m" | "3m" | "all",
  useStartOfDay: boolean = false,
): Date | undefined => {
  const now = new Date()

  switch (timeRange) {
    case "today":
      if (useStartOfDay) {
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        return today
      } else {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate())
      }
    case "1w":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case "1m":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case "3m":
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
    case "all":
      return undefined
    default:
      return undefined
  }
}

// Shared utility function for time range descriptions
const getTimeRangeDescription = (
  timeRange: string,
  isAgentAssisted: boolean = false,
) => {
  const assistanceText = isAgentAssisted
    ? "with agent assistance"
    : "without agent assistance"

  switch (timeRange) {
    case "today":
      return `Hourly message activity ${assistanceText} (today)`
    case "1w":
      return `Daily message activity ${assistanceText} (last 7 days)`
    case "1m":
      return `Daily message activity ${assistanceText} (last month)`
    case "3m":
      return `Weekly message activity ${assistanceText} (last 3 months)`
    case "all":
      return `Monthly message activity ${assistanceText} (all time)`
    default:
      return `Message activity ${assistanceText}`
  }
}

const MetricCard = ({
  title,
  value,
  description,
  icon: Icon,
  trend = null,
  className = "",
}: {
  title: string
  value: string | number
  description: string
  icon: any
  trend?: number | null
  className?: string
}) => (
  <Card className={`${className}`}>
    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
      <CardTitle className="text-sm font-medium">{title}</CardTitle>
      <Icon className="h-4 w-4 text-muted-foreground" />
    </CardHeader>
    <CardContent>
      <div className="text-2xl font-bold">{value}</div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </CardContent>
  </Card>
)

const ShowMoreMetricsToggle = ({
  showMoreMetrics,
  onToggle,
  variant = "default",
  className = "",
}: {
  showMoreMetrics: boolean
  onToggle: () => void
  variant?: "default" | "muted"
  className?: string
}) => {
  const baseClasses =
    "flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors"
  const variantClasses =
    variant === "muted"
      ? "text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg"
      : "text-muted-foreground hover:text-foreground"

  return (
    <div className={`flex justify-center ${className}`}>
      <button onClick={onToggle} className={`${baseClasses} ${variantClasses}`}>
        <span>
          {showMoreMetrics ? "Show Less Metrics" : "Show More Metrics"}
        </span>
        <svg
          className={`h-4 w-4 transition-transform duration-200 ${
            showMoreMetrics ? "rotate-180" : ""
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
    </div>
  )
}

const ExpandableMetricsSection = ({
  showMoreMetrics,
  children,
  className = "",
  variant = "fade",
}: {
  showMoreMetrics: boolean
  children: React.ReactNode
  className?: string
  variant?: "fade" | "slide"
}) => {
  if (variant === "slide") {
    return showMoreMetrics ? <div className={className}>{children}</div> : null
  }

  return (
    <div
      className={`transition-all duration-300 ease-in-out overflow-hidden ${
        showMoreMetrics ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
      } ${className}`}
    >
      {children}
    </div>
  )
}

const MessageActivityChart = ({
  data,
  timeRange,
  type = "normal",
}: {
  data: TimeSeriesData[]
  timeRange: "today" | "1w" | "1m" | "3m" | "all"
  type?: "normal" | "agent"
}) => {
  const isAgent = type === "agent"

  // Configuration based on type
  const config = {
    icon: isAgent ? Bot : Users,
    title: isAgent ? "Agent Message Activity" : "Normal Message Activity",
    emptyTitle: isAgent ? "Agent Chat Activity" : "Normal Chat Activity",
    emptyDescription: isAgent
      ? "Messages with agent assistance"
      : "Chats without agent assistance",
    emptyMessage: isAgent
      ? "No agent message data available"
      : "No normal message data available",
    color: isAgent ? "#10b981" : "#3b82f6",
    gradientId: isAgent ? "colorAgent" : "colorNormal",
    dataKey: isAgent ? "agentMessages" : "normalMessages",
    chatDataKey: isAgent ? "agentChats" : "normalChats",
    tooltipColor: isAgent ? "text-green-400" : "text-blue-400",
    name: isAgent ? "Agent Messages" : "Normal Messages",
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <config.icon className="h-5 w-5" />
            {config.emptyTitle}
          </CardTitle>
          <CardDescription>{config.emptyDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-12 text-muted-foreground">
            <config.icon className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p className="text-sm font-medium">{config.emptyMessage}</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <config.icon className="h-5 w-5" />
          {config.title}
        </CardTitle>
        <CardDescription>
          {getTimeRangeDescription(timeRange, isAgent)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={data}
              margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient
                  id={config.gradientId}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="5%"
                    stopColor={config.color}
                    stopOpacity={0.8}
                  />
                  <stop
                    offset="95%"
                    stopColor={config.color}
                    stopOpacity={0.1}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="currentColor"
                strokeOpacity={0.1}
              />
              <XAxis
                dataKey="time"
                stroke="#64748b"
                fontSize={12}
                tickMargin={8}
              />
              <YAxis stroke="#64748b" fontSize={12} tickMargin={8} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1e293b",
                  border: "none",
                  borderRadius: "8px",
                  color: "#f1f5f9",
                }}
                content={({ active, payload, label }) => {
                  if (active && payload && payload.length) {
                    const data = payload[0].payload
                    return (
                      <div className="bg-slate-800 border-none rounded-lg p-3 text-slate-100">
                        <p className="font-medium">{`Time: ${label}`}</p>
                        <p
                          className={config.tooltipColor}
                        >{`Messages: ${data[config.dataKey]}`}</p>
                        <p className="text-slate-300 text-sm">{`Chats: ${data[config.chatDataKey]}`}</p>
                      </div>
                    )
                  }
                  return null
                }}
              />
              <Area
                type="monotone"
                dataKey={config.dataKey}
                stroke={config.color}
                strokeWidth={2}
                fillOpacity={1}
                fill={`url(#${config.gradientId})`}
                name={config.name}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

const AgentUsageCard = ({
  agentUsage,
  showAll = false,
  onAgentClick,
}: {
  agentUsage: AgentUsageData[]
  showAll?: boolean
  onAgentClick?: (agent: AgentUsageData) => void
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("")

  // Filter agents based on search query
  const filteredAgents = agentUsage.filter((agent) =>
    agent.agentName.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const displayAgents = showAll
    ? filteredAgents.sort((a, b) => b.chatCount - a.chatCount) // Show all filtered agents for admin
    : filteredAgents.sort((a, b) => b.chatCount - a.chatCount).slice(0, 5) // Show top 5 for regular users

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          Top Agents
        </CardTitle>
        <CardDescription>
          {showAll
            ? "All agents by usage (including unused agents)"
            : "Most used agents by message count with feedback"}
        </CardDescription>
        {showAll && (
          <div className="mt-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <input
                type="text"
                placeholder="Search agents..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {displayAgents.length > 0 ? (
          <div
            className={
              showAll ? "max-h-80 overflow-y-auto space-y-4" : "space-y-4"
            }
          >
            {displayAgents.map((agent, index) => (
              <div
                key={agent.agentId}
                className={`flex items-center justify-between p-4 rounded-lg transition-colors ${
                  onAgentClick
                    ? "hover:bg-muted/50 cursor-pointer"
                    : "hover:bg-muted/50"
                }`}
                onClick={() => onAgentClick?.(agent)}
              >
                <div className="flex items-center space-x-4 flex-1">
                  <div className="flex items-center justify-center w-8 h-8 text-sm font-bold text-white bg-gradient-to-br from-green-500 to-blue-600 rounded-full">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4
                      className="text-sm font-medium truncate"
                      title={agent.agentName}
                    >
                      {agent.agentName}
                    </h4>
                    <p className="text-xs text-muted-foreground">
                      Last used: {new Date(agent.lastUsed).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-right">
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {agent.messageCount}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      messages
                    </span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {agent.chatCount}
                    </span>
                    <span className="text-xs text-muted-foreground">chats</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {formatCostInINR(agent.totalCost)}
                    </span>
                    <span className="text-xs text-muted-foreground">cost</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {(agent.totalTokens || 0).toLocaleString()}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      tokens
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <div className="flex items-center gap-1 text-green-600">
                      <ThumbsUp className="h-3 w-3" />
                      <span>{agent.likes}</span>
                    </div>
                    <div className="flex items-center gap-1 text-red-600">
                      <ThumbsDown className="h-3 w-3" />
                      <span>{agent.dislikes}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <Bot className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              {searchQuery
                ? "No agents found matching your search"
                : "No agent usage data"}
            </p>
          </div>
        )}
        {showAll && filteredAgents.length > 0 && (
          <div className="text-xs text-muted-foreground text-center pt-2 border-t">
            Showing {displayAgents.length} of {agentUsage.length} agents
            {searchQuery && ` (filtered from ${agentUsage.length})`}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const SharedAgentUsageCard = ({
  sharedAgentData,
  loading = false,
  timeRange,
  selectedAgent,
  setSelectedAgent,
}: {
  sharedAgentData: SharedAgentUsageStats
  loading?: boolean
  timeRange: "today" | "1w" | "1m" | "3m" | "all"
  selectedAgent: string | null
  setSelectedAgent: (agentId: string | null) => void
}) => {
  const [agentSearchQuery, setAgentSearchQuery] = useState<string>("")
  const [userSearchQuery, setUserSearchQuery] = useState<string>("")
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [showMoreMetrics, setShowMoreMetrics] = useState(false)

  // Reset user search when selected agent changes
  useEffect(() => {
    setUserSearchQuery("")
  }, [selectedAgent])

  // Check if selected agent still exists in new data, if not clear selection
  useEffect(() => {
    if (selectedAgent && sharedAgentData.sharedAgents.length > 0) {
      const agentStillExists = sharedAgentData.sharedAgents.some(
        (agent) => agent.agentId === selectedAgent,
      )
      if (!agentStillExists) {
        setSelectedAgent(null)
      }
    }
  }, [sharedAgentData, selectedAgent, setSelectedAgent])

  // Handle agent selection with smooth transition
  const handleAgentSelect = async (agentId: string) => {
    if (selectedAgent === agentId) {
      // Deselecting current agent
      setIsTransitioning(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      setSelectedAgent(null)
      setIsTransitioning(false)
    } else {
      // Selecting new agent
      setIsTransitioning(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      setSelectedAgent(agentId)
      setIsTransitioning(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Summary Cards - Show immediately with actual structure */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
          <MetricCard
            title="My Agents"
            value="..."
            description="Public agents you created"
            icon={Bot}
          />
          <MetricCard
            title="Total Chats"
            value="..."
            description="Across all shared agents"
            icon={MessageSquare}
          />
          <MetricCard
            title="Total Messages"
            value="..."
            description="All user interactions total"
            icon={Activity}
          />
          <MetricCard
            title="Total Users"
            value="..."
            description="Users who used your agents"
            icon={Users}
          />
          <MetricCard
            title="Total Likes"
            value="..."
            description="Positive feedback received"
            icon={ThumbsUp}
          />
          <MetricCard
            title="Satisfaction"
            value="..."
            description="Loading..."
            icon={ThumbsDown}
          />
        </div>

        {/* Show More Metrics Button - Match actual layout */}
        <ShowMoreMetricsToggle showMoreMetrics={false} onToggle={() => {}} />

        {/* Agent List Loading - Simple skeleton */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Your Shared Agents
            </CardTitle>
            <CardDescription>Loading your agents...</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-center py-12">
              <div className="text-center space-y-4">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto"></div>
                <p className="text-sm text-muted-foreground">
                  Loading agents...
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const { sharedAgents, totalUsage } = sharedAgentData
  const selectedAgentData = selectedAgent
    ? sharedAgents.find((agent) => agent.agentId === selectedAgent)
    : null

  // Filter agents based on search query
  const filteredAgents = sharedAgents.filter(
    (agent) =>
      agent.agentName.toLowerCase().includes(agentSearchQuery.toLowerCase()) ||
      (agent.agentDescription &&
        agent.agentDescription
          .toLowerCase()
          .includes(agentSearchQuery.toLowerCase())),
  )

  // If an agent is selected, show the full page view
  if (selectedAgent) {
    return (
      <div
        className={`transition-all duration-300 ease-in-out ${isTransitioning ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}
      >
        <AgentDetailPage
          agent={selectedAgentData!}
          onBack={() => handleAgentSelect(selectedAgent)}
          userSearchQuery={userSearchQuery}
          setUserSearchQuery={setUserSearchQuery}
        />
      </div>
    )
  }

  return (
    <div
      className={`transition-all duration-300 ease-in-out space-y-6 ${isTransitioning ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}
    >
      {/* Summary Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <MetricCard
          title="My Agents"
          value={sharedAgents.length.toLocaleString()}
          description="Public agents you created"
          icon={Bot}
        />
        <MetricCard
          title="Total Chats"
          value={totalUsage.totalChats.toLocaleString()}
          description="Across all shared agents"
          icon={MessageSquare}
        />
        <MetricCard
          title="Total Messages"
          value={totalUsage.totalMessages.toLocaleString()}
          description="All user interactions total"
          icon={Activity}
        />
        <MetricCard
          title="Total Users"
          value={totalUsage.uniqueUsers.toString()}
          description="Users who used your agents"
          icon={Users}
        />
        <MetricCard
          title="Total Likes"
          value={totalUsage.totalLikes.toLocaleString()}
          description="Positive feedback received"
          icon={ThumbsUp}
        />
        <MetricCard
          title="Satisfaction"
          value={`${
            totalUsage.totalLikes + totalUsage.totalDislikes === 0
              ? 0
              : Math.round(
                  (totalUsage.totalLikes /
                    (totalUsage.totalLikes + totalUsage.totalDislikes)) *
                    100,
                )
          }%`}
          description={`From ${totalUsage.totalLikes + totalUsage.totalDislikes} total ratings`}
          icon={ThumbsDown}
        />
      </div>

      {/* Show More Metrics Button */}
      <ShowMoreMetricsToggle
        showMoreMetrics={showMoreMetrics}
        onToggle={() => setShowMoreMetrics(!showMoreMetrics)}
      />

      {/* Additional Metrics (Expandable) */}
      <ExpandableMetricsSection
        showMoreMetrics={showMoreMetrics}
        className="pt-2"
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Total Cost"
            value={formatCostInINR(totalUsage.totalCost)}
            description="Total LLM usage cost"
            icon={Activity}
          />
          <MetricCard
            title="Total Tokens"
            value={(totalUsage.totalTokens || 0).toLocaleString()}
            description="Total tokens processed"
            icon={Activity}
          />
          <MetricCard
            title="Cost Per Message"
            value={formatCostPerMessageInINR(
              totalUsage.totalCost,
              totalUsage.totalMessages,
            )}
            description="Average cost per message"
            icon={Activity}
          />
          <MetricCard
            title="Tokens Per Message"
            value={
              totalUsage.totalMessages > 0
                ? Math.round(
                    safeNumberConversion(totalUsage.totalTokens) /
                      totalUsage.totalMessages,
                  ).toLocaleString()
                : "0"
            }
            description="Average tokens per message"
            icon={Activity}
          />
        </div>
      </ExpandableMetricsSection>

      {/* Agent List */}
      {sharedAgents.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Your Shared Agents
            </CardTitle>
            <CardDescription>
              Click on an agent to view detailed analytics
            </CardDescription>
            {/* Agent Search */}
            <div className="mt-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
                <input
                  type="text"
                  placeholder="Search agents by name or description..."
                  value={agentSearchQuery}
                  onChange={(e) => setAgentSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {filteredAgents.length > 0 ? (
              <div className="max-h-80 overflow-y-auto space-y-4">
                {filteredAgents.map((agent, index) => (
                  <div
                    key={agent.agentId}
                    className="flex items-center justify-between p-4 rounded-lg transition-colors hover:bg-muted/50 cursor-pointer"
                    onClick={() => handleAgentSelect(agent.agentId)}
                  >
                    <div className="flex items-center space-x-4 flex-1">
                      <div className="flex items-center justify-center w-8 h-8 text-sm font-bold text-white bg-gradient-to-br from-purple-500 to-pink-600 rounded-full">
                        {index + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4
                          className="text-sm font-medium truncate"
                          title={agent.agentName}
                        >
                          {agent.agentName}
                        </h4>
                        <p
                          className="text-xs text-muted-foreground truncate"
                          title={agent.agentDescription || "No description"}
                        >
                          {agent.agentDescription || "No description"}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-right">
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {agent.totalMessages}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          messages
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {agent.totalChats}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          chats
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {agent.userUsage.length}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          users
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {formatCostInINR(agent.totalCost)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          cost
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {(agent.totalTokens || 0).toLocaleString()}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          tokens
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <div className="flex items-center gap-1 text-green-600">
                          <ThumbsUp className="h-3 w-3" />
                          <span>{agent.likes}</span>
                        </div>
                        <div className="flex items-center gap-1 text-red-600">
                          <ThumbsDown className="h-3 w-3" />
                          <span>{agent.dislikes}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground">
                <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  No agents found matching "{agentSearchQuery}"
                </p>
              </div>
            )}
            {filteredAgents.length > 0 && (
              <div className="text-xs text-muted-foreground text-center pt-2 border-t">
                Showing {filteredAgents.length} of {sharedAgents.length} agents
                {agentSearchQuery && ` (filtered from ${sharedAgents.length})`}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-muted-foreground">
              <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium mb-2">No Shared Agents</h3>
              <p className="text-sm">
                You haven't created any public agents yet. Create a public agent
                to see its usage analytics here.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

const UsersAnalyticsTable = ({
  users,
  title = "Users Analytics",
  description = "Complete user activity breakdown",
  searchPlaceholder = "Search users by name or email...",
  userSearchQuery,
  setUserSearchQuery,
  sortBy,
  setSortBy,
  agentId,
  agentName,
}: {
  users: AgentUserUsage[] | AgentUserLeaderboard[]
  title?: string
  description?: string
  searchPlaceholder?: string
  userSearchQuery: string
  setUserSearchQuery: (query: string) => void
  sortBy:
    | "messages"
    | "chats"
    | "likes"
    | "dislikes"
    | "lastUsed"
    | "cost"
    | "tokens"
  setSortBy: (
    sortBy:
      | "messages"
      | "chats"
      | "likes"
      | "dislikes"
      | "lastUsed"
      | "cost"
      | "tokens",
  ) => void
  agentId?: string
  agentName?: string
}) => {
  const [feedbackModalUser, setFeedbackModalUser] = useState<{
    userId: number
    userName: string
    userEmail: string
  } | null>(null)
  // Filter users based on search query
  const filteredUsers = users.filter(
    (user) =>
      user.userName.toLowerCase().includes(userSearchQuery.toLowerCase()) ||
      user.userEmail.toLowerCase().includes(userSearchQuery.toLowerCase()),
  )

  // Sort and filter users based on selected criteria
  const sortedAndFilteredUsers = [...filteredUsers].sort((a, b) => {
    switch (sortBy) {
      case "messages":
        return b.messageCount - a.messageCount
      case "chats":
        return b.chatCount - a.chatCount
      case "likes":
        return b.likes - a.likes
      case "dislikes":
        return b.dislikes - a.dislikes
      case "cost":
        return (
          safeNumberConversion(b.totalCost) - safeNumberConversion(a.totalCost)
        )
      case "tokens":
        return (
          safeNumberConversion(b.totalTokens) -
          safeNumberConversion(a.totalTokens)
        )
      case "lastUsed":
        return new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime()
      default:
        return b.messageCount - a.messageCount
    }
  })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <Badge variant="outline" className="text-sm">
            {users.length} total users
          </Badge>
        </div>

        {/* Search and Sort Controls */}
        <div className="mt-4 flex flex-col sm:flex-row gap-4">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <input
              type="text"
              placeholder={searchPlaceholder}
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </div>

          {/* Sort Dropdown */}
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) =>
                setSortBy(
                  e.target.value as
                    | "messages"
                    | "chats"
                    | "likes"
                    | "dislikes"
                    | "lastUsed"
                    | "cost"
                    | "tokens",
                )
              }
              className="appearance-none bg-background border border-input rounded-md px-3 py-2 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            >
              <option value="messages">Sort by Messages</option>
              <option value="chats">Sort by Chats</option>
              <option value="cost">Sort by Cost</option>
              <option value="tokens">Sort by Tokens</option>
              <option value="likes">Sort by Likes</option>
              <option value="dislikes">Sort by Dislikes</option>
              <option value="lastUsed">Sort by Last Used</option>
            </select>
            <div className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none">
              <svg
                className="h-4 w-4 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {users.length === 0 ? (
          <div className="text-center py-12">
            <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <p className="text-muted-foreground">
              No user activity data available
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Users List */}
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {sortedAndFilteredUsers.length > 0 ? (
                sortedAndFilteredUsers.map((user, index) => (
                  <div
                    key={user.userId}
                    className="flex items-center justify-between p-4 rounded-lg hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center space-x-4 flex-1">
                      <div className="flex items-center justify-center w-8 h-8 text-sm font-bold text-white bg-gradient-to-br from-blue-500 to-purple-600 rounded-full">
                        {index + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium truncate">
                          {user.userName}
                        </h4>
                        <p className="text-xs text-muted-foreground truncate">
                          {user.userEmail}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Last used:{" "}
                          {new Date(user.lastUsed).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 text-right">
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {user.messageCount}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          messages
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {user.chatCount}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          chats
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {formatCostInINR(user.totalCost)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          cost
                        </span>
                      </div>
                      <div className="flex flex-col items-center">
                        <span className="text-sm font-medium">
                          {(user.totalTokens || 0).toLocaleString()}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          tokens
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <div className="flex items-center gap-1 text-green-600">
                          <ThumbsUp className="h-3 w-3" />
                          <span>{user.likes}</span>
                        </div>
                        <div className="flex items-center gap-1 text-red-600">
                          <ThumbsDown className="h-3 w-3" />
                          <span>{user.dislikes}</span>
                        </div>
                      </div>
                      {agentId && (user.likes > 0 || user.dislikes > 0) && (
                        <button
                          onClick={() =>
                            setFeedbackModalUser({
                              userId: user.userId,
                              userName: user.userName,
                              userEmail: user.userEmail,
                            })
                          }
                          className="ml-3 px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-colors font-medium flex items-center gap-1"
                        >
                          <MessageSquare className="h-3 w-3" />
                          Feedbacks
                        </button>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No users found matching your search</p>
                </div>
              )}
            </div>

            {/* Results Summary */}
            {filteredUsers.length > 0 && (
              <div className="text-xs text-muted-foreground text-center pt-2 border-t">
                Showing {sortedAndFilteredUsers.length} of {users.length} users
                {userSearchQuery && ` (filtered from ${users.length})`}
                {sortBy !== "messages" && ` • Sorted by ${sortBy}`}
              </div>
            )}
          </div>
        )}
      </CardContent>

      {/* Feedback Messages Modal */}
      {feedbackModalUser && agentId && (
        <AgentUserFeedbackModal
          isOpen={true}
          onClose={() => setFeedbackModalUser(null)}
          agentId={agentId}
          agentName={agentName || "Unknown Agent"}
          userId={feedbackModalUser.userId}
          userName={feedbackModalUser.userName}
          userEmail={feedbackModalUser.userEmail}
        />
      )}
    </Card>
  )
}

const AgentDetailPage = ({
  agent,
  onBack,
  userSearchQuery,
  setUserSearchQuery,
}: {
  agent: SharedAgentUsageData
  onBack: () => void
  userSearchQuery: string
  setUserSearchQuery: (query: string) => void
}) => {
  const [sortBy, setSortBy] = useState<
    "messages" | "chats" | "likes" | "dislikes" | "lastUsed" | "cost" | "tokens"
  >("messages")
  const [showMoreMetrics, setShowMoreMetrics] = useState(false)

  // Calculate stats
  const avgMessagesPerUser =
    agent.userUsage.length > 0
      ? Math.round(agent.totalMessages / agent.userUsage.length)
      : 0

  const avgChatsPerUser =
    agent.userUsage.length > 0
      ? Math.round(agent.totalChats / agent.userUsage.length)
      : 0

  const avgCostPerUser =
    agent.userUsage.length > 0
      ? safeNumberConversion(agent.totalCost) / agent.userUsage.length
      : 0

  const avgTokensPerUser =
    agent.userUsage.length > 0
      ? Math.round(
          safeNumberConversion(agent.totalTokens) / agent.userUsage.length,
        )
      : 0

  const satisfactionRate =
    agent.likes + agent.dislikes > 0
      ? Math.round((agent.likes / (agent.likes + agent.dislikes)) * 100)
      : 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-10">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-all duration-200"
          title="Back to Agents"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-12 h-12 text-xl font-bold text-white bg-gradient-to-br from-purple-500 to-pink-600 rounded-xl">
            {agent.agentName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold">{agent.agentName}</h1>
            <p className="text-muted-foreground">
              {agent.agentDescription || "No description available"}
            </p>
          </div>
        </div>
      </div>

      {/* Overview Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <MetricCard
          title="Total Users"
          value={agent.userUsage.length.toString()}
          description="Unique users who used this agent"
          icon={Users}
          className="border-blue-200 dark:border-blue-800"
        />
        <MetricCard
          title="Total Chats"
          value={agent.totalChats.toLocaleString()}
          description={`Avg ${avgChatsPerUser} per user`}
          icon={MessageSquare}
        />
        <MetricCard
          title="Total Messages"
          value={agent.totalMessages.toLocaleString()}
          description={`Avg ${avgMessagesPerUser} per user`}
          icon={Activity}
        />
        <MetricCard
          title="Satisfaction"
          value={`${satisfactionRate}%`}
          description={`${agent.likes} likes, ${agent.dislikes} dislikes`}
          icon={ThumbsUp}
          className={
            satisfactionRate >= 70
              ? "border-green-200 dark:border-green-800"
              : "border-red-200 dark:border-red-800"
          }
        />
        <MetricCard
          title="Avg Messages/User"
          value={avgMessagesPerUser.toString()}
          description="Average per user"
          icon={Activity}
          className="border-cyan-200 dark:border-cyan-800"
        />
        <MetricCard
          title="Avg Chats/User"
          value={avgChatsPerUser.toString()}
          description="Average per user"
          icon={MessageSquare}
          className="border-indigo-200 dark:border-indigo-800"
        />
      </div>

      {/* Show More Button */}
      <ShowMoreMetricsToggle
        showMoreMetrics={showMoreMetrics}
        onToggle={() => setShowMoreMetrics(!showMoreMetrics)}
        variant="muted"
      />

      {/* Additional Metrics - Expandable */}
      <ExpandableMetricsSection
        showMoreMetrics={showMoreMetrics}
        variant="slide"
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Total Cost"
            value={formatCostInINR(agent.totalCost)}
            description={`Avg ${formatCostInINR(avgCostPerUser)} per user`}
            icon={Activity}
            className="border-purple-200 dark:border-purple-800"
          />
          <MetricCard
            title="Total Tokens"
            value={(agent.totalTokens || 0).toLocaleString()}
            description={`Avg ${avgTokensPerUser.toLocaleString()} per user`}
            icon={Activity}
            className="border-orange-200 dark:border-orange-800"
          />
          <MetricCard
            title="Cost per Message"
            value={formatCostPerMessageInINR(
              agent.totalCost,
              agent.totalMessages,
            )}
            description="Average cost per message"
            icon={Activity}
            className="border-yellow-200 dark:border-yellow-800"
          />
          <MetricCard
            title="Tokens per Message"
            value={
              agent.totalMessages > 0
                ? Math.round(
                    safeNumberConversion(agent.totalTokens) /
                      agent.totalMessages,
                  ).toLocaleString()
                : "0"
            }
            description="Average tokens per message"
            icon={Activity}
            className="border-green-200 dark:border-green-800"
          />
        </div>
      </ExpandableMetricsSection>

      {/* Unified Users Table with Sort */}
      <UsersAnalyticsTable
        users={agent.userUsage}
        title="Users Analytics"
        description="Complete user activity breakdown for this agent"
        searchPlaceholder="Search users by name or email..."
        userSearchQuery={userSearchQuery}
        setUserSearchQuery={setUserSearchQuery}
        sortBy={sortBy}
        setSortBy={setSortBy}
        agentId={agent.agentId}
        agentName={agent.agentName}
      />
    </div>
  )
}

const AdminUsersLeaderboard = ({
  users,
  loading = false,
  onUserClick,
  onAllChatsClick,
  onUserChatsClick,
}: {
  users: AdminUserUsage[]
  loading?: boolean
  onUserClick?: (user: AdminUserUsage) => void
  onAllChatsClick?: () => void
  onUserChatsClick?: (userId: number, userName: string) => void
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("")
  const [feedbackModal, setFeedbackModal] = useState<{
    isOpen: boolean
    userId: number
    userName: string
    userEmail: string
  }>({
    isOpen: false,
    userId: 0,
    userName: "",
    userEmail: "",
  })

  const handleFeedbackClick = (e: React.MouseEvent, user: AdminUserUsage) => {
    e.stopPropagation()
    setFeedbackModal({
      isOpen: true,
      userId: user.userId,
      userName: user.userName,
      userEmail: user.userEmail,
    })
  }

  const handleViewChatsClick = (e: React.MouseEvent, user: AdminUserUsage) => {
    e.stopPropagation()
    onUserChatsClick?.(user.userId, user.userName)
  }

  const closeFeedbackModal = () => {
    setFeedbackModal({
      isOpen: false,
      userId: 0,
      userName: "",
      userEmail: "",
    })
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Users Leaderboard
          </CardTitle>
          <CardDescription>
            Most active users across the platform
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="text-muted-foreground">Loading users data...</div>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Filter users based on search query
  const filteredUsers = users.filter(
    (user) =>
      user.userName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.userEmail.toLowerCase().includes(searchQuery.toLowerCase()),
  )

  const sortedUsers = filteredUsers.sort(
    (a, b) => b.messageCount - a.messageCount,
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Users Leaderboard
            </CardTitle>
            <CardDescription>All active users by message count</CardDescription>
          </div>
          {onAllChatsClick && (
            <button
              onClick={onAllChatsClick}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors flex items-center gap-2"
            >
              <MessageSquare className="h-4 w-4" />
              All Chats
            </button>
          )}
        </div>
        <div className="mt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <input
              type="text"
              placeholder="Search users by name or email..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {sortedUsers.length > 0 ? (
          <div className="max-h-80 overflow-y-auto space-y-4">
            {sortedUsers.map((user, index) => {
              // Calculate original rank in the full list
              const originalRank =
                users
                  .sort((a, b) => b.messageCount - a.messageCount)
                  .findIndex((u) => u.userId === user.userId) + 1

              return (
                <div
                  key={user.userId}
                  className="flex items-center justify-between p-4 rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
                  onClick={() => onUserClick?.(user)}
                >
                  <div className="flex items-center space-x-4 flex-1">
                    <div className="flex items-center justify-center w-8 h-8 text-sm font-bold text-white bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full">
                      {originalRank}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h4
                          className="text-sm font-medium truncate"
                          title={user.userName}
                        >
                          {user.userName || "Unknown User"}
                        </h4>
                        <Badge
                          variant={
                            user.role === "SuperAdmin"
                              ? "destructive"
                              : user.role === "Admin"
                                ? "default"
                                : "secondary"
                          }
                          className="text-xs"
                        >
                          {user.role}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {user.userEmail}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4 text-right">
                    <div className="flex flex-col items-center">
                      <span className="text-sm font-medium">
                        {user.messageCount}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        messages
                      </span>
                    </div>
                    <div className="flex flex-col items-center">
                      <span className="text-sm font-medium">
                        {user.chatCount}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        chats
                      </span>
                    </div>
                    <div className="flex flex-col items-center">
                      <span className="text-sm font-medium">
                        {formatCostInINR(user.totalCost)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        cost
                      </span>
                    </div>
                    <div className="flex flex-col items-center">
                      <span className="text-sm font-medium">
                        {(user.totalTokens || 0).toLocaleString()}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        tokens
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <div className="flex items-center gap-1 text-green-600">
                        <ThumbsUp className="h-3 w-3" />
                        <span>{user.likes}</span>
                      </div>
                      <div className="flex items-center gap-1 text-red-600">
                        <ThumbsDown className="h-3 w-3" />
                        <span>{user.dislikes}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {onUserChatsClick && (
                        <button
                          onClick={(e) => handleViewChatsClick(e, user)}
                          className="px-3 py-1.5 text-xs text-green-600 border border-green-200 rounded-lg hover:bg-green-50 hover:border-green-300 transition-colors font-medium flex items-center gap-1"
                        >
                          <MessageSquare className="h-3 w-3" />
                          View Chats
                        </button>
                      )}
                      {(user.likes > 0 || user.dislikes > 0) && (
                        <button
                          onClick={(e) => handleFeedbackClick(e, user)}
                          className="px-3 py-1.5 text-xs text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 hover:border-blue-300 transition-colors font-medium flex items-center gap-1"
                        >
                          <MessageSquare className="h-3 w-3" />
                          Feedbacks
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <Users className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              {searchQuery
                ? "No users found matching your search"
                : "No user data available"}
            </p>
          </div>
        )}
        {filteredUsers.length > 0 && (
          <div className="text-xs text-muted-foreground text-center pt-2 border-t">
            Showing {sortedUsers.length} of {users.length} users
            {searchQuery && ` (filtered from ${users.length})`}
          </div>
        )}
      </CardContent>
      <UserFeedbackModal
        isOpen={feedbackModal.isOpen}
        onClose={closeFeedbackModal}
        userId={feedbackModal.userId}
        userName={feedbackModal.userName}
        userEmail={feedbackModal.userEmail}
        showSearch={true}
        showAgentFilter={true}
      />
    </Card>
  )
}

const UserAgentLeaderboardCard = ({
  agentLeaderboard,
}: {
  agentLeaderboard: UserAgentLeaderboard[]
}) => {
  const [searchQuery, setSearchQuery] = useState<string>("")

  if (agentLeaderboard.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Trophy className="h-5 w-5" />
            Agent Usage Leaderboard
          </CardTitle>
          <CardDescription>
            See how much this user has used each agent and their feedback
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8 text-muted-foreground">
            <Trophy className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No agent usage data available</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Filter agents based on search query
  const filteredAgents = agentLeaderboard.filter(
    (agent) =>
      agent.agentName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (agent.agentDescription &&
        agent.agentDescription
          .toLowerCase()
          .includes(searchQuery.toLowerCase())),
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-5 w-5" />
          Agent Usage Leaderboard
        </CardTitle>
        <CardDescription>
          Ranked by total messages sent to each agent with cost and token usage
        </CardDescription>
        {/* Search */}
        <div className="mt-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
            <input
              type="text"
              placeholder="Search agents by name or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {filteredAgents.length > 0 ? (
          <div className="max-h-80 overflow-y-auto space-y-4">
            {filteredAgents.map((agent) => (
              <div
                key={agent.agentId}
                className="flex items-center justify-between p-4 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center space-x-4 flex-1">
                  <div className="flex items-center justify-center w-8 h-8 text-sm font-bold text-white bg-gradient-to-br from-green-500 to-blue-600 rounded-full">
                    {agent.rank}
                  </div>
                  <div className="flex-1 min-w-0">
                    <h4
                      className="text-sm font-medium truncate"
                      title={agent.agentName}
                    >
                      {agent.agentName}
                    </h4>
                    {agent.agentDescription && (
                      <p
                        className="text-xs text-muted-foreground line-clamp-1"
                        title={agent.agentDescription}
                      >
                        {agent.agentDescription}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Last used: {new Date(agent.lastUsed).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-right">
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {agent.messageCount}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      messages
                    </span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {agent.chatCount}
                    </span>
                    <span className="text-xs text-muted-foreground">chats</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {formatCostInINR(agent.totalCost)}
                    </span>
                    <span className="text-xs text-muted-foreground">cost</span>
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-sm font-medium">
                      {(agent.totalTokens || 0).toLocaleString()}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      tokens
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <div className="flex items-center gap-1 text-green-600">
                      <ThumbsUp className="h-3 w-3" />
                      <span>{agent.likes}</span>
                    </div>
                    <div className="flex items-center gap-1 text-red-600">
                      <ThumbsDown className="h-3 w-3" />
                      <span>{agent.dislikes}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <Search className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">
              {searchQuery
                ? "No agents found matching your search"
                : "No agent usage data available"}
            </p>
          </div>
        )}
        {filteredAgents.length > 0 && (
          <div className="text-xs text-muted-foreground text-center pt-2 border-t">
            Showing {filteredAgents.length} of {agentLeaderboard.length} agents
            {searchQuery && ` (filtered from ${agentLeaderboard.length})`}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const AgentAnalysisPage = ({
  agent,
  onBack,
  timeRange,
  currentUser,
}: {
  agent: AgentUsageData
  onBack: () => void
  timeRange: "today" | "1w" | "1m" | "3m" | "all"
  currentUser?: any
}) => {
  const [agentAnalysis, setAgentAnalysis] = useState<AgentAnalysisData | null>(
    null,
  )
  const [loading, setLoading] = useState(true)
  const [userSearchQuery, setUserSearchQuery] = useState<string>("")
  const [sortBy, setSortBy] = useState<
    "messages" | "chats" | "likes" | "dislikes" | "lastUsed" | "cost" | "tokens"
  >("messages")

  useEffect(() => {
    const fetchAgentAnalysis = async () => {
      try {
        setLoading(true)

        // Calculate time range
        const now = new Date()
        const fromDate = getDateRangeFromTimeRange(timeRange)

        const query: any = {
          // Don't pass workspaceExternalId for admin view to show all data across workspaces
          ...(fromDate && {
            from: fromDate.toISOString(),
            to: now.toISOString(),
          }),
        }

        const response = await api.admin.agents[agent.agentId].analysis.$get({
          query,
        })

        if (!response.ok) {
          throw new Error("Failed to fetch agent analysis")
        }

        const data = await response.json()
        if (data.success && data.data) {
          setAgentAnalysis(data.data)
        } else {
          console.warn("No agent analysis data received:", data)
          setAgentAnalysis(null)
        }
      } catch (error) {
        console.error("Error fetching agent analysis:", error)
        setAgentAnalysis(null)
      } finally {
        setLoading(false)
      }
    }

    fetchAgentAnalysis()
  }, [agent.agentId, timeRange, currentUser])

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-10">
          <button
            onClick={onBack}
            className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-all duration-200"
            title="Back to Overview"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="text-muted-foreground">Loading agent analysis...</div>
        </div>
      </div>
    )
  }

  if (!agentAnalysis) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-10">
          <button
            onClick={onBack}
            className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-all duration-200"
            title="Back to Overview"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="text-center text-muted-foreground">
              <Bot className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>Agent analysis data not available</p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Calculate stats
  const avgMessagesPerUser =
    agentAnalysis.totalUsers > 0
      ? Math.round(agentAnalysis.totalMessages / agentAnalysis.totalUsers)
      : 0

  const avgChatsPerUser =
    agentAnalysis.totalUsers > 0
      ? Math.round(agentAnalysis.totalChats / agentAnalysis.totalUsers)
      : 0

  const satisfactionRate =
    agentAnalysis.likes + agentAnalysis.dislikes > 0
      ? Math.round(
          (agentAnalysis.likes /
            (agentAnalysis.likes + agentAnalysis.dislikes)) *
            100,
        )
      : 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-10">
        <button
          onClick={onBack}
          className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-all duration-200"
          title="Back to Overview"
        >
          <svg
            className="w-5 h-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        <div className="flex items-center gap-4">
          <div className="flex items-center justify-center w-12 h-12 text-xl font-bold text-white bg-gradient-to-br from-purple-500 to-pink-600 rounded-xl">
            {agentAnalysis.agentName.charAt(0).toUpperCase()}
          </div>
          <div>
            <h1 className="text-2xl font-bold">{agentAnalysis.agentName}</h1>
            <p className="text-muted-foreground">
              {agentAnalysis.agentDescription || "No description available"}
            </p>
            <div className="text-xs text-muted-foreground">
              Created:{" "}
              {new Date(agentAnalysis.createdAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Overview Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <MetricCard
          title="Total Users"
          value={agentAnalysis.totalUsers.toString()}
          description="Unique users who used this agent"
          icon={Users}
          className="border-blue-200 dark:border-blue-800"
        />
        <MetricCard
          title="Total Chats"
          value={agentAnalysis.totalChats.toLocaleString()}
          description={`Avg ${avgChatsPerUser} per user`}
          icon={MessageSquare}
        />
        <MetricCard
          title="Total Messages"
          value={agentAnalysis.totalMessages.toLocaleString()}
          description={`Avg ${avgMessagesPerUser} per user`}
          icon={Activity}
        />
        <MetricCard
          title="Satisfaction"
          value={`${satisfactionRate}%`}
          description={`${agentAnalysis.likes} likes, ${agentAnalysis.dislikes} dislikes`}
          icon={ThumbsUp}
          className={
            satisfactionRate >= 70
              ? "border-green-200 dark:border-green-800"
              : "border-red-200 dark:border-red-800"
          }
        />
        <MetricCard
          title="Avg Messages/User"
          value={avgMessagesPerUser.toString()}
          description="Average per user"
          icon={Activity}
          className="border-cyan-200 dark:border-cyan-800"
        />
        <MetricCard
          title="Avg Chats/User"
          value={avgChatsPerUser.toString()}
          description="Average per user"
          icon={MessageSquare}
          className="border-indigo-200 dark:border-indigo-800"
        />
      </div>

      {/* Unified Users Table with Sort */}
      <UsersAnalyticsTable
        users={agentAnalysis.userLeaderboard}
        title="Users Analytics"
        description="Complete user activity breakdown for this agent"
        searchPlaceholder="Search users by name or email..."
        userSearchQuery={userSearchQuery}
        setUserSearchQuery={setUserSearchQuery}
        sortBy={sortBy}
        setSortBy={setSortBy}
        agentId={agent.agentId}
        agentName={agent.agentName}
      />
    </div>
  )
}

const UserDetailPage = ({
  user,
  onBack,
  timeRange,
  navigate,
  setSelectedUserInStore,
}: {
  user: AdminUserUsage
  onBack: () => void
  timeRange: "today" | "1w" | "1m" | "3m" | "all"
  navigate: ReturnType<typeof useNavigate>
  setSelectedUserInStore: (user: {
    userId: number
    userName: string
    userEmail: string
  }) => void
}) => {
  const [userChats, setUserChats] = useState<any[]>([])
  const [agentLeaderboard, setAgentLeaderboard] = useState<
    UserAgentLeaderboard[]
  >([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<"normal" | "agent">("agent")
  const [showMoreMetrics, setShowMoreMetrics] = useState(false)

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        setLoading(true)

        // Calculate time range
        const now = new Date()
        const fromDate = getDateRangeFromTimeRange(timeRange)

        const query: any = { userId: user.userId }
        if (fromDate) {
          query.from = fromDate.toISOString()
          query.to = now.toISOString()
        }

        // Fetch user chats and agent leaderboard in parallel
        const [chatsResponse, leaderboardResponse] = await Promise.all([
          api.admin.chats.$get({ query }),
          api.admin.users[user.userId]["agent-leaderboard"].$get({
            query: {
              ...(fromDate && { from: fromDate.toISOString() }),
              ...(fromDate && { to: now.toISOString() }),
            },
          }),
        ])

        if (!chatsResponse.ok) {
          throw new Error("Failed to fetch user chats")
        }

        const chats = await chatsResponse.json()

        if (!leaderboardResponse.ok) {
          console.error(
            "Leaderboard API Error:",
            leaderboardResponse.status,
            leaderboardResponse.statusText,
          )
          const errorText = await leaderboardResponse.text()
          console.error("Leaderboard Error Response:", errorText)
          throw new Error(
            `Failed to fetch agent leaderboard: ${leaderboardResponse.status}`,
          )
        }

        const leaderboardData = await leaderboardResponse.json()

        setUserChats(
          chats.data.filter(
            (chat: any) =>
              chat.userId === user.userId || chat.user?.id === user.userId,
          ),
        )
        if (leaderboardData.success && leaderboardData.data) {
          setAgentLeaderboard(leaderboardData.data)
        } else {
          console.warn(
            "No leaderboard data received or success=false:",
            leaderboardData,
          )
          setAgentLeaderboard([])
        }
      } catch (error) {
        console.error("Error fetching user data:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchUserData()
  }, [user.userId, timeRange])

  const processUserChatsData = (chats: any[]) => {
    const timeSeriesMap = new Map<string, TimeSeriesData>()
    let normalChats = 0
    let agentChats = 0
    let totalMessages = 0
    let totalCostCalculated = 0
    let totalTokensCalculated = 0

    const getTimeBucket = (date: Date, timeRange: string) => {
      const d = new Date(date)

      switch (timeRange) {
        case "today":
          d.setMinutes(0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleTimeString("en-US", {
              hour: "numeric",
              hour12: true,
            }),
          }
        case "1w":
        case "1m":
        case "3m":
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
          }
        case "all":
          d.setDate(1)
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
            }),
          }
        default:
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString(),
          }
      }
    }

    chats.forEach((chat) => {
      const messageCount = chat.messageCount || chat.messages?.length || 0
      totalMessages += messageCount
      totalCostCalculated += chat.totalCost || 0
      totalTokensCalculated += chat.totalTokens || 0

      if (chat.agentId) {
        agentChats++
      } else {
        normalChats++
      }

      const date = new Date(chat.createdAt)
      const timeBucket = getTimeBucket(date, timeRange)

      if (!timeSeriesMap.has(timeBucket.key)) {
        timeSeriesMap.set(timeBucket.key, {
          time: timeBucket.display,
          totalChats: 0,
          normalChats: 0,
          agentChats: 0,
          totalMessages: 0,
          normalMessages: 0,
          agentMessages: 0,
          totalCost: 0,
          totalTokens: 0,
        })
      }

      const timeData = timeSeriesMap.get(timeBucket.key)!
      timeData.totalChats++
      timeData.totalMessages += messageCount

      if (chat.agentId) {
        timeData.agentChats++
        timeData.agentMessages += messageCount
      } else {
        timeData.normalChats++
        timeData.normalMessages += messageCount
      }
    })

    const recentActivity = Array.from(timeSeriesMap.values()).sort((a, b) => {
      const aKey =
        Array.from(timeSeriesMap.entries()).find(
          ([_, value]) => value === a,
        )?.[0] || ""
      const bKey =
        Array.from(timeSeriesMap.entries()).find(
          ([_, value]) => value === b,
        )?.[0] || ""
      return new Date(aKey).getTime() - new Date(bKey).getTime()
    })

    return {
      totalChats: chats.length,
      totalMessages,
      totalCost: totalCostCalculated,
      totalTokens: totalTokensCalculated,
      normalChats,
      agentChats,
      recentActivity,
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-10">
          <button
            onClick={onBack}
            className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-all duration-200"
            title="Back to Users"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="text-muted-foreground">Loading user data...</div>
        </div>
      </div>
    )
  }

  const userStats = processUserChatsData(userChats)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-10">
        <div className="flex items-center gap-4">
          <button
            onClick={onBack}
            className="flex items-center justify-center w-10 h-10 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-all duration-200"
            title="Back to Users"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>

          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-12 h-12 text-xl font-bold text-white bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl">
              {user.userName.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 className="text-2xl font-bold">{user.userName}</h1>
              <p className="text-muted-foreground">{user.userEmail}</p>
              <Badge
                variant={
                  user.role === "SuperAdmin"
                    ? "destructive"
                    : user.role === "Admin"
                      ? "default"
                      : "secondary"
                }
                className="mt-1"
              >
                {user.role}
              </Badge>
            </div>
          </div>
        </div>

        {/* View Chats Button */}
        <button
          onClick={() => {
            setSelectedUserInStore({
              userId: user.userId,
              userName: user.userName,
              userEmail: user.userEmail,
            })
            navigate({
              to: "/admin/chat-overview" as const,
            })
          }}
          className="px-4 py-2 text-sm font-medium text-green-600 border border-green-200 rounded-lg hover:bg-green-50 hover:border-green-300 transition-colors flex items-center gap-2"
        >
          <MessageSquare className="h-4 w-4" />
          View Chats
        </button>
      </div>

      {/* User Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
        <MetricCard
          title="Total Chats"
          value={userStats.totalChats.toString()}
          description="All conversations"
          icon={MessageSquare}
        />
        <MetricCard
          title="Total Messages"
          value={userStats.totalMessages.toString()}
          description="All messages sent"
          icon={Activity}
        />
        <MetricCard
          title="Normal Chats"
          value={userStats.normalChats.toString()}
          description="Chats without agents"
          icon={Users}
        />
        <MetricCard
          title="Agent Chats"
          value={userStats.agentChats.toString()}
          description="Chats with agents"
          icon={Bot}
          className="border-blue-200 dark:border-blue-800"
        />
        <MetricCard
          title="Join Date"
          value={new Date(user.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          })}
          description="Member since"
          icon={Users}
          className="border-gray-200 dark:border-gray-800"
        />
        <MetricCard
          title="Last Active"
          value={new Date(user.lastActive).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
          description="Recent activity"
          icon={Activity}
          className="border-orange-200 dark:border-orange-800"
        />
      </div>

      {/* Show More Button */}
      <ShowMoreMetricsToggle
        showMoreMetrics={showMoreMetrics}
        onToggle={() => setShowMoreMetrics(!showMoreMetrics)}
        variant="muted"
      />

      {/* Additional Metrics - Expandable */}
      <ExpandableMetricsSection
        showMoreMetrics={showMoreMetrics}
        variant="slide"
      >
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            title="Total Cost"
            value={formatCostInINR(userStats.totalCost)}
            description="LLM usage cost"
            icon={Activity}
            className="border-purple-200 dark:border-purple-800"
          />
          <MetricCard
            title="Total Tokens"
            value={(userStats.totalTokens || 0).toLocaleString()}
            description="Tokens processed"
            icon={Activity}
            className="border-orange-200 dark:border-orange-800"
          />
          <MetricCard
            title="Cost per Message"
            value={formatCostPerMessageInINR(
              userStats.totalCost,
              userStats.totalMessages,
            )}
            description="Average cost per message"
            icon={Activity}
            className="border-yellow-200 dark:border-yellow-800"
          />
          <MetricCard
            title="Tokens per Message"
            value={
              userStats.totalMessages > 0
                ? Math.round(
                    safeNumberConversion(userStats.totalTokens) /
                      userStats.totalMessages,
                  ).toLocaleString()
                : "0"
            }
            description="Average tokens per message"
            icon={Activity}
            className="border-green-200 dark:border-green-800"
          />
        </div>
      </ExpandableMetricsSection>

      {/* Tabs for Charts */}
      <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
        <button
          onClick={() => setActiveTab("agent")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === "agent"
              ? "bg-white dark:bg-gray-800 shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Agent Message Analysis
          </div>
        </button>
        <button
          onClick={() => setActiveTab("normal")}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === "normal"
              ? "bg-white dark:bg-gray-800 shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Normal Message Analysis
          </div>
        </button>
      </div>

      {/* Charts Section based on active tab */}
      {activeTab === "agent" ? (
        <div className="space-y-6">
          <MessageActivityChart
            data={userStats.recentActivity}
            timeRange={timeRange}
            type="agent"
          />
          <UserAgentLeaderboardCard agentLeaderboard={agentLeaderboard} />
        </div>
      ) : (
        <div className="space-y-6">
          <MessageActivityChart
            data={userStats.recentActivity}
            timeRange={timeRange}
            type="normal"
          />
          <UserAgentLeaderboardCard agentLeaderboard={agentLeaderboard} />
        </div>
      )}
    </div>
  )
}

export const Dashboard = ({
  user,
  photoLink = "",
  role = "",
  isAgentMode = false,
}: {
  user?: any
  photoLink?: string
  role?: string
  isAgentMode?: boolean
} = {}) => {
  const navigate = useNavigate()
  const {
    setSelectedUser: setSelectedUserInStore,
    setDashboardTab,
    dashboardTab,
    activeTab,
    setActiveTab,
  } = useAdminUserSelectionStore()
  const [stats, setStats] = useState<DashboardStats>({
    totalChats: 0,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: 0,
    activeAgents: 0,
    normalChats: 0,
    agentChats: 0,
    recentActivity: [],
    agentUsage: [],
    feedbackStats: {
      totalLikes: 0,
      totalDislikes: 0,
      feedbackByChat: {},
      feedbackMessages: [],
    },
  })

  const [sharedAgentStats, setSharedAgentStats] =
    useState<SharedAgentUsageStats>({
      sharedAgents: [],
      totalUsage: {
        totalChats: 0,
        totalMessages: 0,
        totalCost: 0,
        totalTokens: 0,
        totalLikes: 0,
        totalDislikes: 0,
        uniqueUsers: 0,
      },
    })

  const [loading, setLoading] = useState(true)
  const [sharedAgentLoading, setSharedAgentLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sharedAgentError, setSharedAgentError] = useState<string | null>(null)
  const [mainTab, setMainTab] = useState<
    "my-activity" | "shared-agents" | "admin-overview"
  >(dashboardTab || "my-activity")
  const [timeRange, setTimeRange] = useState<
    "today" | "1w" | "1m" | "3m" | "all"
  >("1m")

  // Admin-specific state
  const [adminStats, setAdminStats] = useState<AdminDashboardStats>({
    totalUsers: 0,
    totalChats: 0,
    totalMessages: 0,
    totalCost: 0,
    totalTokens: 0,
    totalAgents: 0,
    totalSharedAgents: 0,
    recentActivity: [],
    topUsers: [],
    agentUsage: [],
    feedbackStats: {
      totalLikes: 0,
      totalDislikes: 0,
      feedbackByChat: {},
      feedbackMessages: [],
    },
  })
  const [_, setAdminChats] = useState<AdminChat[]>([])
  const [adminLoading, setAdminLoading] = useState(false)
  const [adminError, setAdminError] = useState<string | null>(null)
  const [selectedUser, setSelectedUser] = useState<AdminUserUsage | null>(null)
  const [showMoreAdminMetrics, setShowMoreAdminMetrics] = useState(false)

  // Agent analysis state
  const [selectedAgent, setSelectedAgent] = useState<AgentUsageData | null>(
    null,
  )

  // Admin transition state
  const [isAdminTransitioning, setIsAdminTransitioning] = useState(false)

  // Handle admin user selection with smooth transition
  const handleAdminUserSelect = async (user: AdminUserUsage | null) => {
    if (selectedUser === user) {
      // Deselecting current user
      setIsAdminTransitioning(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      setSelectedUser(null)
      setIsAdminTransitioning(false)
    } else {
      // Selecting new user
      setIsAdminTransitioning(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      setSelectedUser(user)
      setIsAdminTransitioning(false)
    }
  }

  // Handle admin agent selection with smooth transition
  const handleAdminAgentSelect = async (agent: AgentUsageData | null) => {
    if (selectedAgent === agent) {
      // Deselecting current agent
      setIsAdminTransitioning(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      setSelectedAgent(null)
      setIsAdminTransitioning(false)
    } else {
      // Selecting new agent
      setIsAdminTransitioning(true)
      await new Promise((resolve) => setTimeout(resolve, 150))
      setSelectedAgent(agent)
      setIsAdminTransitioning(false)
    }
  }

  // Check if user is admin or superadmin
  const isAdmin = user?.role === "Admin" || user?.role === "SuperAdmin"

  // Manage shared agent selection at parent level to prevent loss of state
  const [selectedSharedAgent, setSelectedSharedAgent] = useState<string | null>(
    null,
  )

  // Clear selected agent when switching away from shared agents tab
  useEffect(() => {
    if (mainTab !== "shared-agents") {
      setSelectedSharedAgent(null)
    }
  }, [mainTab])

  useEffect(() => {
    const fetchDashboardData = async () => {
      try {
        setLoading(true)

        // Calculate time range
        const now = new Date()
        const fromDate = getDateRangeFromTimeRange(timeRange, true)

        // Use the new dashboard data endpoint
        const query: any = {}
        if (fromDate) {
          query.from = fromDate.toISOString()
          query.to = now.toISOString()
        }

        const dashboardResponse = await api.chat["dashboard-data"].$get({
          query,
        })
        if (!dashboardResponse.ok) {
          throw new Error("Failed to fetch dashboard data")
        }

        const dashboardData = await dashboardResponse.json()
        const { chats, agents, messageCounts, feedbackStats } = dashboardData

        // Process the data
        const processedStats = processChatsData(
          chats,
          agents,
          timeRange,
          messageCounts,
          feedbackStats,
        )
        setStats(processedStats)
        setError(null)
      } catch (err) {
        console.error("Error fetching dashboard data:", err)
        setError(
          err instanceof Error ? err.message : "Failed to fetch dashboard data",
        )
      } finally {
        setLoading(false)
      }
    }

    fetchDashboardData()
  }, [timeRange])

  // Fetch shared agent data
  useEffect(() => {
    const fetchSharedAgentData = async () => {
      try {
        setSharedAgentLoading(true)

        // Calculate time range
        const now = new Date()
        const fromDate = getDateRangeFromTimeRange(timeRange, true)

        const query: any = {}
        if (fromDate) {
          query.from = fromDate.toISOString()
          query.to = now.toISOString()
        }

        const sharedAgentResponse = await api.chat["shared-agent-usage"].$get({
          query,
        })
        if (!sharedAgentResponse.ok) {
          throw new Error("Failed to fetch shared agent data")
        }

        const sharedAgentData = await sharedAgentResponse.json()
        setSharedAgentStats(sharedAgentData)
        setSharedAgentError(null)
      } catch (err) {
        console.error("Error fetching shared agent data:", err)
        setSharedAgentError(
          err instanceof Error
            ? err.message
            : "Failed to fetch shared agent data",
        )
      } finally {
        setSharedAgentLoading(false)
      }
    }

    // Only fetch if we're on the shared-agents tab
    if (mainTab === "shared-agents") {
      fetchSharedAgentData()
    }
  }, [timeRange, mainTab])

  // Fetch admin data
  useEffect(() => {
    const fetchAdminData = async () => {
      // Only fetch admin data for admin/superadmin users
      if (user?.role !== "Admin" && user?.role !== "SuperAdmin") {
        return
      }

      try {
        setAdminLoading(true)

        // Calculate time range
        const now = new Date()
        const fromDate = getDateRangeFromTimeRange(timeRange)

        // Fetch system-wide data (without user/workspace constraints)
        const query: any = {}
        if (fromDate) {
          query.from = fromDate.toISOString()
          query.to = now.toISOString()
        }

        const [adminChatsResponse, adminAgentsResponse] = await Promise.all([
          api.admin.chats.$get({ query }),
          api.admin.agents.$get(),
        ])

        if (!adminChatsResponse.ok || !adminAgentsResponse.ok) {
          throw new Error("Failed to fetch admin data")
        }

        const adminChatsData = await adminChatsResponse.json()
        const adminAgents = await adminAgentsResponse.json()

        // Handle both new pagination format and old format for backward compatibility
        let chatsArray: any[]
        if (
          adminChatsData &&
          typeof adminChatsData === "object" &&
          "data" in adminChatsData &&
          "pagination" in adminChatsData
        ) {
          // New format with pagination metadata
          chatsArray = adminChatsData.data
        } else if (Array.isArray(adminChatsData)) {
          // Old format - direct array
          chatsArray = adminChatsData
        } else {
          throw new Error("Invalid response format from admin chats API")
        }

        // Process admin stats
        const processedAdminStats = processAdminChatsData(
          chatsArray,
          adminAgents,
          timeRange,
        )
        setAdminStats(processedAdminStats)

        // Set the raw admin chats data for the table
        setAdminChats(
          chatsArray.map((chat: any) => ({
            externalId: chat.externalId,
            title: chat.title || "Untitled Chat",
            createdAt: chat.createdAt,
            userId: chat.userId || chat.user?.id,
            userName: chat.userName || chat.user?.name || "Unknown User",
            userEmail: chat.userEmail || chat.user?.email || "",
            agentId: chat.agentId,
            agentName:
              chat.agentName ||
              (chat.agentId
                ? adminAgents.find((a: any) => a.externalId === chat.agentId)
                    ?.name
                : null),
            messageCount: chat.messageCount || chat.messages?.length || 0,
            totalCost: chat.totalCost || 0,
            totalTokens: chat.totalTokens || 0,
            likes: chat.likes || 0,
            dislikes: chat.dislikes || 0,
            isBookmarked: chat.isBookmarked || false,
          })),
        )

        setAdminError(null)
      } catch (err) {
        console.error("Error fetching admin data:", err)
        setAdminError(
          err instanceof Error ? err.message : "Failed to fetch admin data",
        )
      } finally {
        setAdminLoading(false)
      }
    }

    // Only fetch if we're on admin overview tab and user is admin
    if (
      mainTab === "admin-overview" &&
      (user?.role === "Admin" || user?.role === "SuperAdmin")
    ) {
      fetchAdminData()
    }
  }, [timeRange, mainTab, user?.role])

  const processChatsData = (
    chats: Chat[],
    agents: Agent[],
    timeRange: "today" | "1w" | "1m" | "3m" | "all",
    messageCounts: Record<
      string,
      { messageCount: number; totalCost: number; totalTokens: number }
    > = {},
    feedbackStats: FeedbackStats = {
      totalLikes: 0,
      totalDislikes: 0,
      feedbackByChat: {},
      feedbackMessages: [],
    },
  ): DashboardStats => {
    const agentMap = new Map(agents.map((a) => [a.externalId, a]))
    const timeSeriesMap = new Map<string, TimeSeriesData>()
    const agentUsageMap = new Map<string, AgentUsageData>()

    let normalChats = 0
    let agentChats = 0
    let totalMessages = 0
    let totalCostCalculated = 0
    let totalTokensCalculated = 0

    // Calculate total message count, cost, and tokens
    Object.values(messageCounts).forEach((chatData) => {
      totalMessages += chatData.messageCount
      totalCostCalculated += chatData.totalCost
      totalTokensCalculated += chatData.totalTokens
    })

    // Determine the appropriate time bucket size and format based on time range
    const getTimeBucket = (date: Date, timeRange: string) => {
      const d = new Date(date)

      switch (timeRange) {
        case "today":
          // Hourly buckets for today
          d.setMinutes(0, 0, 0) // Round to the nearest hour
          return {
            key: d.toISOString(),
            display: d.toLocaleTimeString("en-US", {
              hour: "numeric",
              hour12: true,
            }),
          }
        case "1w":
          // Daily buckets for last week (easier to read than hourly)
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            }),
          }
        case "1m":
          // Daily buckets for last month
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
          }
        case "3m":
          // Weekly buckets for last 3 months
          const startOfWeek = new Date(d)
          const day = startOfWeek.getDay()
          const diff = startOfWeek.getDate() - day
          startOfWeek.setDate(diff)
          startOfWeek.setHours(0, 0, 0, 0)
          return {
            key: startOfWeek.toISOString(),
            display: `Week of ${startOfWeek.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })}`,
          }
        case "all":
          // Monthly buckets for all time
          d.setDate(1)
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
            }),
          }
        default:
          // Default to daily
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
          }
      }
    }

    chats.forEach((chat) => {
      // Check if chat has an agent
      if (chat.agentId && chat.agentId !== "") {
        agentChats++

        // Update agent usage
        if (!agentUsageMap.has(chat.agentId)) {
          const agent = agentMap.get(chat.agentId)
          agentUsageMap.set(chat.agentId, {
            agentId: chat.agentId,
            agentName: agent?.name || `Unknown Agent`,
            chatCount: 0,
            messageCount: 0,
            likes: 0,
            dislikes: 0,
            totalCost: 0,
            totalTokens: 0,
            lastUsed: chat.createdAt,
          })
        }

        const agentUsage = agentUsageMap.get(chat.agentId)!
        agentUsage.chatCount++
        // Add message count for this chat if available
        const chatData = messageCounts[chat.externalId]
        if (chatData) {
          agentUsage.messageCount += chatData.messageCount
          agentUsage.totalCost += chatData.totalCost
          agentUsage.totalTokens += chatData.totalTokens
        }

        // Add feedback counts for this chat if available
        const chatFeedback = feedbackStats.feedbackByChat[chat.externalId]
        if (chatFeedback) {
          agentUsage.likes += chatFeedback.likes
          agentUsage.dislikes += chatFeedback.dislikes
        }

        if (new Date(chat.createdAt) > new Date(agentUsage.lastUsed)) {
          agentUsage.lastUsed = chat.createdAt
        }
      } else {
        normalChats++
      }

      // Process time series data with appropriate bucketing
      const date = new Date(chat.createdAt)
      const timeBucket = getTimeBucket(date, timeRange)

      // Update time series data
      if (!timeSeriesMap.has(timeBucket.key)) {
        timeSeriesMap.set(timeBucket.key, {
          time: timeBucket.display,
          totalChats: 0,
          normalChats: 0,
          agentChats: 0,
          totalMessages: 0,
          normalMessages: 0,
          agentMessages: 0,
          totalCost: 0,
          totalTokens: 0,
        })
      }

      const timeData = timeSeriesMap.get(timeBucket.key)!
      const chatData = messageCounts[chat.externalId]
      const chatMessageCount = chatData ? chatData.messageCount : 0
      const chatCost = chatData ? chatData.totalCost : 0
      const chatTokens = chatData ? chatData.totalTokens : 0

      timeData.totalChats++
      timeData.totalMessages += chatMessageCount
      timeData.totalCost += chatCost
      timeData.totalTokens += chatTokens

      if (chat.agentId && chat.agentId !== "") {
        timeData.agentChats++
        timeData.agentMessages += chatMessageCount
      } else {
        timeData.normalChats++
        timeData.normalMessages += chatMessageCount
      }
    })

    // Convert maps to arrays and sort by time
    let recentActivity = Array.from(timeSeriesMap.values()).sort((a, b) => {
      // Sort by the original key (ISO string) for proper chronological order
      const aKey =
        Array.from(timeSeriesMap.entries()).find(
          ([_, value]) => value === a,
        )?.[0] || ""
      const bKey =
        Array.from(timeSeriesMap.entries()).find(
          ([_, value]) => value === b,
        )?.[0] || ""
      return new Date(aKey).getTime() - new Date(bKey).getTime()
    })

    // Fill in missing time periods with zero values for all time ranges
    const fillMissingPeriods = (timeRange: string, now: Date) => {
      const allPeriods = []

      switch (timeRange) {
        case "today":
          // Last 24 hours (hourly buckets)
          for (let i = 23; i >= 0; i--) {
            const date = new Date(now.getTime() - i * 60 * 60 * 1000) // hours
            const timeBucket = getTimeBucket(date, timeRange)

            const existingData = recentActivity.find((activity) => {
              const existingKey =
                Array.from(timeSeriesMap.entries()).find(
                  ([_, value]) => value.time === activity.time,
                )?.[0] || ""
              return existingKey === timeBucket.key
            })

            if (existingData) {
              allPeriods.push(existingData)
            } else {
              allPeriods.push({
                time: timeBucket.display,
                totalChats: 0,
                normalChats: 0,
                agentChats: 0,
                totalMessages: 0,
                normalMessages: 0,
                agentMessages: 0,
                totalCost: 0,
                totalTokens: 0,
              })
            }
          }
          break
        case "1w":
          // Last 7 days
          for (let i = 6; i >= 0; i--) {
            const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
            const timeBucket = getTimeBucket(date, timeRange)

            const existingData = recentActivity.find((activity) => {
              const existingKey =
                Array.from(timeSeriesMap.entries()).find(
                  ([_, value]) => value.time === activity.time,
                )?.[0] || ""
              return existingKey === timeBucket.key
            })

            if (existingData) {
              allPeriods.push(existingData)
            } else {
              allPeriods.push({
                time: timeBucket.display,
                totalChats: 0,
                normalChats: 0,
                agentChats: 0,
                totalMessages: 0,
                normalMessages: 0,
                agentMessages: 0,
                totalCost: 0,
                totalTokens: 0,
              })
            }
          }
          break

        case "1m":
          // Last 30 days
          for (let i = 29; i >= 0; i--) {
            const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
            const timeBucket = getTimeBucket(date, timeRange)

            const existingData = recentActivity.find((activity) => {
              const existingKey =
                Array.from(timeSeriesMap.entries()).find(
                  ([_, value]) => value.time === activity.time,
                )?.[0] || ""
              return existingKey === timeBucket.key
            })

            if (existingData) {
              allPeriods.push(existingData)
            } else {
              allPeriods.push({
                time: timeBucket.display,
                totalChats: 0,
                normalChats: 0,
                agentChats: 0,
                totalMessages: 0,
                normalMessages: 0,
                agentMessages: 0,
                totalCost: 0,
                totalTokens: 0,
              })
            }
          }
          break

        case "3m":
          // Last 12 weeks (approximately 3 months)
          for (let i = 11; i >= 0; i--) {
            const date = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000) // weeks
            const timeBucket = getTimeBucket(date, timeRange)

            const existingData = recentActivity.find((activity) => {
              const existingKey =
                Array.from(timeSeriesMap.entries()).find(
                  ([_, value]) => value.time === activity.time,
                )?.[0] || ""
              return existingKey === timeBucket.key
            })

            if (existingData) {
              allPeriods.push(existingData)
            } else {
              allPeriods.push({
                time: timeBucket.display,
                totalChats: 0,
                normalChats: 0,
                agentChats: 0,
                totalMessages: 0,
                normalMessages: 0,
                agentMessages: 0,
                totalCost: 0,
                totalTokens: 0,
              })
            }
          }
          break

        case "all":
          // For 'all', we don't fill gaps since the time range can be very large
          // Just return the existing data
          return recentActivity

        default:
          return recentActivity
      }

      return allPeriods
    }

    // Apply the fill logic for all time ranges except 'all'
    const now = new Date()
    recentActivity = fillMissingPeriods(timeRange, now)

    const agentUsage = Array.from(agentUsageMap.values())
    const activeAgents = agentUsage.length

    return {
      totalChats: chats.length,
      totalMessages: totalMessages,
      totalCost: totalCostCalculated,
      totalTokens: totalTokensCalculated,
      activeAgents,
      normalChats,
      agentChats,
      recentActivity,
      agentUsage,
      feedbackStats,
    }
  }

  const processAdminChatsData = (
    chats: any[],
    agents: Agent[],
    timeRange: "today" | "1w" | "1m" | "3m" | "all",
  ): AdminDashboardStats => {
    const userUsageMap = new Map<string, AdminUserUsage>()
    const timeSeriesMap = new Map<string, TimeSeriesData>()
    const agentUsageMap = new Map<string, AgentUsageData>()

    let totalMessages = 0
    let totalCostCalculated = 0
    let totalTokensCalculated = 0
    let totalUsers = new Set<string>()
    let normalChats = 0
    let agentChats = 0

    const now = new Date()
    const agentMap = new Map(agents.map((a) => [a.externalId, a]))

    // Determine the appropriate time bucket size and format based on time range
    const getTimeBucket = (date: Date, timeRange: string) => {
      const d = new Date(date)

      switch (timeRange) {
        case "today":
          d.setMinutes(0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleTimeString("en-US", {
              hour: "numeric",
              hour12: true,
            }),
          }
        case "1w":
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
          }
        case "1m":
        case "3m":
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            }),
          }
        case "all":
          d.setDate(1)
          d.setHours(0, 0, 0, 0)
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString("en-US", {
              year: "numeric",
              month: "short",
            }),
          }
        default:
          return {
            key: d.toISOString(),
            display: d.toLocaleDateString(),
          }
      }
    }

    chats.forEach((chat) => {
      const userId = chat.userId || chat.user?.id || "unknown"
      const userEmail = chat.userEmail || chat.user?.email || ""
      const userName =
        chat.userName ||
        chat.user?.name ||
        userEmail.split("@")[0] ||
        "Unknown User"
      const userRole = chat.userRole || chat.user?.role || "user"

      totalUsers.add(userId.toString())

      if (chat.agentId) {
        agentChats++

        // Only include agents that actually exist in the database
        const agent = agentMap.get(chat.agentId)
        if (agent) {
          // Update agent usage
          if (!agentUsageMap.has(chat.agentId)) {
            agentUsageMap.set(chat.agentId, {
              agentId: chat.agentId,
              agentName: agent.name,
              chatCount: 0,
              messageCount: 0,
              likes: 0,
              dislikes: 0,
              totalCost: 0,
              totalTokens: 0,
              lastUsed: chat.createdAt,
            })
          }

          const agentUsage = agentUsageMap.get(chat.agentId)!
          agentUsage.chatCount++
          const messageCountForChat =
            chat.messageCount || chat.messages?.length || 0
          agentUsage.messageCount += messageCountForChat

          // Add cost and token tracking from chat data
          agentUsage.totalCost += chat.totalCost || 0
          agentUsage.totalTokens += chat.totalTokens || 0

          // Add feedback counts from this chat
          agentUsage.likes += chat.likes || 0
          agentUsage.dislikes += chat.dislikes || 0

          if (new Date(chat.createdAt) > new Date(agentUsage.lastUsed)) {
            agentUsage.lastUsed = chat.createdAt
          }
        }
      } else {
        normalChats++
      }

      const messageCountForChat =
        chat.messageCount || chat.messages?.length || 0
      totalMessages += messageCountForChat
      totalCostCalculated += chat.totalCost || 0
      totalTokensCalculated += chat.totalTokens || 0

      // Track user usage
      const userKey = userId.toString()
      if (!userUsageMap.has(userKey)) {
        userUsageMap.set(userKey, {
          userId: typeof userId === "string" ? parseInt(userId) : userId,
          userName,
          userEmail,
          role: userRole,
          messageCount: 0,
          chatCount: 0,
          agentChats: 0,
          normalChats: 0,
          likes: 0,
          dislikes: 0,
          totalCost: 0,
          totalTokens: 0,
          lastActive: chat.createdAt,
          createdAt: chat.userCreatedAt || chat.createdAt, // Use userCreatedAt (user's join date) instead of chat creation date
        })
      }

      const userUsage = userUsageMap.get(userKey)!
      userUsage.messageCount += messageCountForChat
      userUsage.chatCount++

      // Add cost and token tracking from chat data
      userUsage.totalCost += chat.totalCost || 0
      userUsage.totalTokens += chat.totalTokens || 0

      // Add feedback counts from this chat
      userUsage.likes += chat.likes || 0
      userUsage.dislikes += chat.dislikes || 0

      if (chat.agentId) {
        userUsage.agentChats++
      } else {
        userUsage.normalChats++
      }

      const chatDate = new Date(chat.createdAt)
      if (new Date(chat.createdAt) > new Date(userUsage.lastActive)) {
        userUsage.lastActive = chat.createdAt
      }

      // Track time series data
      const timeBucket = getTimeBucket(chatDate, timeRange)
      if (!timeSeriesMap.has(timeBucket.key)) {
        timeSeriesMap.set(timeBucket.key, {
          time: timeBucket.display,
          totalChats: 0,
          normalChats: 0,
          agentChats: 0,
          totalMessages: 0,
          normalMessages: 0,
          agentMessages: 0,
          totalCost: 0,
          totalTokens: 0,
        })
      }

      const timeData = timeSeriesMap.get(timeBucket.key)!
      timeData.totalChats++
      if (chat.agentId) {
        timeData.agentChats++
        timeData.agentMessages += messageCountForChat
      } else {
        timeData.normalChats++
        timeData.normalMessages += messageCountForChat
      }
      timeData.totalMessages += messageCountForChat
    })

    // Fill missing time periods
    const fillMissingPeriods = (timeRange: string, endDate: Date) => {
      const sortedEntries = Array.from(timeSeriesMap.entries()).sort(
        (a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime(),
      )

      if (sortedEntries.length === 0) return []

      const result: TimeSeriesData[] = []
      const startDate = new Date(sortedEntries[0][0])
      const current = new Date(startDate)

      while (current <= endDate) {
        const bucket = getTimeBucket(current, timeRange)
        const existing = timeSeriesMap.get(bucket.key)

        result.push(
          existing || {
            time: bucket.display,
            totalChats: 0,
            normalChats: 0,
            agentChats: 0,
            totalMessages: 0,
            normalMessages: 0,
            agentMessages: 0,
            totalCost: 0,
            totalTokens: 0,
          },
        )

        // Increment based on time range
        switch (timeRange) {
          case "today":
            current.setHours(current.getHours() + 1)
            break
          case "1w":
          case "1m":
          case "3m":
            current.setDate(current.getDate() + 1)
            break
          case "all":
            current.setMonth(current.getMonth() + 1)
            break
        }
      }

      return result
    }

    let recentActivity: TimeSeriesData[] = Array.from(
      timeSeriesMap.values(),
    ).sort((a, b) => {
      const aTime = timeSeriesMap.keys()
      const bTime = timeSeriesMap.keys()
      return (
        new Date(
          Array.from(aTime).find((k) => timeSeriesMap.get(k) === a) || "",
        ).getTime() -
        new Date(
          Array.from(bTime).find((k) => timeSeriesMap.get(k) === b) || "",
        ).getTime()
      )
    })

    recentActivity = fillMissingPeriods(timeRange, now)

    const userUsage = Array.from(userUsageMap.values())

    // Create agent usage for ALL agents, including those with zero usage
    const allAgentUsage: AgentUsageData[] = agents.map((agent) => {
      const existingUsage = agentUsageMap.get(agent.externalId)
      return (
        existingUsage || {
          agentId: agent.externalId,
          agentName: agent.name,
          chatCount: 0,
          messageCount: 0,
          likes: 0,
          dislikes: 0,
          totalCost: 0,
          totalTokens: 0,
          lastUsed: agent.createdAt || new Date().toISOString(),
        }
      )
    })

    return {
      totalChats: chats.length,
      totalMessages,
      totalCost: totalCostCalculated,
      totalTokens: totalTokensCalculated,
      totalUsers: totalUsers.size,
      totalAgents: agents.length,
      totalSharedAgents: agents.filter((a) => a.isPublic === true).length, // Count public agents
      recentActivity,
      topUsers: userUsage.sort((a, b) => b.messageCount - a.messageCount), // Return ALL users sorted
      agentUsage: allAgentUsage.sort((a, b) => b.chatCount - a.chatCount),
      feedbackStats: {
        totalLikes: 0,
        totalDislikes: 0,
        feedbackByChat: {},
        feedbackMessages: [],
      }, // This would need to be calculated if needed
    }
  }

  if (loading) {
    return (
      <div className="h-full w-full flex dark:bg-[#1E1E1E]">
        <Sidebar photoLink={photoLink} role={role} isAgentMode={isAgentMode} />
        <div className="flex flex-col flex-grow h-full ml-[52px]">
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              <div className="relative">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              </div>
              <p className="text-lg font-medium">Loading Dashboard</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full w-full flex dark:bg-[#1E1E1E]">
        <Sidebar photoLink={photoLink} role={role} isAgentMode={isAgentMode} />
        <div className="flex flex-col flex-grow h-full ml-[52px]">
          <div className="flex items-center justify-center h-full">
            <div className="text-center space-y-4">
              <p className="text-lg font-medium text-red-600">
                Error loading dashboard
              </p>
              <p className="text-sm text-muted-foreground">{error}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full w-full flex dark:bg-[#1E1E1E]">
      <Sidebar photoLink={photoLink} role={role} isAgentMode={isAgentMode} />
      <div className="flex flex-col flex-grow h-full ml-[52px]">
        <div className="p-6 space-y-6 max-w-7xl mx-auto">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl tracking-wider font-display ">
                Dashboard
              </h1>
              <p className="text-muted-foreground">
                Monitor your Xyne chat activity and agent usage
              </p>
            </div>

            <div className="flex items-center gap-4">
              {/* Main Tabs - My Activity vs Shared Agent Usage vs Admin */}
              <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
                <button
                  onClick={() => {
                    setMainTab("my-activity")
                    setDashboardTab("my-activity")
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    mainTab === "my-activity"
                      ? "bg-white dark:bg-gray-800 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    My Activity
                  </div>
                </button>
                <button
                  onClick={() => {
                    setMainTab("shared-agents")
                    setDashboardTab("shared-agents")
                  }}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    mainTab === "shared-agents"
                      ? "bg-white dark:bg-gray-800 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    My Agents
                  </div>
                </button>
                {isAdmin && (
                  <>
                    <button
                      onClick={() => {
                        setMainTab("admin-overview")
                        setDashboardTab("admin-overview")
                      }}
                      className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                        mainTab === "admin-overview"
                          ? "bg-white dark:bg-gray-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4" />
                        Admin Overview
                      </div>
                    </button>
                  </>
                )}
              </div>

              <select
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value as any)}
                className="px-3 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              >
                <option value="today">Today</option>
                <option value="1w">Last Week</option>
                <option value="1m">Last Month</option>
                <option value="3m">Last 3 Months</option>
                <option value="all">All Time</option>
              </select>
            </div>
          </div>

          {/* Content based on main tab */}
          {mainTab === "my-activity" ? (
            <>
              {/* Key Metrics Row */}
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
                <MetricCard
                  title="Total Chats"
                  value={stats.totalChats.toLocaleString()}
                  description="All chat conversations"
                  icon={MessageSquare}
                />
                <MetricCard
                  title="Total Messages"
                  value={stats.totalMessages.toLocaleString()}
                  description="Messages across all chats"
                  icon={Activity}
                />
                <MetricCard
                  title="Normal Chats"
                  value={stats.normalChats.toLocaleString()}
                  description="Chats without AI agents"
                  icon={Users}
                />
                <MetricCard
                  title="Agent Chats"
                  value={stats.agentChats.toLocaleString()}
                  description="Chats with AI agent help"
                  icon={Bot}
                />
                <MetricCard
                  title="Total Likes"
                  value={stats.feedbackStats.totalLikes.toLocaleString()}
                  description="Positive user feedback"
                  icon={ThumbsUp}
                  className="border-green-200 dark:border-green-800"
                />
                <MetricCard
                  title="Total Dislikes"
                  value={stats.feedbackStats.totalDislikes.toLocaleString()}
                  description="Negative user feedback"
                  icon={ThumbsDown}
                  className="border-red-200 dark:border-red-800"
                />
              </div>

              {/* Tabs for Charts */}
              <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
                <button
                  onClick={() => setActiveTab("agent")}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    activeTab === "agent"
                      ? "bg-white dark:bg-gray-800 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4" />
                    Agent Message Analysis
                  </div>
                </button>
                <button
                  onClick={() => setActiveTab("normal")}
                  className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                    activeTab === "normal"
                      ? "bg-white dark:bg-gray-800 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Message Analysis
                  </div>
                </button>
              </div>

              {/* Charts Section based on active tab */}
              {activeTab === "agent" ? (
                <div className="space-y-6">
                  <MessageActivityChart
                    data={stats.recentActivity}
                    timeRange={timeRange}
                    type="agent"
                  />
                  <AgentUsageCard
                    agentUsage={stats.agentUsage}
                    showAll={true}
                  />
                </div>
              ) : (
                <div className="space-y-6">
                  <MessageActivityChart
                    data={stats.recentActivity}
                    timeRange={timeRange}
                    type="normal"
                  />
                  <AgentUsageCard
                    agentUsage={stats.agentUsage}
                    showAll={true}
                  />
                </div>
              )}
            </>
          ) : mainTab === "shared-agents" ? (
            <>
              {/* Shared Agent Usage Tab Content */}
              {sharedAgentError ? (
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-center text-red-600 dark:text-red-400">
                      {sharedAgentError}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <SharedAgentUsageCard
                  sharedAgentData={sharedAgentStats}
                  loading={sharedAgentLoading}
                  timeRange={timeRange}
                  selectedAgent={selectedSharedAgent}
                  setSelectedAgent={setSelectedSharedAgent}
                />
              )}
            </>
          ) : mainTab === "admin-overview" ? (
            <>
              {/* Admin Overview Tab Content */}
              {adminError ? (
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-center text-red-600 dark:text-red-400">
                      {adminError}
                    </div>
                  </CardContent>
                </Card>
              ) : selectedUser ? (
                <div
                  className={`transition-all duration-300 ease-in-out ${isAdminTransitioning ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}
                >
                  <UserDetailPage
                    user={selectedUser}
                    onBack={() => handleAdminUserSelect(selectedUser)}
                    timeRange={timeRange}
                    navigate={navigate}
                    setSelectedUserInStore={setSelectedUserInStore}
                  />
                </div>
              ) : selectedAgent ? (
                <div
                  className={`transition-all duration-300 ease-in-out ${isAdminTransitioning ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}
                >
                  <AgentAnalysisPage
                    agent={selectedAgent}
                    onBack={() => handleAdminAgentSelect(selectedAgent)}
                    timeRange={timeRange}
                    currentUser={user}
                  />
                </div>
              ) : (
                <div
                  className={`transition-all duration-300 ease-in-out space-y-6 ${isAdminTransitioning ? "opacity-0 scale-95" : "opacity-100 scale-100"}`}
                >
                  {/* System-wide Metrics */}
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-6">
                    <MetricCard
                      title="Total Users"
                      value={adminStats.totalUsers.toLocaleString()}
                      description="Registered platform users"
                      icon={Users}
                    />
                    <MetricCard
                      title="Total Chats"
                      value={adminStats.totalChats.toLocaleString()}
                      description="All chat conversations"
                      icon={MessageSquare}
                    />
                    <MetricCard
                      title="Total Messages"
                      value={adminStats.totalMessages.toLocaleString()}
                      description="All messages sent system-wide"
                      icon={Activity}
                    />
                    <MetricCard
                      title="Total Agents"
                      value={adminStats.totalAgents.toLocaleString()}
                      description="All created AI agents"
                      icon={Bot}
                    />
                    <MetricCard
                      title="Shared Agents"
                      value={adminStats.totalSharedAgents.toLocaleString()}
                      description="Publicly shared agents"
                      icon={Users}
                    />
                    <MetricCard
                      title="Active Ratio"
                      value={`${adminStats.totalChats > 0 ? Math.round((adminStats.totalMessages / adminStats.totalChats) * 100) / 100 : 0}:1`}
                      description="Messages per chat session"
                      icon={Activity}
                    />
                  </div>

                  {/* Show More Metrics Button */}
                  <ShowMoreMetricsToggle
                    showMoreMetrics={showMoreAdminMetrics}
                    onToggle={() =>
                      setShowMoreAdminMetrics(!showMoreAdminMetrics)
                    }
                  />

                  {/* Additional Metrics (Expandable) */}
                  <ExpandableMetricsSection
                    showMoreMetrics={showMoreAdminMetrics}
                    className="pt-2"
                  >
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                      <MetricCard
                        title="Total Cost"
                        value={formatCostInINR(adminStats.totalCost)}
                        description="System-wide LLM usage cost"
                        icon={Activity}
                      />
                      <MetricCard
                        title="Total Tokens"
                        value={(adminStats.totalTokens || 0).toLocaleString()}
                        description="Total tokens processed"
                        icon={Activity}
                      />
                      <MetricCard
                        title="Cost Per Message"
                        value={formatCostPerMessageInINR(
                          adminStats.totalCost,
                          adminStats.totalMessages,
                        )}
                        description="Average cost per message"
                        icon={Activity}
                      />
                      <MetricCard
                        title="Tokens Per Message"
                        value={
                          adminStats.totalMessages > 0
                            ? Math.round(
                                safeNumberConversion(adminStats.totalTokens) /
                                  adminStats.totalMessages,
                              ).toLocaleString()
                            : "0"
                        }
                        description="Average tokens per message"
                        icon={Activity}
                      />
                    </div>
                  </ExpandableMetricsSection>

                  {/* Tabs for Charts */}
                  <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
                    <button
                      onClick={() => setActiveTab("agent")}
                      className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                        activeTab === "agent"
                          ? "bg-white dark:bg-gray-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4" />
                        Agent Message Analysis
                      </div>
                    </button>
                    <button
                      onClick={() => setActiveTab("normal")}
                      className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                        activeTab === "normal"
                          ? "bg-white dark:bg-gray-800 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4" />
                        Normal Message Analysis
                      </div>
                    </button>
                  </div>

                  {/* Charts Section based on active tab */}
                  {activeTab === "agent" ? (
                    <MessageActivityChart
                      data={adminStats.recentActivity}
                      timeRange={timeRange}
                      type="agent"
                    />
                  ) : (
                    <MessageActivityChart
                      data={adminStats.recentActivity}
                      timeRange={timeRange}
                      type="normal"
                    />
                  )}

                  {/* Users Leaderboard with click functionality */}
                  <AdminUsersLeaderboard
                    users={adminStats.topUsers}
                    loading={adminLoading}
                    onUserClick={handleAdminUserSelect}
                    onAllChatsClick={() => {
                      // Navigate to all chats view
                      navigate({ to: "/admin/chat-overview" as const })
                    }}
                    onUserChatsClick={(userId: number, userName: string) => {
                      // Find the user from the admin users list
                      const selectedUser = adminStats.topUsers.find(
                        (u) => u.userId === userId,
                      )

                      if (selectedUser) {
                        // Set user in store
                        setSelectedUserInStore({
                          userId: selectedUser.userId,
                          userName: selectedUser.userName,
                          userEmail: selectedUser.userEmail,
                        })
                      }

                      // Navigate to user-specific chats view (without URL params)
                      navigate({
                        to: "/admin/chat-overview" as const,
                      })
                    }}
                  />

                  {/* Top Agents System-wide */}
                  <AgentUsageCard
                    agentUsage={adminStats.agentUsage}
                    showAll={true}
                    onAgentClick={handleAdminAgentSelect}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {/* Shared Agent Usage Tab Content */}
              {sharedAgentError ? (
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-center text-red-600 dark:text-red-400">
                      {sharedAgentError}
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <SharedAgentUsageCard
                  sharedAgentData={sharedAgentStats}
                  loading={sharedAgentLoading}
                  timeRange={timeRange}
                  selectedAgent={selectedSharedAgent}
                  setSelectedAgent={setSelectedSharedAgent}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
