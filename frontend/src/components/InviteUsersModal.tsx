import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { X, UserPlus, Search, Phone, Video } from "lucide-react"
import { api } from "@/api"
import { useToast } from "@/hooks/use-toast"
import { CallType } from "@/types"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string | null
}

interface InviteUsersModalProps {
  isOpen: boolean
  onClose: () => void
  callId: string
  callType: CallType
}

export function InviteUsersModal({
  isOpen,
  onClose,
  callId,
  callType,
}: InviteUsersModalProps) {
  const [users, setUsers] = useState<User[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [filteredUsers, setFilteredUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [invitingUsers, setInvitingUsers] = useState<Set<string>>(new Set())
  const { toast } = useToast()

  // Fetch workspace users
  useEffect(() => {
    if (isOpen) {
      fetchUsers()
    }
  }, [isOpen])

  // Filter users based on search query
  useEffect(() => {
    if (searchQuery.trim()) {
      const filtered = users.filter(
        (user) =>
          user.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          user.email.toLowerCase().includes(searchQuery.toLowerCase()),
      )
      setFilteredUsers(filtered)
    } else {
      setFilteredUsers(users)
    }
  }, [searchQuery, users])

  const fetchUsers = async () => {
    try {
      setLoading(true)
      const response = await api.workspace.users.$get()

      if (response.ok) {
        const data = await response.json()
        setUsers(data || [])
      }
    } catch (error) {
      console.error("Error fetching users:", error)
      toast({
        title: "Error",
        description: "Failed to load users",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  const inviteUser = async (user: User) => {
    try {
      setInvitingUsers((prev) => new Set(prev.add(user.id)))

      const response = await api.calls.invite.$post({
        json: {
          callId,
          targetUserId: user.id,
          callType,
        },
      })

      if (response.ok) {
        const data = await response.json()
        const notificationStatus = data.notificationSent
          ? `✅ Invitation sent to ${user.name}!`
          : `⚠️ ${user.name} is offline - they won't receive the real-time notification`

        toast({
          title: "User Invited!",
          description: notificationStatus,
        })
      } else {
        throw new Error("Failed to invite user")
      }
    } catch (error) {
      console.error("Error inviting user:", error)
      toast({
        title: "Error",
        description: `Failed to invite ${user.name}`,
        variant: "destructive",
      })
    } finally {
      setInvitingUsers((prev) => {
        const newSet = new Set(prev)
        newSet.delete(user.id)
        return newSet
      })
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md mx-auto bg-white dark:bg-gray-800 shadow-2xl animate-in fade-in-0 zoom-in-95 duration-300">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-lg font-semibold">
            <UserPlus className="inline mr-2 h-5 w-5" />
            Invite People to Call
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-8 w-8 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Call Type Indicator */}
          <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
            {callType === "video" ? (
              <Video className="h-4 w-4" />
            ) : (
              <Phone className="h-4 w-4" />
            )}
            <span className="capitalize">{callType} call invitation</span>
          </div>

          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              type="text"
              placeholder="Search users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Users List */}
          <div className="max-h-64 overflow-y-auto space-y-2">
            {loading ? (
              <div className="text-center py-4 text-gray-500">
                Loading users...
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="text-center py-4 text-gray-500">
                {searchQuery ? "No users found" : "No users available"}
              </div>
            ) : (
              filteredUsers.map((user) => (
                <div
                  key={user.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="flex items-center space-x-3 flex-1 min-w-0">
                    {/* User Avatar */}
                    <div className="h-10 w-10 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-semibold flex-shrink-0">
                      {user.photoLink ? (
                        <img
                          src={user.photoLink}
                          alt={user.name}
                          className="h-10 w-10 rounded-full object-cover"
                        />
                      ) : (
                        user.name
                          .split(" ")
                          .filter((n) => n.length > 0)
                          .map((n) => n[0]?.toUpperCase() || "")
                          .slice(0, 2)
                          .join("")
                      )}
                    </div>

                    {/* User Info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {user.name}
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                        {user.email}
                      </div>
                    </div>
                  </div>

                  {/* Invite Button */}
                  <Button
                    onClick={() => inviteUser(user)}
                    disabled={invitingUsers.has(user.id)}
                    size="sm"
                    className="ml-2 flex-shrink-0"
                  >
                    {invitingUsers.has(user.id) ? (
                      <>
                        <div className="h-3 w-3 animate-spin rounded-full border border-white border-t-transparent mr-1" />
                        Inviting...
                      </>
                    ) : (
                      <>
                        <UserPlus className="h-3 w-3 mr-1" />
                        Invite
                      </>
                    )}
                  </Button>
                </div>
              ))
            )}
          </div>

          {/* Instructions */}
          <div className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-700 p-3 rounded-lg">
            💡 Invited users will receive a real-time notification if they're
            online, or they can join using the call link.
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
