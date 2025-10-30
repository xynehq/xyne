import { useState, useEffect, useRef } from "react"
import { Phone, Video, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { cn } from "@/lib/utils"
import { callNotificationClient } from "@/services/callNotifications"
import { CallType, LexicalEditorState } from "@/types"
import BuzzChatBox from "@/components/BuzzChatBox"

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
  createdAt: string
  sentByUserId: string
  isMine: boolean
  sender: User
}

interface ChatViewProps {
  targetUser: User
  currentUser: User
  onInitiateCall: (userId: string, callType: CallType) => void
}

const MAX_MESSAGE_LENGTH = 10000

// Component to render Lexical JSON content
function RenderLexicalContent({ content }: { content: LexicalEditorState }) {
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
      return <p key={index}>{node.children?.map(renderNode)}</p>
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
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [isOtherUserTyping, setIsOtherUserTyping] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageContainerRef = useRef<HTMLDivElement>(null)

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

  // Send a message
  // Helper to extract plain text from Lexical JSON
  const extractPlainText = (editorState: LexicalEditorState): string => {
    const extractText = (node: any): string => {
      if (node.type === "text") {
        return node.text || ""
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
    }
  }, [targetUser.id])

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  // Check if message should show header (avatar + username)
  const shouldShowHeader = (
    currentMsg: Message,
    prevMsg: Message | null,
  ): boolean => {
    if (!prevMsg) return true
    // Show header if different sender
    if (prevMsg.sentByUserId !== currentMsg.sentByUserId) return true
    // Show header if more than 5 minutes apart
    const timeDiff =
      new Date(currentMsg.createdAt).getTime() -
      new Date(prevMsg.createdAt).getTime()
    return timeDiff > 5 * 60 * 1000 // 5 minutes
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
            {messages.map((message, index) => {
              const prevMessage = index > 0 ? messages[index - 1] : null
              const showHeader = shouldShowHeader(message, prevMessage)

              return (
                <div
                  key={message.id}
                  className={cn(
                    "group hover:bg-gray-50 dark:hover:bg-gray-800/50 -mx-6 px-6",
                    showHeader ? "py-0.5 mt-2" : "py-0",
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
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity">
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
                          <span className="text-xs text-gray-500 dark:text-gray-400 leading-none">
                            {formatTime(message.createdAt)}
                          </span>
                        </div>
                      )}

                      {/* Message content */}
                      <div className="text-[15px] text-gray-900 dark:text-gray-100 break-words leading-relaxed">
                        <RenderLexicalContent
                          content={message.messageContent}
                        />
                      </div>
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
          </>
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
    </div>
  )
}
