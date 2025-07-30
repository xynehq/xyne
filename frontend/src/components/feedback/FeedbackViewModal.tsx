import React, { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  MessageSquare,
  Clock,
  Bot,
  Search,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import { api } from "@/api"
import { MessageContent } from "@/lib/messageUtils"

interface BaseFeedbackMessage {
  messageId: string
  chatExternalId: string
  userEmail: string
  userName: string
  type: "like" | "dislike"
  feedbackText: string[]
  timestamp: string
  shareToken?: string | null
}

interface AgentFeedbackMessage extends BaseFeedbackMessage {
  // For agent-specific feedback (no additional fields needed)
}

interface UserFeedbackMessage extends BaseFeedbackMessage {
  agentId?: string | null
  agentName?: string | null
  messageContent?: string // User's original message/query
}

type FeedbackMessage = AgentFeedbackMessage | UserFeedbackMessage

// Agent-specific props
interface AgentFeedbackProps {
  mode: "agent"
  isOpen: boolean
  onClose: () => void
  agentId: string
  agentName: string
}

// User-specific props (shows feedback from user across all agents)
interface UserFeedbackProps {
  mode: "user"
  isOpen: boolean
  onClose: () => void
  userId: number
  userName: string
  userEmail: string
  showSearch?: boolean
  showAgentFilter?: boolean
}

// Agent + User specific props (shows feedback from specific user for specific agent)
interface AgentUserFeedbackProps {
  mode: "agent-user"
  isOpen: boolean
  onClose: () => void
  agentId: string
  agentName: string
  userId: number
  userName: string
  userEmail: string
}

type FeedbackViewModalProps =
  | AgentFeedbackProps
  | UserFeedbackProps
  | AgentUserFeedbackProps

export const FeedbackViewModal: React.FC<FeedbackViewModalProps> = (props) => {
  const { mode, isOpen, onClose } = props
  const [feedbackMessages, setFeedbackMessages] = useState<FeedbackMessage[]>(
    [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [showAgentsOnly, setShowAgentsOnly] = useState(false)

  const fetchFeedbackMessages = async () => {
    setLoading(true)
    setError(null)

    try {
      let response: Response

      if (mode === "agent") {
        const agentProps = props as AgentFeedbackProps
        response = await api.admin.agents[agentProps.agentId].feedback.$get()
      } else if (mode === "user") {
        const userProps = props as UserFeedbackProps
        response = await api.admin.users[userProps.userId].feedback.$get()
      } else if (mode === "agent-user") {
        const agentUserProps = props as AgentUserFeedbackProps
        response =
          await api.admin.agents[agentUserProps.agentId]["user-feedback"][
            agentUserProps.userId
          ].$get()
      } else {
        throw new Error("Invalid mode")
      }

      if (!response.ok) {
        throw new Error("Failed to fetch feedback messages")
      }

      const data = await response.json()

      if (data.success) {
        setFeedbackMessages(data.data || [])
      } else {
        throw new Error(data.message || "Failed to fetch feedback messages")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isOpen) {
      fetchFeedbackMessages()
    }
  }, [
    isOpen,
    mode,
    ...(mode === "agent" ? [(props as AgentFeedbackProps).agentId] : []),
    ...(mode === "user" ? [(props as UserFeedbackProps).userId] : []),
    ...(mode === "agent-user"
      ? [
          (props as AgentUserFeedbackProps).agentId,
          (props as AgentUserFeedbackProps).userId,
        ]
      : []),
  ])

  const handleViewSharedChat = (shareToken: string) => {
    const shareUrl = `${window.location.origin}/chat?shareToken=${shareToken}`
    window.open(shareUrl, "_blank")
  }

  const getModalTitle = () => {
    if (mode === "agent") {
      const agentProps = props as AgentFeedbackProps
      return `Feedback for ${agentProps.agentName}`
    } else if (mode === "user") {
      return "User Feedback"
    } else if (mode === "agent-user") {
      const agentUserProps = props as AgentUserFeedbackProps
      return `${agentUserProps.userName}'s Feedback for ${agentUserProps.agentName}`
    }
    return "Feedback"
  }

  const getModalSubtitle = () => {
    if (mode === "user") {
      const userProps = props as UserFeedbackProps
      return `All feedback from ${userProps.userName} (${userProps.userEmail})`
    } else if (mode === "agent-user") {
      const agentUserProps = props as AgentUserFeedbackProps
      return `Feedback from ${agentUserProps.userName} (${agentUserProps.userEmail})`
    }
    return undefined
  }

  const shouldShowSearch = () => {
    if (mode === "user") {
      const userProps = props as UserFeedbackProps
      return userProps.showSearch !== false // Default to true
    }
    return mode === "agent-user" // Show search for agent-user mode
  }

  const shouldShowAgentFilter = () => {
    if (mode === "user") {
      const userProps = props as UserFeedbackProps
      return userProps.showAgentFilter !== false // Default to true
    }
    return false // Only show for user mode
  }

  const isUserFeedbackMessage = (
    message: FeedbackMessage,
  ): message is UserFeedbackMessage => {
    return (
      "agentId" in message ||
      "agentName" in message ||
      "messageContent" in message
    )
  }

  // Filter messages based on search query and agent filter
  const filteredMessages = feedbackMessages.filter((message) => {
    // Filter by agents only if enabled (only for user mode)
    if (shouldShowAgentFilter() && showAgentsOnly) {
      const userMessage = message as UserFeedbackMessage
      if (!userMessage.agentName || userMessage.agentName.trim() === "") {
        return false
      }
    }

    // Filter by search query if provided
    if (searchQuery.trim() !== "") {
      const query = searchQuery.toLowerCase()
      const userMessage = message as UserFeedbackMessage

      const matchesAgentName =
        userMessage.agentName?.toLowerCase().includes(query) || false
      const matchesFeedbackText = message.feedbackText.some((text) =>
        text.toLowerCase().includes(query),
      )
      const matchesMessageContent =
        userMessage.messageContent?.toLowerCase().includes(query) || false
      const matchesUserName = message.userName.toLowerCase().includes(query)
      const matchesUserEmail = message.userEmail.toLowerCase().includes(query)

      return (
        matchesAgentName ||
        matchesFeedbackText ||
        matchesMessageContent ||
        matchesUserName ||
        matchesUserEmail
      )
    }

    return true
  })

  return (
    <Dialog open={isOpen} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader className="px-4">
          <div className="flex items-center justify-between">
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5" />
              {getModalTitle()}
            </DialogTitle>
          </div>
          {getModalSubtitle() && (
            <p className="text-sm text-muted-foreground mt-2">
              {getModalSubtitle()}
            </p>
          )}
        </DialogHeader>

        {/* Search and Filter Controls */}
        {(shouldShowSearch() || shouldShowAgentFilter()) && (
          <div className="flex items-center gap-3 px-4 pb-4 border-b">
            {shouldShowSearch() && (
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search feedback, agents, or messages..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            )}
            {shouldShowAgentFilter() && (
              <Button
                variant={showAgentsOnly ? "default" : "outline"}
                size="sm"
                onClick={() => setShowAgentsOnly(!showAgentsOnly)}
                className="whitespace-nowrap"
              >
                Agents Only
              </Button>
            )}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-6">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <p className="text-red-600 mb-2">{error}</p>
              <Button
                onClick={fetchFeedbackMessages}
                variant="outline"
                className="mt-2"
              >
                Try Again
              </Button>
            </div>
          )}

          {!loading && !error && filteredMessages.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              <MessageSquare className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <div className="text-gray-500 mb-2">
                No feedback messages found
              </div>
              <div className="text-sm text-gray-400">
                {searchQuery.trim() !== ""
                  ? "Try adjusting your search criteria."
                  : mode === "agent"
                    ? "No feedback messages found for this agent."
                    : "This user hasn't provided any feedback yet."}
              </div>
            </div>
          )}

          {!loading && !error && filteredMessages.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {filteredMessages.length} feedback message
                  {filteredMessages.length === 1 ? "" : "s"} found
                  {filteredMessages.length !== feedbackMessages.length &&
                    ` (${feedbackMessages.length} total)`}
                </p>
              </div>

              {filteredMessages.map((feedback, index) => (
                <div
                  key={feedback.messageId || index}
                  className="border rounded-lg p-4 space-y-3 hover:bg-muted/20 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3 flex-wrap">
                      <div className="flex items-center gap-2">
                        {feedback.type === "like" ? (
                          <ThumbsUp className="w-4 h-4 text-green-600" />
                        ) : (
                          <ThumbsDown className="w-4 h-4 text-red-600" />
                        )}
                      </div>

                      {isUserFeedbackMessage(feedback) &&
                        feedback.agentName && (
                          <div className="flex items-center gap-1 text-sm text-muted-foreground">
                            <Bot className="w-3 h-3" />
                            <span className="font-medium">
                              {feedback.agentName}
                            </span>
                          </div>
                        )}

                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>
                          {formatDistanceToNow(new Date(feedback.timestamp), {
                            addSuffix: true,
                          })}
                        </span>
                      </div>
                    </div>

                    {feedback.shareToken && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          handleViewSharedChat(feedback.shareToken!)
                        }
                        className="flex items-center gap-1"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View Chat
                      </Button>
                    )}
                  </div>

                  {/* Show original message content if available */}
                  {isUserFeedbackMessage(feedback) &&
                    feedback.messageContent && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">User Query:</p>
                        <div className="bg-muted/20 rounded-md p-3">
                          <MessageContent content={feedback.messageContent} />
                        </div>
                      </div>
                    )}

                  {feedback.feedbackText.length > 0 &&
                    feedback.feedbackText.some((text) => text.trim()) && (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Feedback:</p>
                        <div className="bg-muted/30 rounded-md p-3 space-y-2">
                          {feedback.feedbackText
                            .filter((text) => text.trim())
                            .map((text, index) => (
                              <p key={index} className="text-sm">
                                • {text}
                              </p>
                            ))}
                        </div>
                      </div>
                    )}
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Export convenience components for easier migration and backward compatibility
export const AgentFeedbackModal: React.FC<Omit<AgentFeedbackProps, "mode">> = (
  props,
) => <FeedbackViewModal mode="agent" {...props} />

export const UserFeedbackModal: React.FC<Omit<UserFeedbackProps, "mode">> = (
  props,
) => <FeedbackViewModal mode="user" {...props} />

export const AgentUserFeedbackModal: React.FC<
  Omit<AgentUserFeedbackProps, "mode">
> = (props) => <FeedbackViewModal mode="agent-user" {...props} />

// For backward compatibility with existing component names
export const FeedbackMessagesModal = AgentFeedbackModal
export const AdminFeedbackModal = UserFeedbackModal
