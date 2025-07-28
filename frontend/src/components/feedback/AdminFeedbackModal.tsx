import React, { useState, useEffect } from "react"
import { createPortal } from "react-dom"
import {
  X,
  MessageCircle,
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  Calendar,
  Bot,
} from "lucide-react"
import { api } from "@/api"

interface AdminFeedbackMessage {
  messageId: string
  chatExternalId: string
  agentId: string
  agentName: string
  type: "like" | "dislike"
  feedbackText: string[]
  timestamp: string
  shareToken?: string
}

interface AdminFeedbackModalProps {
  isOpen: boolean
  onClose: () => void
  userId: number
  userName: string
  userEmail: string
}

export const AdminFeedbackModal: React.FC<AdminFeedbackModalProps> = ({
  isOpen,
  onClose,
  userId,
  userName,
  userEmail,
}) => {
  const [feedbackMessages, setFeedbackMessages] = useState<
    AdminFeedbackMessage[]
  >([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen && userId) {
      fetchFeedbackMessages()
    }
  }, [isOpen, userId])

  // Handle escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscape)
      return () => document.removeEventListener("keydown", handleEscape)
    }
  }, [isOpen, onClose])

  const fetchFeedbackMessages = async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await api.admin.users[userId].feedback.$get()

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
    const shareUrl = `/chat?shareToken=${shareToken}`
    window.open(shareUrl, "_blank")
  }

  const formatTimestamp = (timestamp: string) => {
    return new Date(timestamp).toLocaleString()
  }

  if (!isOpen) return null

  const modalContent = (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] overflow-hidden mx-4">
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MessageCircle className="h-5 w-5 text-blue-600" />
            <div>
              <h2 className="text-lg font-semibold">User Feedback</h2>
              <p className="text-sm text-gray-600">
                All feedback from {userName} ({userEmail})
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto max-h-[calc(80vh-120px)]">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="text-gray-500">Loading feedback messages...</div>
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <div className="text-red-600 mb-2">Error loading feedback</div>
              <div className="text-sm text-gray-600">{error}</div>
              <button
                onClick={fetchFeedbackMessages}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : feedbackMessages.length === 0 ? (
            <div className="text-center py-8">
              <MessageCircle className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <div className="text-gray-500 mb-2">
                No feedback messages found
              </div>
              <div className="text-sm text-gray-400">
                This user hasn't provided any feedback yet.
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {feedbackMessages.map((message, index) => (
                <div
                  key={index}
                  className="border rounded-lg p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      {/* Feedback Type and Agent */}
                      <div className="flex items-center gap-3 mb-2">
                        <div
                          className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${
                            message.type === "like"
                              ? "bg-green-100 text-green-700"
                              : "bg-red-100 text-red-700"
                          }`}
                        >
                          {message.type === "like" ? (
                            <ThumbsUp className="h-3 w-3" />
                          ) : (
                            <ThumbsDown className="h-3 w-3" />
                          )}
                          {message.type === "like" ? "Liked" : "Disliked"}
                        </div>

                        <div className="flex items-center gap-1 text-sm text-gray-600">
                          <Bot className="h-3 w-3" />
                          <span className="font-medium">
                            {message.agentName}
                          </span>
                        </div>
                      </div>

                      {/* Feedback Text */}
                      {message.feedbackText &&
                        message.feedbackText.length > 0 && (
                          <div className="mb-3">
                            <div className="text-sm font-medium text-gray-700 mb-1">
                              Feedback:
                            </div>
                            <div className="space-y-1">
                              {message.feedbackText.map((text, textIndex) => (
                                <div
                                  key={textIndex}
                                  className="text-sm text-gray-600 bg-gray-50 rounded px-3 py-2"
                                >
                                  {text}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      {/* Timestamp */}
                      <div className="flex items-center gap-1 text-xs text-gray-500">
                        <Calendar className="h-3 w-3" />
                        {formatTimestamp(message.timestamp)}
                      </div>
                    </div>

                    {/* Share Chat Button */}
                    {message.shareToken && (
                      <button
                        onClick={() =>
                          handleShareChatClick(message.shareToken!)
                        }
                        className="flex items-center gap-2 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                      >
                        <ExternalLink className="h-4 w-4" />
                        View Chat
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(modalContent, document.body)
}
