import { useEffect, useState, useRef } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { callNotificationClient } from "@/services/callNotifications"
import {
  Phone,
  Settings,
  Users,
  Pin,
  Hash,
  Lock,
  MoreVertical,
  Pencil,
  Trash2,
  MessageSquare,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import BuzzChatBox from "./BuzzChatBox"
import { ConfirmModal } from "./ui/confirmModal"
import ThreadPanel from "./ThreadPanel"
import { RenderLexicalContent } from "@/components/RenderLexicalContent"
import { CallType } from "@/types"
import { cn } from "@/lib/utils"
import type { Channel, ChannelMessage, LexicalEditorState } from "@/types"
import {
  formatDateSeparator,
  shouldShowDateSeparator,
  extractTextContent,
  shouldShowHeader,
  isContentEqual,
  formatTime,
} from "@/utils/messageHelpers"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface ChannelViewProps {
  channel: Channel
  currentUser: User
  onInitiateCall: (channelId: number, callType: CallType) => void
  onOpenSettings: (channelId: number) => void
  onOpenMembers: (channelId: number) => void
  onSwitchToUser?: (userId: string) => void
}

const MAX_MESSAGE_LENGTH = 10000

export default function ChannelView({
  channel,
  currentUser,
  onInitiateCall,
  onOpenSettings,
  onOpenMembers,
  onSwitchToUser,
}: ChannelViewProps) {
  const [messages, setMessages] = useState<ChannelMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [sending, setSending] = useState(false)
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set())
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
  const [pinnedMessages, setPinnedMessages] = useState<ChannelMessage[]>([])
  const [showPinnedMessages, setShowPinnedMessages] = useState(false)
  const [memberCount, setMemberCount] = useState<number>(
    channel.memberCount || 0,
  )
  const [openThread, setOpenThread] = useState<ChannelMessage | null>(null)
  const [channelMembers, setChannelMembers] = useState<Map<string, User>>(
    new Map(),
  )

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const messageContainerRef = useRef<HTMLDivElement>(null)
  const loadMoreTriggerRef = useRef<HTMLDivElement>(null)
  const typingTimeoutsRef = useRef<Map<string, NodeJS.Timeout>>(new Map())

  // Helper to check if user is mentioned in message
  const checkIfUserMentioned = (
    content: LexicalEditorState,
    userId: string,
  ): boolean => {
    try {
      const checkNode = (node: any): boolean => {
        if (!node) return false

        // Check if this is a mention node with the current user's ID
        if (node.type === "mention") {
          // Check for @channel or @here mentions (notify everyone)
          if (node.mentionType === "channel" || node.mentionType === "here") {
            return true
          }
          // Check for direct user mention
          if (node.mentionUser && node.mentionUser.id === userId) {
            return true
          }
        }

        // Recursively check children
        if (node.children && Array.isArray(node.children)) {
          return node.children.some(checkNode)
        }

        return false
      }

      return content.root.children.some(checkNode)
    } catch (error) {
      console.error("Error checking mentions:", error)
      return false
    }
  }

  // Handle mention message action
  const handleMentionMessage = async (userId: string) => {
    // Call the parent callback to switch to DM with user
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
    // For channels, we can't directly call a user's ID
    // We would need to initiate a direct call
    toast({
      title: "Info",
      description:
        "Call feature is not yet implemented for mentions in channels",
    })
  }

  // Handle reply added in thread
  const handleReplyAdded = (parentMessageId: number) => {
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.id === parentMessageId) {
          return {
            ...msg,
            replyCount: (msg.replyCount || 0) + 1,
            lastReplyAt: new Date().toISOString(),
            // Add current user to repliers list (keep last 3 unique repliers)
            repliers: [
              ...(msg.repliers || []).filter(
                (r) => r.userId !== currentUser.id,
              ),
              {
                userId: currentUser.id,
                name: currentUser.name,
                photoLink: currentUser.photoLink || null,
              },
            ].slice(-3),
          }
        }
        return msg
      }),
    )
  }

  // Scroll to bottom
  const scrollToBottom = () => {
    const container = messageContainerRef.current
    if (container) {
      container.scrollTop = container.scrollHeight
    }
  }

  // Initial load: position at bottom
  useEffect(() => {
    if (isInitialLoad && messages.length > 0 && messageContainerRef.current) {
      requestAnimationFrame(() => {
        scrollToBottom()
        setIsInitialLoad(false)
      })
    }
  }, [messages, isInitialLoad])

  // Auto-scroll when new messages arrive
  useEffect(() => {
    const container = messageContainerRef.current
    if (!container || loadingMore || isInitialLoad) return

    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      100

    if (isNearBottom) {
      requestAnimationFrame(() => {
        scrollToBottom()
      })
    }
  }, [messages.length, typingUsers.size, loadingMore, isInitialLoad])

  // Infinite scroll observer
  useEffect(() => {
    const trigger = loadMoreTriggerRef.current
    const container = messageContainerRef.current

    if (!trigger || !container || !hasMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry.isIntersecting && hasMore && !loadingMore && !loading) {
          loadMoreMessages()
        }
      },
      {
        root: container,
        rootMargin: "200px",
        threshold: 0,
      },
    )

    observer.observe(trigger)

    return () => {
      observer.disconnect()
    }
  }, [hasMore, loadingMore, loading, nextCursor])

  // Fetch channel messages
  const fetchMessages = async () => {
    setLoading(true)
    setIsInitialLoad(true)
    try {
      const response = await api.channels.messages.$get({
        query: {
          channelId: channel.id.toString(),
          limit: "50",
        },
      })

      if (response.ok) {
        const data = await response.json()
        setMessages(data.messages || [])
        setNextCursor(data.responseMetadata?.nextCursor || "")
        setHasMore(data.responseMetadata?.hasMore || false)
      } else {
        console.error("Failed to fetch channel messages")
        toast({
          title: "Error",
          description: "Failed to load channel messages",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to fetch channel messages:", error)
      toast({
        title: "Error",
        description: "Failed to load channel messages",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Load more messages (infinite scroll)
  const loadMoreMessages = async () => {
    if (!hasMore || loadingMore || !nextCursor || loading) return

    const container = messageContainerRef.current
    if (!container) return

    const scrollHeightBefore = container.scrollHeight
    const scrollTopBefore = container.scrollTop

    setLoadingMore(true)
    try {
      const response = await api.channels.messages.$get({
        query: {
          channelId: channel.id.toString(),
          limit: "50",
          cursor: nextCursor,
        },
      })

      if (response.ok) {
        const data = await response.json()

        setMessages((prev) => [...(data.messages || []), ...prev])
        setNextCursor(data.responseMetadata?.nextCursor || "")
        setHasMore(data.responseMetadata?.hasMore || false)

        requestAnimationFrame(() => {
          if (container) {
            const scrollHeightAfter = container.scrollHeight
            const addedHeight = scrollHeightAfter - scrollHeightBefore
            container.scrollTop = scrollTopBefore + addedHeight
          }
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

  // Fetch pinned messages
  const fetchPinnedMessages = async () => {
    try {
      const response = await api.channels.messages.pinned.$get({
        query: {
          channelId: channel.id.toString(),
        },
      })

      if (response.ok) {
        const data = await response.json()
        setPinnedMessages(data.pinnedMessages || [])
      }
    } catch (error) {
      console.error("Failed to fetch pinned messages:", error)
    }
  }

  // Send message
  const sendMessage = async (editorState: LexicalEditorState) => {
    const plainText = extractTextContent(editorState).trim()
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
      const response = await api.channels.messages.send.$post({
        json: {
          channelId: channel.id,
          messageContent: editorState,
        },
      })

      if (!response.ok) {
        throw new Error("Failed to send message")
      }

      const { message: sentMessage } = await response.json()

      // Add the sent message to the messages list
      setMessages((prev) => [
        ...prev,
        {
          id: sentMessage.id,
          channelId: sentMessage.channelId,
          messageContent: sentMessage.messageContent,
          isEdited: false,
          isPinned: false,
          createdAt: sentMessage.createdAt,
          sender: currentUser,
        },
      ])

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

  // Handle edit message
  const handleEditMessage = async (
    messageId: number,
    newContent: LexicalEditorState,
  ) => {
    if (editingContent && isContentEqual(editingContent, newContent)) {
      setEditingMessageId(null)
      setEditingContent(null)
      return
    }

    try {
      const response = await api.channels.messages.edit.$put({
        json: {
          messageId,
          messageContent: newContent,
        },
      })

      if (response.ok) {
        const data = await response.json()
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
      const response = await api.channels.messages.delete.$delete({
        json: { messageId },
      })

      if (response.ok) {
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

  // Pin/Unpin message
  const handleTogglePin = async (messageId: number, isPinned: boolean) => {
    try {
      const response = isPinned
        ? await api.channels.messages.unpin.$post({ json: { messageId } })
        : await api.channels.messages.pin.$post({ json: { messageId } })

      if (response.ok) {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, isPinned: !isPinned } : msg,
          ),
        )
        fetchPinnedMessages() // Refresh pinned messages
        toast({
          title: "Success",
          description: isPinned
            ? "Message unpinned successfully"
            : "Message pinned successfully",
        })
      } else {
        throw new Error("Failed to toggle pin")
      }
    } catch (error) {
      console.error("Error toggling pin:", error)
      toast({
        title: "Error",
        description: "Failed to update message",
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

  // Cancel delete
  const handleCancelDelete = () => {
    setDeleteConfirmModal({
      open: false,
      title: "",
      description: "",
      messageId: null,
    })
  }

  // Start editing
  const startEditingMessage = (message: ChannelMessage) => {
    setEditingMessageId(message.id)
    setEditingContent(message.messageContent)
  }

  // Cancel editing
  const cancelEditing = () => {
    setEditingMessageId(null)
    setEditingContent(null)
  }

  // Fetch member count and member data
  const fetchMemberCount = async () => {
    try {
      const response = await api.channels.members.$get({
        query: { channelId: channel.id.toString() },
      })

      if (response.ok) {
        const data = await response.json()
        setMemberCount(data.members?.length || 0)

        // Store member data in a map for quick lookup
        const membersMap = new Map<string, User>()
        data.members?.forEach((member: any) => {
          membersMap.set(member.id, {
            id: member.id,
            name: member.name,
            email: member.email,
            photoLink: member.photoLink,
          })
        })
        setChannelMembers(membersMap)
      }
    } catch (error) {
      console.error("Failed to fetch member count:", error)
    }
  }

  // Handle typing indicator
  const handleTyping = (isTyping: boolean) => {
    // Get all member IDs from channelMembers map
    const memberUserIds = Array.from(channelMembers.keys())
    if (memberUserIds.length > 0) {
      callNotificationClient.sendChannelTypingIndicator(
        channel.id,
        memberUserIds,
        isTyping,
      )
    }
  }

  // Load messages and set up real-time subscriptions
  useEffect(() => {
    setIsInitialLoad(true)
    setMessages([]) // Clear messages when switching channels
    setNextCursor("") // Reset pagination cursor
    setHasMore(true) // Reset pagination flag
    fetchMessages()
    fetchPinnedMessages()
    fetchMemberCount()

    // Subscribe to channel messages
    const unsubscribeMessage = callNotificationClient.onChannelMessage(
      (message) => {
        if (message.channelId === channel.id) {
          // Don't add if it's from current user (already added optimistically)
          if (message.sender.id !== currentUser.id) {
            setMessages((prev) => [
              ...prev,
              {
                id: message.messageId,
                channelId: message.channelId,
                messageContent: message.messageContent,
                isEdited: false,
                isPinned: false,
                createdAt: message.createdAt,
                sender: message.sender,
              },
            ])

            // Check if current user is mentioned in the message
            const isMentioned = checkIfUserMentioned(
              message.messageContent,
              currentUser.id,
            )

            // Only show notification if user is mentioned or @channel/@here is used
            if (isMentioned) {
              toast({
                title: `${message.sender.name} mentioned you in #${message.channelName}`,
                description: message.plainTextContent.substring(0, 100),
              })
            }
          }
        }
      },
    )

    // Subscribe to typing indicators
    const unsubscribeTyping = callNotificationClient.onChannelTypingIndicator(
      (indicator) => {
        if (indicator.channelId === channel.id) {
          // Clear any existing timeout for this user
          const existingTimeout = typingTimeoutsRef.current.get(
            indicator.userId,
          )
          if (existingTimeout) {
            clearTimeout(existingTimeout)
            typingTimeoutsRef.current.delete(indicator.userId)
          }

          setTypingUsers((prev) => {
            const newSet = new Set(prev)
            if (indicator.isTyping) {
              newSet.add(indicator.userId)
            } else {
              newSet.delete(indicator.userId)
            }
            return newSet
          })

          // Auto-clear typing indicator after 5 seconds
          if (indicator.isTyping) {
            const timeout = setTimeout(() => {
              setTypingUsers((prev) => {
                const newSet = new Set(prev)
                newSet.delete(indicator.userId)
                return newSet
              })
              typingTimeoutsRef.current.delete(indicator.userId)
            }, 5000)
            typingTimeoutsRef.current.set(indicator.userId, timeout)
          }
        }
      },
    )

    // Subscribe to channel updates
    const unsubscribeUpdate = callNotificationClient.onChannelUpdate(
      (update) => {
        if (update.channelId === channel.id) {
          // Refresh channel data or messages as needed
          if (
            update.updateType === "archived" ||
            update.updateType === "renamed"
          ) {
            // Parent component should handle channel refresh
            toast({
              title: "Channel Updated",
              description: `Channel has been ${update.updateType}`,
            })
          }
        }
      },
    )

    // Subscribe to thread replies to update reply counts
    const unsubscribeThreadReply = callNotificationClient.onThreadReply(
      (data) => {
        // Update the reply count and last reply time for the parent message
        if (data.messageType === "channel") {
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === data.parentMessageId) {
                return {
                  ...msg,
                  replyCount: (msg.replyCount || 0) + 1,
                  lastReplyAt: data.reply.createdAt,
                  // Update repliers list (keep last 3 unique repliers)
                  repliers: [
                    ...(msg.repliers || []).filter(
                      (r) => r.userId !== data.reply.sender.externalId,
                    ),
                    {
                      userId: data.reply.sender.externalId,
                      name: data.reply.sender.name,
                      photoLink: data.reply.sender.photoLink || null,
                    },
                  ].slice(-3),
                }
              }
              return msg
            }),
          )
        }
      },
    )

    // Subscribe to channel message edits
    const unsubscribeEdit = callNotificationClient.onChannelMessageEdit(
      (edit) => {
        // Only update if it's for this channel
        if (edit.channelId === channel.id) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === edit.messageId
                ? {
                    ...msg,
                    messageContent: edit.messageContent,
                    isEdited: true,
                    updatedAt: edit.updatedAt,
                  }
                : msg,
            ),
          )

          // Also update the open thread if it's the same message
          setOpenThread((prev) =>
            prev && prev.id === edit.messageId
              ? {
                  ...prev,
                  messageContent: edit.messageContent,
                  isEdited: true,
                  updatedAt: edit.updatedAt,
                }
              : prev,
          )
        }
      },
    )

    // Subscribe to channel message deletes
    const unsubscribeDelete = callNotificationClient.onChannelMessageDelete(
      (del) => {
        // Only update if it's for this channel
        if (del.channelId === channel.id) {
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === del.messageId
                ? { ...msg, deletedAt: new Date().toISOString() }
                : msg,
            ),
          )

          // Close thread if the deleted message was open
          setOpenThread((prev) =>
            prev && prev.id === del.messageId ? null : prev,
          )
        }
      },
    )

    return () => {
      unsubscribeMessage()
      unsubscribeTyping()
      unsubscribeUpdate()
      unsubscribeThreadReply()
      unsubscribeEdit()
      unsubscribeDelete()

      // Clear all typing timeouts
      typingTimeoutsRef.current.forEach((timeout) => clearTimeout(timeout))
      typingTimeoutsRef.current.clear()
    }
  }, [channel.id])

  // Check if user can manage messages (owner or admin)
  const canManageMessages =
    channel.memberRole === "owner" || channel.memberRole === "admin"

  return (
    <div className="h-full w-full bg-white dark:bg-[#1E1E1E] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[#D7E0E9] dark:border-gray-700">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            {channel.type === "private" ? (
              <Lock className="h-5 w-5 text-gray-500" />
            ) : (
              <Hash className="h-5 w-5 text-gray-500" />
            )}
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {channel.name}
            </h2>
          </div>
          {channel.description && (
            <span className="text-sm text-gray-500 dark:text-gray-400 ml-2">
              {channel.description}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Pinned Messages Button */}
          {pinnedMessages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPinnedMessages(!showPinnedMessages)}
              className="flex items-center gap-2"
            >
              <Pin className="h-4 w-4" />
              <span>{pinnedMessages.length}</span>
            </Button>
          )}

          {/* Members Button */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenMembers(channel.id)}
            className="flex items-center gap-2"
          >
            <Users className="h-4 w-4" />
            <span>{memberCount}</span>
          </Button>

          {/* Call Button - Audio only for channels */}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onInitiateCall(channel.id, CallType.Audio)}
            title="Start channel audio call"
          >
            <Phone className="h-4 w-4" />
          </Button>

          {/* Settings Button */}
          {canManageMessages && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenSettings(channel.id)}
              title="Channel settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Pinned Messages Banner */}
      {showPinnedMessages && pinnedMessages.length > 0 && (
        <div className="px-6 py-3 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-100 dark:border-blue-900/50">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <Pin className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  Pinned Messages
                </span>
              </div>
              <div className="space-y-2">
                {pinnedMessages.slice(0, 3).map((msg) => (
                  <div
                    key={msg.id}
                    className="text-sm text-gray-700 dark:text-gray-300"
                  >
                    <span className="font-medium">{msg.sender.name}: </span>
                    <RenderLexicalContent
                      content={msg.messageContent}
                      onMentionMessage={handleMentionMessage}
                      onMentionCall={handleMentionCall}
                      currentUserId={currentUser.id}
                    />
                  </div>
                ))}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPinnedMessages(false)}
              className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              ✕
            </Button>
          </div>
        </div>
      )}

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
            <div className="text-gray-500">Loading messages...</div>
          </div>
        ) : (
          <>
            {/* Load More Trigger */}
            {hasMore && (
              <div
                ref={loadMoreTriggerRef}
                className="flex items-center justify-center py-4"
              >
                {loadingMore && (
                  <div className="text-sm text-gray-500">
                    Loading more messages...
                  </div>
                )}
              </div>
            )}

            {/* Messages */}
            {messages
              .filter((msg) => !msg.deletedAt)
              .map((message, index, filteredMessages) => {
                const prevMessage =
                  index > 0 ? filteredMessages[index - 1] : null
                const showHeader = shouldShowHeader(message, prevMessage)
                const showDateSeparator = shouldShowDateSeparator(
                  message,
                  prevMessage,
                )
                const isMine = message.sender.id === currentUser.id
                const isEditing = editingMessageId === message.id

                return (
                  <div key={message.id}>
                    {/* Date Separator */}
                    {showDateSeparator && (
                      <div className="relative flex items-center justify-center my-6">
                        <div className="absolute inset-0 flex items-center">
                          <div className="w-full border-t border-gray-200 dark:border-gray-700"></div>
                        </div>
                        <div className="relative px-4 bg-white dark:bg-[#232323]">
                          <span className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">
                            {formatDateSeparator(message.createdAt)}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Message */}
                    <div
                      className={cn(
                        "group -mx-6 px-6 py-1 hover:bg-gray-50 dark:hover:bg-gray-800/50 flex gap-3 items-start",
                        showHeader ? "mt-4" : "mt-0.5",
                      )}
                    >
                      {/* Avatar (only show if header is shown) */}
                      <div className="flex-shrink-0">
                        {showHeader ? (
                          message.sender.photoLink ? (
                            <img
                              src={`/api/v1/proxy/${encodeURIComponent(message.sender.photoLink)}`}
                              alt={message.sender.name}
                              className="w-9 h-9 rounded-md"
                            />
                          ) : (
                            <div className="w-9 h-9 rounded-md bg-gray-300 dark:bg-gray-700 flex items-center justify-center">
                              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                {message.sender.name.charAt(0).toUpperCase()}
                              </span>
                            </div>
                          )
                        ) : (
                          <div className="w-9 h-9 flex items-center justify-center">
                            <span className="text-[10px] text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                              {formatTime(message.createdAt)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Message Content */}
                      <div className="flex-1 min-w-0">
                        {showHeader && (
                          <div className="flex items-baseline gap-2 mb-0.5">
                            <span className="font-semibold text-[15px] text-gray-900 dark:text-gray-100">
                              {message.sender.name}
                            </span>
                            <span className="text-[11px] text-gray-500 dark:text-gray-400 whitespace-nowrap">
                              {formatTime(message.createdAt)}
                            </span>
                            {message.isEdited && (
                              <span className="text-[11px] text-gray-400 dark:text-gray-500">
                                (edited)
                              </span>
                            )}
                            {message.isPinned && (
                              <Pin className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                            )}
                          </div>
                        )}

                        {isEditing ? (
                          <div className="mt-2">
                            <BuzzChatBox
                              initialContent={editingContent || undefined}
                              onSend={(content) =>
                                handleEditMessage(message.id, content)
                              }
                              placeholder="Edit message..."
                              disabled={false}
                            />
                            <div className="flex gap-2 mt-2">
                              <Button size="sm" onClick={cancelEditing}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="text-[15px] text-gray-800 dark:text-gray-200 break-words leading-[22px]">
                            <RenderLexicalContent
                              content={message.messageContent}
                              onMentionMessage={handleMentionMessage}
                              onMentionCall={handleMentionCall}
                              currentUserId={currentUser.id}
                            />
                          </div>
                        )}
                      </div>

                      {/* Message Actions (show on hover) */}
                      {!isEditing && (
                        <div className="opacity-0 group-hover:opacity-100 transition-all duration-200 flex-shrink-0 flex items-center gap-1">
                          {/* Reply in Thread Button */}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            onClick={() => setOpenThread(message)}
                            title="Reply in thread"
                          >
                            <MessageSquare className="h-4 w-4" />
                          </Button>

                          {/* More Options Dropdown */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 p-0"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {isMine && (
                                <>
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
                                    className="text-red-600"
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete message
                                  </DropdownMenuItem>
                                </>
                              )}
                              {canManageMessages && !isMine && (
                                <DropdownMenuItem
                                  onClick={() =>
                                    showDeleteConfirmation(message.id)
                                  }
                                  className="text-red-600"
                                >
                                  <Trash2 className="h-4 w-4 mr-2" />
                                  Delete message
                                </DropdownMenuItem>
                              )}
                              {/* Pin option available to everyone */}
                              <DropdownMenuItem
                                onClick={() =>
                                  handleTogglePin(message.id, message.isPinned)
                                }
                              >
                                <Pin className="h-4 w-4 mr-2" />
                                {message.isPinned
                                  ? "Unpin message"
                                  : "Pin message"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </div>

                    {/* Reply Count - Show if message has replies */}
                    {message.replyCount !== undefined &&
                      message.replyCount > 0 && (
                        <div
                          onClick={() => setOpenThread(message)}
                          className="ml-12 mt-1 flex items-center gap-2 text-sm text-blue-600 dark:text-blue-400 cursor-pointer hover:opacity-80 transition-opacity group/reply"
                        >
                          {/* Profile Icons of Repliers */}
                          {message.repliers && message.repliers.length > 0 && (
                            <div className="flex -space-x-2">
                              {message.repliers
                                .slice(0, 3)
                                .map((replier, idx) => (
                                  <div
                                    key={idx}
                                    className="relative w-6 h-6 rounded border-2 border-white dark:border-gray-900"
                                    title={replier.name}
                                  >
                                    {replier.photoLink ? (
                                      <img
                                        src={`/api/v1/proxy/${encodeURIComponent(replier.photoLink)}`}
                                        alt={replier.name}
                                        className="w-full h-full rounded object-cover"
                                      />
                                    ) : (
                                      <div className="w-full h-full rounded bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                                        <span className="text-[10px] font-medium text-gray-600 dark:text-gray-300">
                                          {replier.name.charAt(0).toUpperCase()}
                                        </span>
                                      </div>
                                    )}
                                  </div>
                                ))}
                            </div>
                          )}

                          <span className="font-medium">
                            {message.replyCount}{" "}
                            {message.replyCount === 1 ? "reply" : "replies"}
                          </span>

                          {message.lastReplyAt && (
                            <span className="text-gray-500 dark:text-gray-400 font-normal">
                              Last reply{" "}
                              {new Date(message.lastReplyAt).toLocaleTimeString(
                                [],
                                { hour: "2-digit", minute: "2-digit" },
                              )}
                            </span>
                          )}
                        </div>
                      )}
                  </div>
                )
              })}

            {/* Typing Indicator */}
            {typingUsers.size > 0 && (
              <div className="group hover:bg-gray-50 dark:hover:bg-gray-800/50 -mx-6 px-6 py-0.5">
                <div className="flex gap-3">
                  {/* Show profile picture for single user, or stacked avatars for multiple */}
                  <div className="flex-shrink-0">
                    {typingUsers.size === 1 ? (
                      // Single user typing - show their avatar
                      (() => {
                        const userId = Array.from(typingUsers)[0]
                        const member = channelMembers.get(userId)
                        return member?.photoLink ? (
                          <img
                            src={`/api/v1/proxy/${encodeURIComponent(member.photoLink)}`}
                            alt={member.name}
                            className="w-9 h-9 rounded-md"
                          />
                        ) : (
                          <div className="w-9 h-9 rounded-md bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                            <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
                              {member?.name?.charAt(0).toUpperCase() || "?"}
                            </span>
                          </div>
                        )
                      })()
                    ) : (
                      // Multiple users typing - show stacked avatars (up to 3)
                      <div className="flex -space-x-2 w-9">
                        {Array.from(typingUsers)
                          .slice(0, 3)
                          .map((userId) => {
                            const member = channelMembers.get(userId)
                            return member?.photoLink ? (
                              <img
                                key={userId}
                                src={`/api/v1/proxy/${encodeURIComponent(member.photoLink)}`}
                                alt={member.name}
                                className="w-6 h-6 rounded border-2 border-white dark:border-gray-900"
                                title={member.name}
                              />
                            ) : (
                              <div
                                key={userId}
                                className="w-6 h-6 rounded bg-gray-300 dark:bg-gray-600 border-2 border-white dark:border-gray-900 flex items-center justify-center"
                                title={member?.name || "Unknown"}
                              >
                                <span className="text-[10px] font-medium text-gray-600 dark:text-gray-300">
                                  {member?.name?.charAt(0).toUpperCase() || "?"}
                                </span>
                              </div>
                            )
                          })}
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="font-semibold text-sm text-gray-900 dark:text-gray-100">
                        {(() => {
                          const typingNames = Array.from(typingUsers)
                            .map((userId) => {
                              const member = channelMembers.get(userId)
                              return member?.name || "Someone"
                            })
                            .filter(
                              (name, index, arr) => arr.indexOf(name) === index,
                            ) // Remove duplicates

                          if (typingNames.length === 1) {
                            return typingNames[0]
                          } else if (typingNames.length === 2) {
                            return `${typingNames[0]} and ${typingNames[1]}`
                          } else if (typingNames.length === 3) {
                            return `${typingNames[0]}, ${typingNames[1]} and ${typingNames[2]}`
                          } else {
                            return `${typingNames.slice(0, 2).join(", ")} and ${typingNames.length - 2} other${typingNames.length - 2 > 1 ? "s" : ""}`
                          }
                        })()}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {typingUsers.size === 1
                          ? "is typing..."
                          : "are typing..."}
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
          onSend={sendMessage}
          onTyping={handleTyping}
          placeholder={`Message #${channel.name}`}
          disabled={sending || channel.isArchived}
        />
        {channel.isArchived && (
          <div className="text-sm text-yellow-600 dark:text-yellow-400 mt-2">
            This channel is archived. You cannot send messages.
          </div>
        )}
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

      {/* Thread Panel */}
      {openThread && (
        <ThreadPanel
          parentMessage={{
            id: openThread.id,
            senderId: openThread.sender.id,
            senderName: openThread.sender.name,
            senderPhoto: openThread.sender.photoLink || undefined,
            messageContent: openThread.messageContent,
            createdAt: openThread.createdAt,
            messageType: "channel",
          }}
          currentUserId={currentUser.id}
          onClose={() => setOpenThread(null)}
          onMentionMessage={handleMentionMessage}
          onMentionCall={handleMentionCall}
          onReplyAdded={handleReplyAdded}
        />
      )}
    </div>
  )
}
