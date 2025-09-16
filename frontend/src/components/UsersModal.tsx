import { useState, useEffect } from "react"
import { Search, Phone, Video, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { CLASS_NAMES } from "@/lib/constants"
import { Input } from "@/components/ui/input"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string
}

interface UsersModalProps {
  onClose: () => void
}

export default function UsersModal({ onClose }: UsersModalProps) {
  const [users, setUsers] = useState<User[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [currentUser, setCurrentUser] = useState<User | null>(null)

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
          photoLink: data.user.photoLink
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
        console.log("Fetched users:", data)
        const usersList = data || []
        setUsers(usersList)
        setFilteredUsers(usersList)
      } else {
        console.error("Failed to fetch users - response not ok:", response.status)
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
        query: { q: query }
      })
      if (response.ok) {
        const data = await response.json()
        setFilteredUsers(data.users || [])
      }
    } catch (error) {
      console.error("Failed to search users:", error)
      // Fallback to local filtering
      const usersList = users || []
      setFilteredUsers(usersList.filter(user => 
        user.name?.toLowerCase().includes(query.toLowerCase()) ||
        user.email?.toLowerCase().includes(query.toLowerCase())
      ))
    }
  }

  // Initiate a call
  const initiateCall = async (targetUserId: string, callType: "video" | "audio" = "video") => {
    console.log("Initiating call with targetUserId:", targetUserId, "callType:", callType)
    
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
        json: { targetUserId, callType }
      })
      
      if (response.ok) {
        const data = await response.json()
        
        // Generate both call links
        const callerLink = `${window.location.origin}/call?room=${data.roomName}&token=${data.callerToken}&type=${callType}`
        const targetLink = `${window.location.origin}/call?room=${data.roomName}&token=${data.targetToken}&type=${callType}`
        
        // Show notification status in toast
        const notificationStatus = data.notificationSent 
          ? `✅ Real-time notification sent to ${data.target.name}!`
          : `⚠️ ${data.target.name} is offline - share the link manually`
        
        // Show a detailed toast with both links
        toast({
          title: "Call Initiated!",
          description: (
            <div className="space-y-2">
              <p>Room created for {data.target.name}</p>
              <p className="text-sm font-medium text-blue-600">{notificationStatus}</p>
              <div className="text-xs space-y-1">
                <p className="font-medium">Your call link (auto-opening):</p>
                <p className="bg-gray-100 p-1 rounded text-xs break-all">{callerLink}</p>
                <p className="font-medium">Share this link with {data.target.name}:</p>
                <p className="bg-blue-100 p-1 rounded text-xs break-all">{targetLink}</p>
              </div>
              <button 
                onClick={() => navigator.clipboard.writeText(targetLink)}
                className="text-xs bg-blue-500 text-white px-2 py-1 rounded"
              >
                Copy Target Link
              </button>
            </div>
          ),
          duration: 15000, // Show for 15 seconds
        })
        
        // Open the caller's window
        const callWindow = window.open(
          callerLink,
          "call-window-caller",
          "width=800,height=600,resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no"
        )
        
        if (!callWindow) {
          toast({
            title: "Popup Blocked",
            description: "Please allow popups to make calls",
            variant: "destructive",
          })
        }
        
        // Also log the links to console for easy access
        console.log("=== CALL INITIATED ===")
        console.log("Caller Link:", callerLink)
        console.log("Target Link (share this):", targetLink)
        console.log("Room Name:", data.roomName)
        console.log("=====================")
        
        // For testing: open both windows (comment out in production)
        if (process.env.NODE_ENV === 'development') {
          setTimeout(() => {
            const targetWindow = window.open(
              targetLink,
              "call-window-target",
              "width=800,height=600,resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no"
            )
            if (targetWindow) {
              console.log("Opened target window for testing")
            }
          }, 2000) // Open target window 2 seconds after caller window
        }
        
        onClose()
      } else {
        try {
          const errorData = await response.json()
          console.error("API Error:", errorData)
          toast({
            title: "Call Failed",
            description: errorData.message || errorData.error?.message || "Failed to initiate call",
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
    <div
      className={cn(
        "fixed left-[52px] top-4 bottom-4 w-80 bg-white dark:bg-[#1E1E1E] border border-[#D7E0E9] dark:border-gray-700 rounded-lg shadow-lg z-30 flex flex-col",
        CLASS_NAMES.HISTORY_MODAL_CONTAINER // Reuse the same class name for consistent styling
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
          <X size={16} stroke="#384049" className="dark:stroke-[#F1F3F4]" />
        </button>
      </div>

      {/* Search */}
      <div className="p-4 border-b border-[#D7E0E9] dark:border-gray-700">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
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
                className="flex items-center p-3 hover:bg-[#D8DFE680] dark:hover:bg-gray-700 rounded-lg group"
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

                {/* Call Buttons */}
                <div className="flex-shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  {currentUser && currentUser.email === user.email ? (
                    <div className="text-xs text-gray-500 px-2 py-1">
                      You
                    </div>
                  ) : (
                    <div className="flex space-x-1">
                      <button
                        onClick={() => initiateCall(user.id, "audio")}
                        className="p-1.5 hover:bg-green-100 dark:hover:bg-green-900 rounded text-green-600 dark:text-green-400"
                        title="Audio Call"
                      >
                        <Phone size={14} />
                      </button>
                      <button
                        onClick={() => initiateCall(user.id, "video")}
                        className="p-1.5 hover:bg-blue-100 dark:hover:bg-blue-900 rounded text-blue-600 dark:text-blue-400"
                        title="Video Call"
                      >
                        <Video size={14} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
