import { useState, useEffect, useRef, type KeyboardEvent } from "react"
import { Phone, Video, Send, Loader2, Check } from "lucide-react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { callNotificationClient } from "@/services/callNotifications"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface Message {
  id: number
  messageContent: string
  isRead: boolean
  createdAt: string
  sentByUserId: string
  isMine: boolean
  sender: User
}

interface ChatViewProps {
  targetUser: User
  onInitiateCall: (userId: string, callType: "audio" | "video") => void
}

const MAX_MESSAGE_LENGTH = 10000

export default function ChatView({
  targetUser,
  onInitiateCall,
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [messageText, setMessageText] = useState("")
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const isTypingRef = useRef(false)

  // Scroll to bottom when messages change
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, isOtherUserTyping])

  // Fetch conversation history
  const fetchConversation = async () => {
    setLoading(true)
    try {
      const response = await api.messages.conversation.$get({
        query: { targetUserId: targetUser.id },
      })

      if (response.ok) {
        const data = await response.json()
        setMessages(data.messages || [])

        // Mark messages as read
        await markMessagesAsRead()
      } else {
        console.error("Failed to fetch conversation")
        toast({
          title: "Error",
          description: "Failed to load conversation",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to fetch conversation:", error)
      toast({
        title: "Error",
        description: "Failed to load conversation",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Mark messages as read
  const markMessagesAsRead = async () => {
    try {
      await api.messages["mark-read"].$post({
        json: { targetUserId: targetUser.id },
      })
    } catch (error) {
      console.error("Failed to mark messages as read:", error)
    }
  }

  // Send typing indicator
  const handleTypingIndicator = (isTyping: boolean) => {
    callNotificationClient.sendTypingIndicator(targetUser.id, isTyping)
    isTypingRef.current = isTyping
  }

  // Handle input change with typing indicator and auto-resize
  const handleMessageChange = (text: string) => {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      setMessageText(text)

      // Auto-resize textarea
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto"
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
      }

      // Send typing indicator when user starts typing or resumes typing
      if (text.length > 0 && !isTypingRef.current) {
        handleTypingIndicator(true)
      }

      // Clear existing timeout
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }

      // Set timeout to send "stopped typing" after 2 seconds of inactivity
      if (text.length > 0) {
        typingTimeoutRef.current = setTimeout(() => {
          handleTypingIndicator(false)
        }, 2000)
      } else {
        // If text is cleared, immediately send "stopped typing"
        handleTypingIndicator(false)
      }
    }
  }

  // Send a message
  const sendMessage = async () => {
    if (!messageText.trim() || sending) return

    if (messageText.length > MAX_MESSAGE_LENGTH) {
      toast({
        title: "Message too long",
        description: `Message cannot exceed ${MAX_MESSAGE_LENGTH} characters`,
        variant: "destructive",
      })
      return
    }

    // Clear typing indicator when sending message
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current)
    }
    handleTypingIndicator(false)

    setSending(true)
    try {
      const response = await api.messages.send.$post({
        json: {
          targetUserId: targetUser.id,
          messageContent: messageText.trim(),
        },
      })

      if (response.ok) {
        const data = await response.json()
        // Add the new message to the list
        setMessages((prev) => [
          ...prev,
          {
            id: data.message.id,
            messageContent: data.message.messageContent,
            isRead: data.message.isRead,
            createdAt: data.message.createdAt,
            sentByUserId: data.message.sentByUserId,
            isMine: true,
            sender: data.message.sender,
          },
        ])
        setMessageText("")
        // Reset textarea height
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto"
        }
      } else {
        const errorData = await response.json().catch(() => ({}))
        toast({
          title: "Error",
          description: errorData.message || "Failed to send message",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to send message:", error)
      toast({
        title: "Error",
        description: "Failed to send message",
        variant: "destructive",
      })
    } finally {
      setSending(false)
    }
  }

  // Handle Enter key press
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  // Load conversation on mount
  useEffect(() => {
    fetchConversation()

    // Subscribe to real-time messages
    const unsubscribeMessage = callNotificationClient.onDirectMessage(
      (message) => {
        // Only add message if it's from the target user we're chatting with
        if (message.sender.id === targetUser.id) {
          setMessages((prev) => [
            ...prev,
            {
              id: message.messageId,
              messageContent: message.messageContent,
              isRead: false,
              createdAt: message.createdAt,
              sentByUserId: message.sender.id,
              isMine: false,
              sender: message.sender,
            },
          ])
          // Auto-mark as read since user is viewing the chat
          markMessagesAsRead()
          scrollToBottom()
        }
      },
    )

    // Subscribe to read receipts
    const unsubscribeRead = callNotificationClient.onMessageRead(
      (readStatus) => {
        if (readStatus.readByUserId === targetUser.id) {
          // Mark all messages as read
          setMessages((prev) =>
            prev.map((msg) => (msg.isMine ? { ...msg, isRead: true } : msg)),
          )
        }
      },
    )

    // Subscribe to typing indicators
    const unsubscribeTyping = callNotificationClient.onTypingIndicator(
      (indicator) => {
        // Only show typing indicator if it's from the target user
        if (indicator.userId === targetUser.id) {
          setIsOtherUserTyping(indicator.isTyping)
        }
      },
    )

    return () => {
      unsubscribeMessage()
      unsubscribeRead()
      unsubscribeTyping()

      // Clear typing timeout and send final "stopped typing" when unmounting
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current)
      }
      handleTypingIndicator(false)
    }
  }, [targetUser.id])

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))

    if (days === 0) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    } else if (days === 1) {
      return "Yesterday"
    } else if (days < 7) {
      return date.toLocaleDateString([], { weekday: "short" })
    } else {
      return date.toLocaleDateString([], { month: "short", day: "numeric" })
    }
  }

  return (
    <div className="h-full w-full bg-white dark:bg-[#1E1E1E] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#D7E0E9] dark:border-gray-700">
        <div className="flex items-center gap-3">
          {/* User Avatar */}
          {targetUser.photoLink ? (
            <img
              src={`/api/v1/proxy/${encodeURIComponent(targetUser.photoLink)}`}
              alt={targetUser.name}
              className="w-10 h-10 rounded-full"
            />
          ) : (
            <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                {targetUser.name.charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div>
            <h2 className="text-lg font-semibold text-[#384049] dark:text-[#F1F3F4]">
              {targetUser.name}
            </h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {targetUser.email}
            </p>
          </div>
        </div>

        {/* Call Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onInitiateCall(targetUser.id, "audio")}
            className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
            title="Audio Call"
          >
            <Phone className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onInitiateCall(targetUser.id, "video")}
            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20"
            title="Video Call"
          >
            <Video className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Messages Container */}
      <div
        ref={messageContainerRef}
        className="flex-1 overflow-y-auto px-6 py-4 space-y-4"
      >
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-500 dark:text-gray-400">
              <p className="text-lg font-medium">No messages yet</p>
              <p className="text-sm mt-2">
                Send a message to start the conversation
              </p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.isMine ? "justify-end" : "justify-start",
                )}
              >
                <div
                  className={cn(
                    "max-w-[70%] rounded-2xl px-4 py-2.5 shadow-sm",
                    message.isMine
                      ? "bg-blue-500 text-white rounded-br-sm"
                      : "bg-gray-100 dark:bg-gray-800 text-[#384049] dark:text-[#F1F3F4] rounded-bl-sm",
                  )}
                >
                  <p className="text-sm break-words whitespace-pre-wrap leading-relaxed">
                    {message.messageContent}
                  </p>
                  <div
                    className={cn(
                      "flex items-center gap-1 mt-1.5",
                      message.isMine ? "justify-end" : "justify-start",
                    )}
                  >
                    <p
                      className={cn(
                        "text-[10px]",
                        message.isMine
                          ? "text-blue-50"
                          : "text-gray-500 dark:text-gray-400",
                      )}
                    >
                      {formatTime(message.createdAt)}
                    </p>
                    {/* Read receipt indicators - only for sent messages */}
                    {message.isMine && (
                      <div className="flex items-center">
                        {message.isRead ? (
                          // Double check - message read
                          <div className="flex -space-x-1">
                            <Check className="h-3.5 w-3.5 text-blue-50" />
                            <Check className="h-3.5 w-3.5 text-blue-50" />
                          </div>
                        ) : (
                          // Single check - message sent but not read
                          <Check className="h-3.5 w-3.5 text-blue-50 opacity-60" />
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {/* Typing Indicator */}
            {isOtherUserTyping && (
              <div className="flex justify-start">
                <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1 shadow-sm">
                  <span
                    className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: "0ms" }}
                  ></span>
                  <span
                    className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: "150ms" }}
                  ></span>
                  <span
                    className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"
                    style={{ animationDelay: "300ms" }}
                  ></span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Message Input */}
      <div className="px-6 py-4 border-t border-[#D7E0E9] dark:border-gray-700">
        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <div className="relative">
              <Textarea
                ref={textareaRef}
                value={messageText}
                onChange={(e) => {
                  handleMessageChange(e.target.value)
                }}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${targetUser.name}...`}
                className="resize-none min-h-[80px] max-h-[200px] overflow-y-auto pr-16 py-3 rounded-xl border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 focus:border-transparent transition-all"
                rows={1}
                disabled={sending}
              />
              {messageText.length > 0 && (
                <div
                  className={cn(
                    "absolute bottom-2 right-3 text-xs pointer-events-none",
                    messageText.length >= MAX_MESSAGE_LENGTH
                      ? "text-red-500 font-medium"
                      : messageText.length >= MAX_MESSAGE_LENGTH * 0.9
                        ? "text-orange-500"
                        : "text-gray-400",
                  )}
                >
                  {messageText.length} / {MAX_MESSAGE_LENGTH}
                </div>
              )}
            </div>
          </div>
          <Button
            onClick={sendMessage}
            disabled={
              !messageText.trim() ||
              sending ||
              messageText.length > MAX_MESSAGE_LENGTH
            }
            size="icon"
            className="h-11 w-11 rounded-full bg-blue-600 hover:bg-blue-700 text-white shadow-md hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
          >
            {sending ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <Send className="h-5 w-5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
