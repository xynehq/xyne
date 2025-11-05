import { useState, useEffect } from "react"
import { Search, X, Users as UsersIcon, History } from "lucide-react"
import { cn } from "@/lib/utils"
import { CLASS_NAMES } from "@/lib/constants"
import { Input } from "@/components/ui/input"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import CallHistory from "./CallHistory"
import ChatView from "./ChatView"
import { CallType } from "@/types"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string
}

interface UsersModalProps {
  onClose: () => void
}

type TabType = "users" | "history"

export default function UsersModal({ onClose }: UsersModalProps) {
  const [activeTab, setActiveTab] = useState<TabType>("users")
  const [users, setUsers] = useState<User[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [selectedChatUser, setSelectedChatUser] = useState<User | null>(null)

  // Fetch current user info
  const fetchCurrentUser = async () => {
    try {
      const response = await api.me.$get()
      if (response.ok) {
        const data = await response.json()
        setCurrentUser({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
          photoLink: data.user.photoLink,
        })
      }
    } catch (error) {
      console.error("Failed to fetch current user:", error)
    }
  }

  // Fetch users from workspace
  const fetchUsers = async () => {
    setLoading(true)
    try {
      const response = await api.workspace.users.$get()
      if (response.ok) {
        const data = await response.json()
        const usersList = data || []
        setUsers(usersList)
        setFilteredUsers(usersList)
      } else {
        console.error(
          "Failed to fetch users - response not ok:",
          response.status,
        )
        setUsers([])
        setFilteredUsers([])
        toast({
          title: "Error",
          description: `Failed to fetch users: ${response.status}`,
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to fetch users:", error)
      setUsers([])
      setFilteredUsers([])
      toast({
        title: "Error",
        description: "Failed to fetch users",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Search users
  const searchUsers = async (query: string) => {
    if (!query.trim()) {
      setFilteredUsers(users || [])
      return
    }

    try {
      const response = await api.workspace.users.search.$get({
        query: { q: query },
      })
      if (response.ok) {
        const data = await response.json()
        setFilteredUsers(data.users || [])
      }
    } catch (error) {
      console.error("Failed to search users:", error)
      // Fallback to local filtering
      const usersList = users || []
      setFilteredUsers(
        usersList.filter(
          (user) =>
            user.name?.toLowerCase().includes(query.toLowerCase()) ||
            user.email?.toLowerCase().includes(query.toLowerCase()),
        ),
      )
    }
  }

  // Initiate a call
  const initiateCall = async (
    targetUserId: string,
    callType: CallType = CallType.Video,
  ) => {
    console.log(
      "Initiating call with targetUserId:",
      targetUserId,
      "callType:",
      callType,
    )

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

        onClose()
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
  const handleUserClick = (user: User) => {
    // Allow chatting with yourself
    setSelectedChatUser(user)
  }

  // Load users when component mounts
  useEffect(() => {
    fetchCurrentUser()
    fetchUsers()
  }, [])

  // Update filtered users when search query changes
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      searchUsers(searchQuery)
    }, 300) // Debounce search

    return () => clearTimeout(timeoutId)
  }, [searchQuery, users])

  return (
    <>
      {/* Secondary Sidebar with Tabs */}
      <div
        className={cn(
          "fixed left-[52px] top-0 h-screen w-[60px] bg-white dark:bg-[#232323] border-r border-[#D7E0E9] dark:border-gray-700 flex flex-col z-20",
        )}
      >
        <div className="flex flex-col items-center pt-6 gap-2">
          <button
            onClick={() => {
              setActiveTab("users")
            }}
            className={cn(
              "flex w-10 h-10 rounded-lg items-center justify-center cursor-pointer transition-colors",
              activeTab === "users"
                ? "bg-[#D8DFE680] dark:bg-gray-700"
                : "hover:bg-[#D8DFE680] dark:hover:bg-gray-700",
            )}
            title="Users"
          >
            <UsersIcon
              size={20}
              className={cn(
                activeTab === "users"
                  ? "text-[#384049] dark:text-[#F1F3F4]"
                  : "text-gray-500 dark:text-gray-400",
              )}
            />
          </button>
          <button
            onClick={() => {
              setActiveTab("history")
              setSelectedChatUser(null)
            }}
            className={cn(
              "flex w-10 h-10 rounded-lg items-center justify-center cursor-pointer transition-colors",
              activeTab === "history"
                ? "bg-[#D8DFE680] dark:bg-gray-700"
                : "hover:bg-[#D8DFE680] dark:hover:bg-gray-700",
            )}
            title="Call History"
          >
            <History
              size={20}
              className={cn(
                activeTab === "history"
                  ? "text-[#384049] dark:text-[#F1F3F4]"
                  : "text-gray-500 dark:text-gray-400",
              )}
            />
          </button>
        </div>
      </div>

      {/* Content Area */}
      {activeTab === "history" ? (
        <div className="fixed left-[112px] top-0 right-0 bottom-0 z-30">
          <CallHistory />
        </div>
      ) : (
        <>
          {/* Users List Sidebar - Always visible */}
          <div
            className={cn(
              "fixed left-[112px] top-0 bottom-0 w-80 bg-white dark:bg-[#1E1E1E] border-r border-[#D7E0E9] dark:border-gray-700 z-30 flex flex-col",
              CLASS_NAMES.HISTORY_MODAL_CONTAINER,
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-[#D7E0E9] dark:border-gray-700">
              <h2 className="text-lg font-semibold text-[#384049] dark:text-[#F1F3F4]">
                Workspace Users
              </h2>
              <button
                onClick={onClose}
                className="p-1 hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded"
              >
                <X
                  size={16}
                  stroke="#384049"
                  className="dark:stroke-[#F1F3F4]"
                />
              </button>
            </div>

            {/* Search */}
            <div className="p-4 border-b border-[#D7E0E9] dark:border-gray-700">
              <div className="relative">
                <Search
                  size={16}
                  className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
                />
                <Input
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            {/* Users List */}
            <div className="flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="flex items-center justify-center h-20">
                  <div className="text-sm text-gray-500">Loading users...</div>
                </div>
              ) : !filteredUsers || filteredUsers.length === 0 ? (
                <div className="flex items-center justify-center h-20">
                  <div className="text-sm text-gray-500">
                    {searchQuery ? "No users found" : "No users in workspace"}
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  {(filteredUsers || []).map((user) => (
                    <div
                      key={user.id}
                      onClick={() => handleUserClick(user)}
                      className={cn(
                        "flex items-center p-3 rounded-lg transition-colors",
                        selectedChatUser?.id === user.id
                          ? "bg-[#D8DFE680] dark:bg-gray-700"
                          : currentUser && currentUser.email === user.email
                            ? "opacity-50 cursor-not-allowed"
                            : "hover:bg-[#D8DFE680] dark:hover:bg-gray-700 cursor-pointer",
                      )}
                    >
                      {/* User Avatar */}
                      <div className="flex-shrink-0 mr-3">
                        {user.photoLink ? (
                          <img
                            src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                            alt={user.name}
                            className="w-8 h-8 rounded-full"
                          />
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                              {user.name.charAt(0).toUpperCase()}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* User Info */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4] truncate">
                          {user.name}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          {user.email}
                        </div>
                      </div>

                      {/* Indicator for current user */}
                      {currentUser && currentUser.email === user.email && (
                        <div className="flex-shrink-0 ml-2">
                          <span className="text-xs text-gray-500 px-2 py-1">
                            You
                          </span>
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
            <div className="fixed left-[432px] top-0 right-0 bottom-0 z-30">
              <ChatView
                targetUser={selectedChatUser}
                currentUser={currentUser}
                onInitiateCall={initiateCall}
              />
            </div>
          ) : (
            <div className="fixed left-[432px] top-0 right-0 bottom-0 z-30 flex items-center justify-center bg-white dark:bg-[#1E1E1E]">
              <div className="text-center text-gray-500 dark:text-gray-400">
                <UsersIcon className="h-16 w-16 mx-auto mb-4 opacity-20" />
                <h3 className="text-lg font-medium mb-2">
                  No conversation selected
                </h3>
                <p className="text-sm">
                  Select a user from the list to start a conversation
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
