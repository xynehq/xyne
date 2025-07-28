import React, { useState, useEffect } from "react"
import { createPortal } from "react-dom"
import {
  X,
  MessageCircle,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  Calendar,
  User,
  Search,
} from "lucide-react"
import { api } from "@/api"
import { MessageContent } from "@/lib/messageUtils"

interface FeedbackMessage {
  messageId: number // Should be number as it comes from the database
  chatExternalId: string
  agentId?: string | null // Optional for admin mode, can be null for normal chats
  agentName?: string | null // Optional for admin mode, null for normal chats
  type: "like" | "dislike"
  feedbackText: string[]
  timestamp: string
  shareToken?: string
  messageContent: string // User's original message/query
}

interface FeedbackMessagesModalProps {
  isOpen: boolean
  onClose: () => void
  agentId?: string // Optional - if provided, shows agent-specific feedback
  userId: number
  userName: string
  userEmail: string
  isAdminMode?: boolean // If true, shows feedback from all agents
}

export const FeedbackMessagesModal: React.FC<FeedbackMessagesModalProps> = ({
  isOpen,
  onClose,
  agentId,
  userId,
  userName,
  userEmail,
  isAdminMode = false,
}) => {
  const [feedbackMessages, setFeedbackMessages] = useState<FeedbackMessage[]>(
    [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showAgentsOnly, setShowAgentsOnly] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  useEffect(() => {
    if (isOpen && userId) {
      fetchFeedbackMessages()
    }
  }, [isOpen, agentId, userId, isAdminMode])

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscape)
      // Prevent body scroll when modal is open
      document.body.style.overflow = "hidden"
    }

    return () => {
      document.removeEventListener("keydown", handleEscape)
      document.body.style.overflow = "auto"
    }
  }, [isOpen, onClose])

  const fetchFeedbackMessages = async () => {
    try {
      setLoading(true)
      setError(null)

      let response

      if (isAdminMode) {
        // Admin mode - get all feedback for user across all agents
        response = await api.admin.users[userId].feedback.$get()
      } else if (agentId) {
        // Agent-specific mode - get feedback for specific agent and user
        response =
          await api.admin.agents[agentId]["user-feedback"][userId].$get()
      } else {
        throw new Error(
          "Either agentId must be provided or isAdminMode must be true",
        )
      }

      if (!response.ok) {
        throw new Error("Failed to fetch feedback messages")
      }

      const result = await response.json()

      if (result.success) {
        setFeedbackMessages(result.data || [])
      } else {
        setError(result.message || "Failed to fetch feedback messages")
      }
    } catch (err) {
      console.error("Error fetching feedback messages:", err)
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  const handleShareChatClick = (shareToken: string) => {
    const shareUrl = `${window.location.origin}/chat?shareToken=${shareToken}`
    window.open(shareUrl, "_blank")
  }

  if (!isOpen) return null

  // Filter messages based on agents only toggle and search query
  const filteredMessages = feedbackMessages.filter((message) => {
    // Filter by agents only if enabled
    if (
      showAgentsOnly &&
      (!message.agentName || message.agentName.trim() === "")
    ) {
      return false
    }

    // Filter by search query if provided
    if (searchQuery.trim() !== "") {
      const query = searchQuery.toLowerCase()
      const matchesAgentName =
        message.agentName?.toLowerCase().includes(query) || false
      const matchesFeedbackText = message.feedbackText.some((text) =>
        text.toLowerCase().includes(query),
      )
      const matchesMessageContent = message.messageContent
        .toLowerCase()
        .includes(query)
      return matchesAgentName || matchesFeedbackText || matchesMessageContent
    }

    return true
  })

  const modalContent = (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={(e) => {
        // Close modal when clicking on backdrop
        if (e.target === e.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="bg-background border rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col relative">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 text-sm font-bold text-white bg-gradient-to-br from-blue-500 to-purple-600 rounded-full">
              <User className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">
                {isAdminMode ? "User Feedback" : "Feedback Messages"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {isAdminMode
                  ? `All feedback from ${userName} (${userEmail})`
                  : `${userName} (${userEmail})`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Filter button - only show in admin mode */}
            {isAdminMode && (
              <button
                onClick={() => setShowAgentsOnly(!showAgentsOnly)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  showAgentsOnly
                    ? "bg-blue-500 text-white"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                Agents Only
              </button>
            )}
            <button
              onClick={onClose}
              className="flex items-center justify-center w-8 h-8 text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6">
          {/* Search Input - Always visible when not loading/error */}
          {!loading && !error && (
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <input
                type="text"
                placeholder="Search feedback messages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 text-sm border border-input bg-background rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="text-muted-foreground">
                Loading feedback messages...
              </div>
            </div>
          ) : error ? (
            <div className="text-center py-12">
              <MessageCircle className="h-12 w-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
              <p className="text-sm text-muted-foreground mb-4">{error}</p>
              <button
                onClick={fetchFeedbackMessages}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
              >
                Try Again
              </button>
            </div>
          ) : feedbackMessages.length === 0 ? (
            <div className="text-center py-12">
              <MessageCircle className="h-12 w-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
              <h3 className="text-lg font-medium mb-2">No Feedback Messages</h3>
              <p className="text-sm text-muted-foreground">
                This user hasn't provided any feedback yet.
              </p>
            </div>
          ) : filteredMessages.length === 0 ? (
            <div className="text-center py-12">
              <MessageCircle className="h-12 w-12 mx-auto mb-4 opacity-50 text-muted-foreground" />
              <h3 className="text-lg font-medium mb-2">No Results Found</h3>
              <p className="text-sm text-muted-foreground">
                {showAgentsOnly
                  ? "No agent feedback matches your search."
                  : "No feedback messages match your current search."}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between mb-6">
                <div className="text-sm text-muted-foreground">
                  {filteredMessages.length} feedback message
                  {filteredMessages.length !== 1 ? "s" : ""}
                  {showAgentsOnly && " (agents only)"}
                  {searchQuery.trim() !== "" && " (filtered)"}
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <div className="flex items-center gap-1 text-green-600">
                    <ThumbsUp className="h-4 w-4" />
                    <span>
                      {
                        filteredMessages.filter((msg) => msg.type === "like")
                          .length
                      }
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-red-600">
                    <ThumbsDown className="h-4 w-4" />
                    <span>
                      {
                        filteredMessages.filter((msg) => msg.type === "dislike")
                          .length
                      }
                    </span>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                {filteredMessages.map((message, index) => (
                  <div
                    key={`${message.messageId}-${index}`}
                    className="border rounded-lg p-4 bg-card hover:bg-muted/20 transition-colors"
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        {message.type === "like" ? (
                          <ThumbsUp className="h-5 w-5 text-green-600" />
                        ) : (
                          <ThumbsDown className="h-5 w-5 text-red-600" />
                        )}

                        {/* Show agent info in admin mode only if there's actually an agent */}
                        {isAdminMode && message.agentName && (
                          <span className="text-sm text-gray-600">
                            {message.agentName}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3" />
                        {new Date(message.timestamp).toLocaleDateString(
                          "en-US",
                          {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </div>
                    </div>

                    {/* User's Original Message */}
                    {message.messageContent && (
                      <div className="mb-3">
                        <div className="text-sm font-medium mb-2">
                          User Query:
                        </div>
                        <div className="text-sm text-foreground bg-blue-50 dark:bg-blue-900/20 border-l-4 border-blue-500 rounded p-3">
                          <MessageContent
                            content={message.messageContent}
                            className="[&_.reference-pill]:bg-blue-100 [&_.reference-pill]:dark:bg-blue-800/50 [&_.reference-pill]:text-blue-700 [&_.reference-pill]:dark:text-blue-300"
                          />
                        </div>
                      </div>
                    )}

                    {message.feedbackText &&
                      message.feedbackText.length > 0 && (
                        <div className="mb-3">
                          <div className="text-sm font-medium mb-2">
                            Feedback:
                          </div>
                          <div className="space-y-1">
                            {message.feedbackText
                              .filter((text) => text && text.trim())
                              .map((text, idx) => (
                                <div
                                  key={idx}
                                  className="text-sm text-muted-foreground bg-muted/50 rounded p-2"
                                >
                                  {text}
                                </div>
                              ))}
                          </div>
                        </div>
                      )}

                    <div className="flex items-center justify-end">
                      {message.shareToken && (
                        <button
                          onClick={() =>
                            handleShareChatClick(message.shareToken!)
                          }
                          className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-500 text-white rounded-md hover:bg-blue-600 transition-colors"
                        >
                          <ExternalLink className="h-3 w-3" />
                          View Shared Chat
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  // Use createPortal to render the modal at document.body level
  return createPortal(modalContent, document.body)
}
