import { createFileRoute } from "@tanstack/react-router"
import { useState, useEffect } from "react"
import { Search, Users as UsersIcon, Plus } from "lucide-react"
import { cn } from "@/lib/utils"
import { CLASS_NAMES } from "@/lib/constants"
import { Input } from "@/components/ui/input"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import ChatView from "@/components/ChatView"
import { CallType } from "@/types"
import NewChatModal from "@/components/NewChatModal"
import { callNotificationClient } from "@/services/callNotifications"
import { useUnreadCount } from "@/contexts/UnreadCountContext"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

export const Route = createFileRoute("/_authenticated/buzz/chats")({
  component: BuzzChats,
})

function BuzzChats() {
  const [conversationParticipants, setConversationParticipants] = useState<
    User[]
  >([])
  const [searchQuery, setSearchQuery] = useState("")
  const [filteredParticipants, setFilteredParticipants] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [selectedChatUser, setSelectedChatUser] = useState<User | null>(null)
  const [showNewChatModal, setShowNewChatModal] = useState(false)
  const { unreadCounts, clearUnreadCount, incrementUnreadCount } =
    useUnreadCount()

  // Fetch current user info
  const fetchCurrentUser = async () => {
    try {
      const response = await api.me.$get()
      if (response.ok) {
        const data = await response.json()
        setCurrentUser({
          id: data.user.id || data.user.externalId,
          name: data.user.name,
          email: data.user.email,
          photoLink: data.user.photoLink,
        })
      }
    } catch (error) {
      console.error("Failed to fetch current user:", error)
    }
  }

  // Fetch conversation participants (users you've chatted with)
  const fetchConversationParticipants = async () => {
    setLoading(true)
    try {
      // API endpoint to get users you've had conversations with
      const response = await api.messages.participants.$get()
      if (response.ok) {
        const data = await response.json()
        const participants = data.participants || []
        setConversationParticipants(participants)
        setFilteredParticipants(participants)
      } else {
        setConversationParticipants([])
        setFilteredParticipants([])
      }
    } catch (error) {
      console.error("Failed to fetch conversation participants:", error)
      setConversationParticipants([])
      setFilteredParticipants([])
    } finally {
      setLoading(false)
    }
  }

  // Search through conversation participants
  const searchParticipants = (query: string) => {
    let filtered = conversationParticipants

    if (query.trim()) {
      filtered = conversationParticipants.filter(
        (user) =>
          user.name?.toLowerCase().includes(query.toLowerCase()) ||
          user.email?.toLowerCase().includes(query.toLowerCase()),
      )
    }

    // Sort: users with unread messages first, then alphabetically
    const sorted = [...filtered].sort((a, b) => {
      const aUnread = unreadCounts[a.id] || 0
      const bUnread = unreadCounts[b.id] || 0

      if (aUnread > 0 && bUnread === 0) return -1
      if (aUnread === 0 && bUnread > 0) return 1

      return a.name.localeCompare(b.name)
    })

    setFilteredParticipants(sorted)
  }

  // Initiate a call
  const initiateCall = async (
    targetUserId: string,
    callType: CallType = CallType.Video,
  ) => {
    if (!targetUserId) {
      toast({
        title: "Error",
        description: "Invalid user ID",
        variant: "destructive",
      })
      return
    }

    try {
      const response = await api.calls.initiate.$post({
        json: { targetUserId, callType },
      })

      if (response.ok) {
        const data = await response.json()

        // Generate caller link using the new cleaner format
        // Caller will also go through the join API to get a fresh token
        const callerLink = `${window.location.origin}/call/${data.callId}?type=${callType}`

        // Generate shareable link (same format - no token needed)
        const shareableLink = `${window.location.origin}/call/${data.callId}?type=${callType}`

        // Show simple notification status
        const notificationStatus = data.notificationSent
          ? `Real-time notification sent to ${data.target.name}!`
          : `${data.target.name} is offline - you can share the link: ${shareableLink}`

        // Show a simple toast
        toast({
          title: "Call Started!",
          description: notificationStatus,
          duration: 5000,
        })

        // Open the caller's window
        const callWindow = window.open(
          callerLink,
          "call-window-caller",
          "width=800,height=600,resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no",
        )

        if (!callWindow) {
          toast({
            title: "Popup Blocked",
            description: "Please allow popups to make calls",
            variant: "destructive",
          })
        }
      } else {
        try {
          const errorData = await response.json()
          console.error("API Error:", errorData)
          toast({
            title: "Call Failed",
            description:
              errorData.message ||
              errorData.error?.message ||
              "Failed to initiate call",
            variant: "destructive",
          })
        } catch (parseError) {
          // If response is not JSON, get it as text
          const errorText = await response.text()
          console.error("API Error (non-JSON):", errorText)
          toast({
            title: "Call Failed",
            description: errorText || "Failed to initiate call",
            variant: "destructive",
          })
        }
      }
    } catch (error) {
      console.error("Failed to initiate call:", error)
      toast({
        title: "Call Failed",
        description: "Failed to initiate call",
        variant: "destructive",
      })
    }
  }

  // Handle user click to open chat
  const handleUserClick = async (user: User) => {
    // Allow opening chat with yourself
    setSelectedChatUser(user)

    // Mark messages as read if there are unread messages from this user
    if (unreadCounts[user.id] && unreadCounts[user.id] > 0) {
      try {
        await api.messages["mark-read"].$post({
          json: { targetUserId: user.id },
        })

        // Clear unread count for this user in global context
        clearUnreadCount(user.id)
      } catch (error) {
        console.error("Failed to mark messages as read:", error)
      }
    }
  }

  // Handle switching to a user from mention
  const handleSwitchToUser = async (userId: string) => {
    try {
      // First, check if user is already in conversation list
      const existingUser = conversationParticipants.find((u) => u.id === userId)

      if (existingUser) {
        // User exists, just switch to them
        handleUserClick(existingUser)
      } else {
        // Need to fetch user info
        const response = await api.workspace.users.$get()
        if (response.ok) {
          const data = await response.json()
          const targetUser = data.find((u: User) => u.id === userId)

          if (targetUser) {
            // Add to conversation participants if not there
            setConversationParticipants((prev) => {
              if (!prev.find((p) => p.id === userId)) {
                return [targetUser, ...prev]
              }
              return prev
            })

            // Switch to this user
            setSelectedChatUser(targetUser)
          } else {
            toast({
              title: "Error",
              description: "User not found",
              variant: "destructive",
            })
          }
        }
      }
    } catch (error) {
      console.error("Failed to switch to user:", error)
      toast({
        title: "Error",
        description: "Failed to open chat with user",
        variant: "destructive",
      })
    }
  }

  // Load data when component mounts
  useEffect(() => {
    fetchCurrentUser()
    fetchConversationParticipants()
  }, [])

  // Subscribe to real-time direct message updates to update conversation list and unread counts
  useEffect(() => {
    const unsubscribeMessage = callNotificationClient.onDirectMessage(
      (message) => {
        // Add sender to conversation list if not already there
        setConversationParticipants((prev) => {
          if (!prev.find((p) => p.id === message.sender.id)) {
            return [message.sender, ...prev]
          }
          return prev
        })

        // If this message is from the currently selected user, mark as read immediately
        if (selectedChatUser && message.sender.id === selectedChatUser.id) {
          // Auto-mark as read since user is viewing the chat
          api.messages["mark-read"]
            .$post({
              json: { targetUserId: message.sender.id },
            })
            .catch((error: unknown) => {
              console.error("Failed to mark message as read:", error)
            })

          // Clear unread count for this user (in case it was set)
          clearUnreadCount(message.sender.id)
        } else {
          // Message is from someone else (not currently viewing), increment unread count
          incrementUnreadCount(message.sender.id)
        }
      },
    )

    return () => {
      unsubscribeMessage()
    }
  }, [selectedChatUser, clearUnreadCount, incrementUnreadCount])

  // Auto-select the most recent conversation when participants load
  useEffect(() => {
    if (conversationParticipants.length > 0 && !selectedChatUser) {
      // Select the first user (most recent conversation)
      setSelectedChatUser(conversationParticipants[0])
    }
  }, [conversationParticipants])

  // Update filtered participants when search query or unread counts change
  useEffect(() => {
    searchParticipants(searchQuery)
  }, [searchQuery, conversationParticipants, unreadCounts])

  // Handle selecting a user from new chat modal
  const handleNewChatUser = (user: User) => {
    setSelectedChatUser(user)
    // Add user to participants if not already there
    if (!conversationParticipants.find((p) => p.id === user.id)) {
      const updatedParticipants = [user, ...conversationParticipants]
      setConversationParticipants(updatedParticipants)
      setFilteredParticipants(updatedParticipants)
    }
  }

  return (
    <>
      {showNewChatModal && (
        <NewChatModal
          onClose={() => setShowNewChatModal(false)}
          onSelectUser={handleNewChatUser}
          currentUserEmail={currentUser?.email}
        />
      )}

      {/* Direct Messages Sidebar */}
      <div
        className={cn(
          "fixed left-[112px] top-0 bottom-0 w-80 bg-white dark:bg-[#1a1a1a] border-r border-[#D7E0E9] dark:border-gray-700 z-10 flex flex-col",
          CLASS_NAMES.HISTORY_MODAL_CONTAINER,
        )}
      >
        {/* Header with Direct Messages title */}
        <div className="px-4 pt-5 pb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
              Direct messages
            </h2>
            <button
              onClick={() => setShowNewChatModal(true)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
              title="New message"
            >
              <Plus size={16} className="text-gray-600 dark:text-gray-400" />
            </button>
          </div>

          {/* Search through existing conversations */}
          <div className="relative">
            <Search
              size={14}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
            />
            <Input
              placeholder="Search conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-8 text-sm bg-gray-50 dark:bg-[#2A2A2A] border-gray-200 dark:border-gray-700"
            />
          </div>
        </div>

        {/* Conversation Participants List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <div className="text-sm text-gray-500 dark:text-gray-400">
                Loading...
              </div>
            </div>
          ) : filteredParticipants.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 px-4 text-center">
              <UsersIcon className="h-12 w-12 mb-3 opacity-30 text-gray-400 dark:text-gray-600" />
              <div className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1">
                {searchQuery ? "No users found" : "No conversations yet"}
              </div>
              {!searchQuery && (
                <button
                  onClick={() => setShowNewChatModal(true)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1"
                >
                  Start a conversation
                </button>
              )}
            </div>
          ) : (
            <div>
              {filteredParticipants.map((user) => (
                <div
                  key={user.id}
                  onClick={() => handleUserClick(user)}
                  className={cn(
                    "flex items-center px-3 py-2 transition-colors cursor-pointer",
                    selectedChatUser?.id === user.id
                      ? "bg-blue-50 dark:bg-gray-800"
                      : "hover:bg-gray-50 dark:hover:bg-gray-800/50",
                  )}
                >
                  {/* User Avatar with initials */}
                  <div className="flex-shrink-0 mr-2.5">
                    {user.photoLink ? (
                      <img
                        src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                        alt={user.name}
                        className="w-8 h-8 rounded-full"
                      />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-blue-600 dark:bg-blue-700 flex items-center justify-center">
                        <span className="text-[11px] font-semibold text-white">
                          {user.name
                            .split(" ")
                            .map((n: string) => n[0])
                            .join("")
                            .toUpperCase()
                            .slice(0, 2)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* User Info */}
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-[13px] truncate leading-tight",
                        unreadCounts[user.id]
                          ? "font-semibold text-gray-900 dark:text-white"
                          : "font-medium text-gray-900 dark:text-gray-100",
                      )}
                    >
                      {user.name}
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate leading-tight mt-0.5">
                      {user.email}
                    </div>
                  </div>

                  {/* Unread Badge */}
                  {unreadCounts[user.id] && unreadCounts[user.id] > 0 && (
                    <div className="flex-shrink-0 ml-2">
                      <div className="min-w-[16px] h-[16px] px-1 flex items-center justify-center bg-blue-600 dark:bg-blue-500 rounded-full">
                        <span className="text-[9px] font-semibold text-white">
                          {unreadCounts[user.id] > 99
                            ? "99+"
                            : unreadCounts[user.id]}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Chat View - Right side */}
      {selectedChatUser && currentUser ? (
        <div className="fixed left-[432px] top-0 right-0 bottom-0 z-10">
          <ChatView
            targetUser={selectedChatUser}
            currentUser={currentUser}
            onInitiateCall={initiateCall}
            onSwitchToUser={handleSwitchToUser}
          />
        </div>
      ) : (
        <div className="fixed left-[432px] top-0 right-0 bottom-0 z-10 flex flex-col items-center justify-center bg-white dark:bg-[#232323]">
          <div className="text-center space-y-2">
            <h3 className="text-xl font-semibold text-gray-700 dark:text-gray-300">
              No conversation selected
            </h3>
            <p className="text-sm text-gray-500">
              Select a user from the list to start a conversation
            </p>
          </div>
        </div>
      )}
    </>
  )
}
