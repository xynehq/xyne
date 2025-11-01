import { useState, useEffect, useRef } from "react"
import {
  Phone,
  Video,
  Loader2,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmModal } from "@/components/ui/confirmModal"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import { callNotificationClient } from "@/services/callNotifications"
import { CallType, LexicalEditorState } from "@/types"
import BuzzChatBox from "@/components/BuzzChatBox"
import { MentionPill } from "@/components/MentionPill"
import {
  formatDateSeparator,
  shouldShowDateSeparator,
  shouldShowHeader,
  isContentEqual,
} from "@/utils/messageHelpers"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface Message {
  id: number
  messageContent: LexicalEditorState
  isRead: boolean
  isEdited?: boolean
  createdAt: string
  sentByUserId: string
  isMine: boolean
  sender: User
}

interface ChatViewProps {
  targetUser: User
  currentUser: User
  onInitiateCall: (userId: string, callType: CallType) => void
  onSwitchToUser?: (userId: string) => void
}

const MAX_MESSAGE_LENGTH = 10000

// Component to render Lexical JSON content
function RenderLexicalContent({
  content,
  onMentionMessage,
  onMentionCall,
  currentUserId,
}: {
  content: LexicalEditorState
  onMentionMessage?: (userId: string) => void
  onMentionCall?: (userId: string, callType: CallType) => void
  currentUserId?: string
}) {
  const renderNode = (node: any, index: number): React.ReactNode => {
    // Text node
    if (node.type === "text") {
      let text = node.text || ""
      let element: React.ReactNode = text

      // Apply formatting
      if (node.format) {
        const format = typeof node.format === "number" ? node.format : 0
        // Format bits: 1 = bold, 2 = italic, 4 = strikethrough, 8 = underline, 16 = code
        if (format & 1) element = <strong key={index}>{element}</strong>
        if (format & 2) element = <em key={index}>{element}</em>
        if (format & 16)
          element = (
            <code
              key={index}
              className="text-orange-600 dark:text-orange-400 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded font-mono text-xs"
            >
              {element}
            </code>
          )
      }

      return element
    }

    // Mention node
    if (node.type === "mention" && node.mentionUser) {
      return (
        <MentionPill
          key={index}
          user={node.mentionUser}
          onMessage={onMentionMessage}
          onCall={onMentionCall}
          currentUserId={currentUserId}
        />
      )
    }

    // Link node
    if (node.type === "link") {
      return (
        <a
          key={index}
          href={node.url || "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 underline hover:text-blue-700"
        >
          {node.children?.map(renderNode)}
        </a>
      )
    }

    // List node
    if (node.type === "list") {
      const ListTag = node.listType === "number" ? "ol" : "ul"
      return (
        <ListTag
          key={index}
          className={
            node.listType === "number"
              ? "list-decimal list-inside"
              : "list-disc list-inside"
          }
        >
          {node.children?.map(renderNode)}
        </ListTag>
      )
    }

    // List item node
    if (node.type === "listitem") {
      return <li key={index}>{node.children?.map(renderNode)}</li>
    }

    // Paragraph node
    if (node.type === "paragraph") {
      return (
        <div key={index} className="paragraph">
          {node.children?.map(renderNode)}
        </div>
      )
    }

    // Heading node
    if (node.type === "heading") {
      const tag = node.tag || "h1"
      const HeadingTag = tag as keyof JSX.IntrinsicElements
      const headingClasses: Record<string, string> = {
        h1: "text-2xl font-bold",
        h2: "text-xl font-bold",
        h3: "text-lg font-bold",
        h4: "text-base font-bold",
        h5: "text-sm font-bold",
        h6: "text-xs font-bold",
      }
      return (
        <HeadingTag key={index} className={headingClasses[tag] || ""}>
          {node.children?.map(renderNode)}
        </HeadingTag>
      )
    }

    // Quote node
    if (node.type === "quote") {
      return (
        <blockquote
          key={index}
          className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic text-gray-700 dark:text-gray-300"
        >
          {node.children?.map(renderNode)}
        </blockquote>
      )
    }

    // Default: render children if they exist
    if (node.children && Array.isArray(node.children)) {
      return <span key={index}>{node.children.map(renderNode)}</span>
    }

    return null
  }

  return (
    <div className="space-y-1">
      {content.root.children.map((node, i) => renderNode(node, i))}
    </div>
  )
}

export default function ChatView({
  targetUser,
  currentUser,
  onInitiateCall,
  onSwitchToUser,
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sending, setSending] = useState(false)
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false)
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null)
  const [editingContent, setEditingContent] =
    useState<LexicalEditorState | null>(null)
  const [nextCursor, setNextCursor] = useState<string>("")
  const [hasMore, setHasMore] = useState(false)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [deleteConfirmModal, setDeleteConfirmModal] = useState({
    open: false,
    title: "",
    description: "",
    messageId: null as number | null,
  })
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null)

  // Handle mention message action
  const handleMentionMessage = async (userId: string) => {
    // If clicking on the current chat user, don't do anything
    if (userId === targetUser.id) {
      toast({
        title: "Info",
        description: "You are already chatting with this user",
      })
      return
    }

    // Call the parent callback to switch user
    if (onSwitchToUser) {
      onSwitchToUser(userId)
    } else {
      // Fallback: show toast
      toast({
        title: "Info",
        description: "Message feature requires navigation support",
      })
    }
  }

  // Handle mention call action
  const handleMentionCall = (userId: string, callType: CallType) => {
    onInitiateCall(userId, callType)
  }

  // Scroll to bottom naturally by setting scrollTop to scrollHeight
  // This is the Slack approach - no animation, just position at bottom
  const scrollToBottom = () => {
    const container = messageContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }

  // Initial load: position at bottom (Slack's CSS-first approach)
  useEffect(() => {
    if (isInitialLoad && messages.length > 0 && messageContainerRef.current) {
      // Use requestAnimationFrame to ensure DOM is fully rendered
      requestAnimationFrame(() => {
        scrollToBottom()
        setIsInitialLoad(false)
      })
    }
  }, [messages, isInitialLoad])

  // Auto-scroll to bottom when new messages arrive or typing indicator appears
  // But only if user is already near the bottom (to respect user's scroll position)
  useEffect(() => {
    const container = messageContainerRef.current
    if (!container || loadingMore || isInitialLoad) return

    // Check if user is scrolled near the bottom (within 100px)
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      100

    if (isNearBottom) {
      // User is at bottom, keep them there when new content arrives
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    }
  }, [messages.length, isOtherUserTyping, loadingMore, isInitialLoad])

  // Infinite scroll: Automatically load more messages when scrolling near top
  useEffect(() => {
    const trigger = loadMoreTriggerRef.current
    const container = messageContainerRef.current

    if (!trigger || !container || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        // When the trigger element is visible and we have more messages, load them
        if (entry.isIntersecting && hasMore && !loadingMore && !loading) {
          loadMoreMessages()
        }
      },
      {
        root: container,
        rootMargin: "200px", // Start loading 200px before reaching the trigger for smoother UX
        threshold: 0,
      },
    )

    observer.observe(trigger)

    return () => {
      observer.disconnect()
    }
  }, [hasMore, loadingMore, loading, nextCursor])

  /**
   * Cursor-based pagination with infinite scroll (Slack-style)
   * - Initial load fetches most recent 100 messages (newest first, then reversed for display)
   * - IntersectionObserver detects when user scrolls near the top
   * - Automatically fetches older messages and prepends them smoothly
   * - Uses requestAnimationFrame to maintain scroll position during load
   * - nextCursor is a base64-encoded message ID for pagination
   * - Empty cursor means no more older messages to load
   * - Loading indicator shown while fetching more messages
   */

  // Fetch conversation history (initial load)
  const fetchConversation = async () => {
    setLoading(true)
    setIsInitialLoad(true)
    try {
      console.log(
        "[ChatView] Fetching initial conversation for user:",
        targetUser.id,
      )

      const response = await api.messages.conversation.$get({
        query: {
          targetUserId: targetUser.id,
          limit: "50",
        },
      })

      if (response.ok) {
        const data = await response.json()
        console.log("[ChatView] Initial load response:", {
          messageCount: data.messages?.length || 0,
          hasMore: data.responseMetadata?.hasMore,
          nextCursor: data.responseMetadata?.nextCursor,
          firstMessageId: data.messages?.[0]?.id,
          lastMessageId: data.messages?.[data.messages?.length - 1]?.id,
        })

        setMessages(data.messages || [])
        setNextCursor(data.responseMetadata?.nextCursor || "")
        setHasMore(data.responseMetadata?.hasMore || false)
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

  // Load more messages (infinite scroll)
  const loadMoreMessages = async () => {
    if (!hasMore || loadingMore || !nextCursor || loading) return

    console.log("[ChatView] Loading more messages with cursor:", nextCursor)

    // Save current scroll position and first message to maintain smooth scroll
    const container = messageContainerRef.current
    if (!container) return

    const scrollHeightBefore = container.scrollHeight
    const scrollTopBefore = container.scrollTop

    setLoadingMore(true)
    try {
      const response = await api.messages.conversation.$get({
        query: {
          targetUserId: targetUser.id,
          limit: "50", // Send limit as string in query parameter
          cursor: nextCursor,
        },
      })

      if (response.ok) {
        const data = await response.json()

        console.log("[ChatView] Load more response:", {
          messageCount: data.messages?.length || 0,
          hasMore: data.responseMetadata?.hasMore,
          nextCursor: data.responseMetadata?.nextCursor,
          firstMessageId: data.messages?.[0]?.id,
          lastMessageId: data.messages?.[data.messages?.length - 1]?.id,
        })

        // Prepend older messages to the beginning of the list
        setMessages((prev) => [...(data.messages || []), ...prev])
        setNextCursor(data.responseMetadata?.nextCursor || "")
        setHasMore(data.responseMetadata?.hasMore || false)

        // Use requestAnimationFrame for smooth scroll position restoration
        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight
            const scrollDiff = scrollHeightAfter - scrollHeightBefore
            // Maintain the user's view position
            container.scrollTop = scrollTopBefore + scrollDiff
          }
        })
      } else {
        console.error("Failed to load more messages")
        toast({
          title: "Error",
          description: "Failed to load more messages",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to load more messages:", error)
      toast({
        title: "Error",
        description: "Failed to load more messages",
        variant: "destructive",
      })
    } finally {
      setLoadingMore(false)
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

  // Handle edit message
  const handleEditMessage = async (
    messageId: number,
    newContent: LexicalEditorState,
  ) => {
    // Check if content has actually changed
    if (editingContent && isContentEqual(editingContent, newContent)) {
      // Content is the same, just cancel editing without any API call or state update
      setEditingMessageId(null)
      setEditingContent(null)
      return
    }

    try {
      const response = await api.messages.edit.$put({
        json: {
          messageId,
          messageContent: newContent,
        },
      })

      if (response.ok) {
        const data = await response.json()
        // Update the message in the local state
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId
              ? {
                  ...msg,
                  messageContent: data.message.messageContent,
                  isEdited: data.message.isEdited,
                }
              : msg,
          ),
        )
        setEditingMessageId(null)
        setEditingContent(null)
        // Removed success toast - edit is silent when successful
      } else {
        throw new Error("Failed to edit message")
      }
    } catch (error) {
      console.error("Error editing message:", error)
      toast({
        title: "Error",
        description: "Failed to edit message",
        variant: "destructive",
      })
    }
  }

  // Handle delete message
  const handleDeleteMessage = async (messageId: number) => {
    try {
      const response = await api.messages.delete.$delete({
        json: { messageId },
      })

      if (response.ok) {
        // Remove the message from the local state
        setMessages((prev) => prev.filter((msg) => msg.id !== messageId))
        toast({
          title: "Success",
          description: "Message deleted successfully",
        })
      } else {
        throw new Error("Failed to delete message")
      }
    } catch (error) {
      console.error("Error deleting message:", error)
      toast({
        title: "Error",
        description: "Failed to delete message",
        variant: "destructive",
      })
    }
  }

  // Show delete confirmation
  const showDeleteConfirmation = (messageId: number) => {
    setDeleteConfirmModal({
      open: true,
      title: "Delete Message",
      description:
        "Are you sure you want to delete this message? This action cannot be undone.",
      messageId,
    })
  }

  // Handle confirmed delete
  const handleConfirmDelete = () => {
    if (deleteConfirmModal.messageId) {
      handleDeleteMessage(deleteConfirmModal.messageId)
    }
    setDeleteConfirmModal({
      open: false,
      title: "",
      description: "",
      messageId: null,
    })
  }

  // Handle cancel delete
  const handleCancelDelete = () => {
    setDeleteConfirmModal({
      open: false,
      title: "",
      description: "",
      messageId: null,
    })
  }

  // Start editing a message
  const startEditingMessage = (message: Message) => {
    setEditingMessageId(message.id)
    setEditingContent(message.messageContent)
  }

  // Cancel editing
  const cancelEditing = () => {
    setEditingMessageId(null)
    setEditingContent(null)
  }

  // Send a message
  // Helper to extract plain text from Lexical JSON
  const extractPlainText = (editorState: LexicalEditorState): string => {
    const extractText = (node: any): string => {
      if (node.type === "text") {
        return node.text || ""
      }
      if (node.type === "mention") {
        // Extract mention as @username
        return `@${node.mentionUser?.name || "unknown"}`
      }
      if (node.children && Array.isArray(node.children)) {
        return node.children.map(extractText).join("")
      }
      return ""
    }

    return editorState.root.children.map(extractText).join("\n")
  }

  const sendMessage = async (editorState: LexicalEditorState) => {
    const plainText = extractPlainText(editorState).trim()
    if (!plainText || sending) return

    if (plainText.length > MAX_MESSAGE_LENGTH) {
      toast({
        title: "Message too long",
        description: `Message must be less than ${MAX_MESSAGE_LENGTH} characters`,
        variant: "destructive",
      })
      return
    }

    setSending(true)
    try {
      const data = await api.messages.send.$post({
        json: {
          targetUserId: targetUser.id,
          messageContent: editorState,
        },
      })

      if (!data.ok) {
        throw new Error("Failed to send message")
      }

      const { message: sentMessage } = await data.json()

      // Add the sent message to the messages list using currentUser info
      setMessages((prev) => [
        ...prev,
        {
          id: sentMessage.id,
          messageContent: sentMessage.messageContent,
          isRead: false,
          createdAt: sentMessage.createdAt,
          sentByUserId: sentMessage.sentByUserId,
          isMine: true,
          sender: currentUser,
        },
      ])

      // Always scroll to bottom after sending (user initiated action)
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    } catch (error) {
      console.error("Error sending message:", error)
      toast({
        title: "Error",
        description: "Failed to send message",
        variant: "destructive",
      })
    } finally {
      setSending(false)
    }
  }

  // Load conversation on mount or when target user changes
  useEffect(() => {
    setIsInitialLoad(true) // Reset initial load flag when switching users
    setMessages([]) // Clear messages when switching users
    setNextCursor("") // Reset pagination cursor
    setHasMore(true) // Reset pagination flag
    fetchConversation()

    // Subscribe to real-time messages
    const unsubscribeMessage = callNotificationClient.onDirectMessage(
      (message) => {
        // Skip WebSocket messages when chatting with yourself (already added optimistically)
        const isSelfChat = currentUser.id === targetUser.id
        if (isSelfChat) {
          return
        }

        // Only add message if it's from the target user we're chatting with
        if (message.sender.id === targetUser.id) {
          setMessages((prev) => [
            ...prev,
            {
              id: message.messageId,
              messageContent: message.messageContent,
              isRead: false,
              isEdited: false,
              createdAt: message.createdAt,
              sentByUserId: message.sender.id,
              isMine: false,
              sender: message.sender,
            },
          ])
          // Auto-mark as read since user is viewing the chat
          markMessagesAsRead()
          // Note: Auto-scroll is handled by the useEffect that watches messages.length
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
    }
  }, [targetUser.id])

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    return date
      .toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
      .toUpperCase()
  }

  // Check if chatting with yourself
  const isSelfChat = currentUser.id === targetUser.id

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

        {/* Call Actions - Hide when chatting with yourself */}
        {!isSelfChat && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onInitiateCall(targetUser.id, CallType.Audio)}
              className="text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
              title="Audio Call"
            >
              <Phone className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onInitiateCall(targetUser.id, CallType.Video)}
              className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20"
              title="Video Call"
            >
              <Video className="h-5 w-5" />
            </Button>
          </div>
        )}
      </div>

      {/* Messages Container */}
      <div
        ref={messageContainerRef}
        className="flex-1 overflow-y-auto px-6 py-4"
        style={{
          display: "flex",
          flexDirection: "column",
        }}
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
          <div className="space-y-4 flex-grow">
            {/* Infinite scroll trigger - invisible element at the top */}
            <div
              ref={loadMoreTriggerRef}
              className="h-1 w-full"
              aria-hidden="true"
            />

            {/* Loading indicator for infinite scroll */}
            {loadingMore && (
              <div className="flex justify-center py-3">
                <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
              </div>
            )}

            {messages.map((message, index) => {
              const prevMessage = index > 0 ? messages[index - 1] : null
              const showHeader = shouldShowHeader(message, prevMessage)
              const showDateSeparator = shouldShowDateSeparator(
                message,
                prevMessage,
              )

              return (
                <div key={message.id}>
                  {/* Date Separator */}
                  {showDateSeparator && (
                    <div className="relative flex items-center justify-center my-6">
                      <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-gray-200 dark:border-gray-700"></div>
                      </div>
                      <div className="relative px-4 bg-white dark:bg-[#1E1E1E]">
                        <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                          {formatDateSeparator(message.createdAt)}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Message */}
                  <div
                    className={cn(
                      "group hover:bg-gray-50 dark:hover:bg-gray-800/50 -mx-6 px-6 transition-colors duration-150",
                      showHeader ? "py-0.5 mt-2" : "py-0",
                      message.isMine &&
                        "hover:bg-blue-50/30 dark:hover:bg-blue-900/10",
                    )}
                  >
                    <div className="flex gap-3 items-start">
                      {/* Avatar - only show for first message in group */}
                      {showHeader ? (
                        <div className="flex-shrink-0 w-9 h-9">
                          {message.sender.photoLink ? (
                            <img
                              src={`/api/v1/proxy/${encodeURIComponent(message.sender.photoLink)}`}
                              alt={message.sender.name}
                              className="w-9 h-9 rounded-md"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-md bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                              <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                                {message.sender.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="flex-shrink-0 w-9 h-9 flex items-center justify-center">
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                            {formatTime(message.createdAt)}
                          </span>
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        {/* Header - username and timestamp */}
                        {showHeader && (
                          <div className="flex items-center gap-2 mb-0.5 leading-none">
                            <span className="font-semibold text-sm text-gray-900 dark:text-gray-100 leading-none">
                              {message.sender.name}
                            </span>
                            <span className="text-xs text-gray-500 dark:text-gray-400 leading-none whitespace-nowrap">
                              {formatTime(message.createdAt)}
                            </span>
                          </div>
                        )}

                        {/* Message content */}
                        {editingMessageId === message.id ? (
                          <div className="mt-1">
                            <BuzzChatBox
                              key={`edit-${message.id}`}
                              onSend={(newContent) => {
                                handleEditMessage(message.id, newContent)
                              }}
                              onTyping={() => {}}
                              placeholder="Edit your message..."
                              disabled={false}
                              initialContent={editingContent || undefined}
                            />
                            <div className="flex gap-2 mt-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={cancelEditing}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="text-[15px] text-gray-900 dark:text-gray-100 break-words leading-relaxed">
                            <RenderLexicalContent
                              content={message.messageContent}
                              onMentionMessage={handleMentionMessage}
                              onMentionCall={handleMentionCall}
                              currentUserId={currentUser.id}
                            />
                            {message.isEdited && (
                              <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                                (edited)
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Three-dot menu - only show for own messages */}
                      {message.isMine && editingMessageId !== message.id && (
                        <div className="opacity-0 group-hover:opacity-100 transition-all duration-200 ease-in-out">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-all duration-200 hover:shadow-sm border border-transparent hover:border-gray-300 dark:hover:border-gray-600"
                              >
                                <MoreVertical className="h-4 w-4 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => startEditingMessage(message)}
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                Edit message
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() =>
                                  showDeleteConfirmation(message.id)
                                }
                                className="text-red-600 focus:text-red-600"
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete message
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {/* Typing Indicator */}
            {isOtherUserTyping && (
              <div className="group hover:bg-gray-50 dark:hover:bg-gray-800/50 -mx-6 px-6 py-0.5">
                <div className="flex gap-3">
                  <div className="flex-shrink-0 w-9 h-9">
                    {targetUser.photoLink ? (
                      <img
                        src={`/api/v1/proxy/${encodeURIComponent(targetUser.photoLink)}`}
                        alt={targetUser.name}
                        className="w-9 h-9 rounded-md"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-md bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                          {targetUser.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">
                        {targetUser.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
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
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Message Input */}
      <div className="px-6 py-4">
        <BuzzChatBox
          onSend={(editorState) => {
            sendMessage(editorState)
          }}
          onTyping={(isTyping) => {
            callNotificationClient.sendTypingIndicator(targetUser.id, isTyping)
          }}
          placeholder={`Message ${targetUser.name}...`}
          disabled={sending}
        />
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        showModal={deleteConfirmModal.open}
        setShowModal={(value) => {
          if (value.open === false) {
            handleCancelDelete()
          }
        }}
        modalTitle={deleteConfirmModal.title}
        modalMessage={deleteConfirmModal.description}
        onConfirm={handleConfirmDelete}
      />
    </div>
  )
}
