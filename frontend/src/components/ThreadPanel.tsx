import { useEffect, useState, useRef } from "react"
import { X, MessageSquare } from "lucide-react"
import { Button } from "@/components/ui/button"
import BuzzChatBox from "./BuzzChatBox"
import { callNotificationClient } from "@/services/callNotifications"
import { RenderLexicalContent } from "./RenderLexicalContent"
import { api } from "@/api"
import type { LexicalEditorState, CallType } from "@/types"
import { formatTime } from "@/utils/messageHelpers"

interface ThreadMessage {
  id: number
  senderId: string
  senderName: string
  senderPhoto?: string
  messageContent: LexicalEditorState
  createdAt: string
  isEdited?: boolean
}

interface ParentMessage {
  id: number
  senderId: string
  senderName: string
  senderPhoto?: string
  messageContent: LexicalEditorState
  createdAt: string
  messageType: "direct" | "channel"
}

interface ThreadPanelProps {
  parentMessage: ParentMessage
  currentUserId: string
  onClose: () => void
  onMentionMessage?: (userId: string) => void
  onMentionCall?: (userId: string, callType: CallType) => void
  onReplyAdded?: (parentMessageId: number) => void
}

export default function ThreadPanel({
  parentMessage,
  currentUserId,
  onClose,
  onMentionMessage,
  onMentionCall,
  onReplyAdded,
}: ThreadPanelProps) {
  const [replies, setReplies] = useState<ThreadMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  // Fetch thread replies
  const fetchReplies = async () => {
    setLoading(true)
    try {
      const response = await api.threads[":messageId"].$get({
        param: {
          messageId: parentMessage.id.toString(),
        },
        query: {
          messageType: parentMessage.messageType,
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error("Thread fetch error response:", errorText)
        throw new Error(
          `Failed to fetch thread: ${response.status} ${errorText}`,
        )
      }

      const data = await response.json()

      // Map backend response to frontend format
      const mappedReplies: ThreadMessage[] = data.replies.map((reply: any) => ({
        id: reply.id,
        senderId: reply.sender.externalId,
        senderName: reply.sender.name,
        senderPhoto: reply.sender.photoLink || undefined,
        messageContent: reply.messageContent,
        createdAt: reply.createdAt,
        isEdited: reply.isEdited,
      }))

      setReplies(mappedReplies)
    } catch (error) {
      console.error("Failed to fetch thread replies:", error)
    } finally {
      setLoading(false)
    }
  }

  // Send reply
  const handleSendReply = async (content: LexicalEditorState) => {
    setSending(true)
    try {
      const response = await api.threads[":messageId"].reply.$post({
        param: {
          messageId: parentMessage.id.toString(),
        },
        json: {
          messageType: parentMessage.messageType,
          messageContent: content,
        },
      })

      if (!response.ok) {
        const errorText = await response.text()
        console.error("Send reply error response:", errorText)
        throw new Error(`Failed to send reply: ${response.status} ${errorText}`)
      }

      const data = await response.json()

      // Map the new reply
      const newReply: ThreadMessage = {
        id: data.reply.id,
        senderId: data.reply.sender.externalId,
        senderName: data.reply.sender.name,
        senderPhoto: data.reply.sender.photoLink || undefined,
        messageContent: data.reply.messageContent,
        createdAt: data.reply.createdAt,
        isEdited: data.reply.isEdited || false,
      }

      setReplies((prev) => [...prev, newReply])
      scrollToBottom()

      // Notify parent component that a reply was added
      if (onReplyAdded) {
        onReplyAdded(parentMessage.id)
      }
    } catch (error) {
      console.error("Failed to send reply:", error)
    } finally {
      setSending(false)
    }
  }

  useEffect(() => {
    fetchReplies()
  }, [parentMessage.id])

  useEffect(() => {
    if (replies.length > 0) {
      scrollToBottom()
    }
  }, [replies])

  // Listen for real-time thread replies
  useEffect(() => {
    const unsubscribe = callNotificationClient.onThreadReply((data) => {
      // Only add reply if it's for this thread
      if (
        data.parentMessageId === parentMessage.id &&
        data.messageType === parentMessage.messageType
      ) {
        const newReply: ThreadMessage = {
          id: data.reply.id,
          senderId: data.reply.sender.externalId,
          senderName: data.reply.sender.name,
          senderPhoto: data.reply.sender.photoLink || undefined,
          messageContent: data.reply.messageContent,
          createdAt: data.reply.createdAt,
          isEdited: data.reply.isEdited,
        }

        // Avoid duplicates
        setReplies((prev) => {
          if (prev.some((r) => r.id === newReply.id)) {
            return prev
          }
          return [...prev, newReply]
        })
      }
    })

    return () => {
      unsubscribe()
    }
  }, [parentMessage.id, parentMessage.messageType])

  return (
    <div className="fixed right-0 top-0 bottom-0 w-[500px] bg-white dark:bg-[#1E1E1E] border-l border-gray-200 dark:border-gray-700 flex flex-col z-50 shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-gray-600 dark:text-gray-400" />
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Thread
          </h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-8 w-8 p-0"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Parent Message */}
      <div className="px-6 py-4">
        <div className="flex gap-3">
          {/* Avatar */}
          <div className="flex-shrink-0">
            {parentMessage.senderPhoto ? (
              <img
                src={`/api/v1/proxy/${encodeURIComponent(parentMessage.senderPhoto)}`}
                alt={parentMessage.senderName}
                className="w-9 h-9 rounded-md"
              />
            ) : (
              <div className="w-9 h-9 rounded-md bg-gray-300 dark:bg-gray-700 flex items-center justify-center">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {parentMessage.senderName.charAt(0).toUpperCase()}
                </span>
              </div>
            )}
          </div>

          {/* Message Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="font-semibold text-[15px] text-gray-900 dark:text-gray-100">
                {parentMessage.senderName}
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400">
                {formatTime(parentMessage.createdAt)}
              </span>
            </div>
            <div className="text-[15px] text-gray-800 dark:text-gray-200 break-words leading-[22px]">
              <RenderLexicalContent
                content={parentMessage.messageContent}
                onMentionMessage={onMentionMessage}
                onMentionCall={onMentionCall}
                currentUserId={currentUserId}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Reply count with line */}
      <div className="px-6 py-4 flex items-center gap-3">
        <span className="text-[13px] font-semibold text-gray-900 dark:text-gray-100 whitespace-nowrap">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </span>
        <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700"></div>
      </div>

      {/* Thread Messages */}
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-gray-500">Loading replies...</div>
          </div>
        ) : replies.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <MessageSquare className="h-12 w-12 text-gray-300 dark:text-gray-600 mb-3" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No replies yet
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
              Be the first to reply!
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {replies.map((reply) => (
              <div
                key={reply.id}
                className="flex gap-3 hover:bg-gray-50 dark:hover:bg-gray-800/30 -mx-2 px-2 py-1 rounded transition-colors"
              >
                {/* Avatar */}
                <div className="flex-shrink-0">
                  {reply.senderPhoto ? (
                    <img
                      src={`/api/v1/proxy/${encodeURIComponent(reply.senderPhoto)}`}
                      alt={reply.senderName}
                      className="w-9 h-9 rounded-md"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-md bg-gray-300 dark:bg-gray-700 flex items-center justify-center">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {reply.senderName.charAt(0).toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>

                {/* Message */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="font-semibold text-[15px] text-gray-900 dark:text-gray-100">
                      {reply.senderName}
                    </span>
                    <span className="text-[11px] text-gray-500 dark:text-gray-400">
                      {formatTime(reply.createdAt)}
                    </span>
                    {reply.isEdited && (
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">
                        (edited)
                      </span>
                    )}
                  </div>
                  <div className="text-[15px] text-gray-800 dark:text-gray-200 break-words leading-[22px]">
                    <RenderLexicalContent
                      content={reply.messageContent}
                      onMentionMessage={onMentionMessage}
                      onMentionCall={onMentionCall}
                      currentUserId={currentUserId}
                    />
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Reply Input */}
      <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
        <BuzzChatBox
          onSend={handleSendReply}
          placeholder="Reply..."
          disabled={sending}
        />
      </div>
    </div>
  )
}
