import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  ThumbsUp,
  ThumbsDown,
  ExternalLink,
  MessageSquare,
  User,
  Clock,
} from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface FeedbackMessage {
  messageId: string
  chatExternalId: string
  userEmail: string
  userName: string
  type: "like" | "dislike"
  feedbackText: string[]
  timestamp: string
  shareToken?: string | null
}

interface FeedbackMessagesModalProps {
  isOpen: boolean
  onClose: () => void
  agentId: string
  agentName: string
}

export function FeedbackMessagesModal({
  isOpen,
  onClose,
  agentId,
  agentName,
}: FeedbackMessagesModalProps) {
  const [feedbackMessages, setFeedbackMessages] = useState<FeedbackMessage[]>(
    [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchFeedbackMessages = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/admin/agents/${agentId}/feedback`, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("authToken")}`,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to fetch feedback messages")
      }

      const data = await response.json()

      if (data.success) {
        setFeedbackMessages(data.data)
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
    if (isOpen && agentId) {
      fetchFeedbackMessages()
    }
  }, [isOpen, agentId])

  const handleViewSharedChat = (shareToken: string) => {
    const shareUrl = `/share/${shareToken}`
    window.open(shareUrl, "_blank")
  }

  return (
    <Dialog open={isOpen} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5" />
            Feedback for {agentName}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <p className="text-red-600">{error}</p>
              <Button
                onClick={fetchFeedbackMessages}
                variant="outline"
                className="mt-2"
              >
                Try Again
              </Button>
            </div>
          )}

          {!loading && !error && feedbackMessages.length === 0 && (
            <div className="text-center py-8 text-muted-foreground">
              No feedback messages found for this agent.
            </div>
          )}

          {!loading && !error && feedbackMessages.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {feedbackMessages.length} feedback message
                  {feedbackMessages.length === 1 ? "" : "s"} found
                </p>
              </div>

              {feedbackMessages.map((feedback) => (
                <div
                  key={feedback.messageId}
                  className="border rounded-lg p-4 space-y-3 hover:bg-muted/20 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2">
                        {feedback.type === "like" ? (
                          <ThumbsUp className="w-4 h-4 text-green-600" />
                        ) : (
                          <ThumbsDown className="w-4 h-4 text-red-600" />
                        )}
                        <Badge
                          variant={
                            feedback.type === "like" ? "default" : "destructive"
                          }
                          className="text-xs"
                        >
                          {feedback.type}
                        </Badge>
                      </div>

                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <User className="w-3 h-3" />
                        <span>{feedback.userName || feedback.userEmail}</span>
                      </div>

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

                  <div className="text-xs text-muted-foreground border-t pt-2">
                    Chat ID: {feedback.chatExternalId} • Message ID:{" "}
                    {feedback.messageId}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
