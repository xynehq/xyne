import { useState, useEffect } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string
}

interface NewChatModalProps {
  onClose: () => void
  onSelectUser: (user: User) => void
  currentUserEmail?: string
}

export default function NewChatModal({
  onClose,
  onSelectUser,
  currentUserEmail,
}: NewChatModalProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<User[]>([])
  const [loading, setLoading] = useState(false)

  // Search workspace users
  const searchUsers = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([])
      return
    }

    setLoading(true)
    try {
      const response = await api.workspace.users.search.$get({
        query: { q: query },
      })
      if (response.ok) {
        const data = await response.json()
        setSearchResults(data.users || [])
      }
    } catch (error) {
      console.error("Failed to search users:", error)
      toast({
        title: "Error",
        description: "Failed to search users",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Debounced search
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      searchUsers(searchQuery)
    }, 300)

    return () => clearTimeout(timeoutId)
  }, [searchQuery])

  const handleUserSelect = (user: User) => {
    // Allow selecting yourself to create a DM with yourself
    onSelectUser(user)
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-[#1E1E1E] rounded-lg w-full max-w-md mx-4 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[#D7E0E9] dark:border-gray-700">
          <h2 className="text-lg font-semibold text-[#384049] dark:text-[#F1F3F4]">
            New Message
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
            <Search
              size={16}
              className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400"
            />
            <Input
              placeholder="Search workspace users..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              autoFocus
            />
          </div>
        </div>

        {/* Search Results */}
        <div className="max-h-96 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center h-20">
              <div className="text-sm text-gray-500">Searching...</div>
            </div>
          ) : !searchQuery ? (
            <div className="flex items-center justify-center h-20">
              <div className="text-sm text-gray-500">
                Start typing to search users
              </div>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex items-center justify-center h-20">
              <div className="text-sm text-gray-500">No users found</div>
            </div>
          ) : (
            <div className="space-y-1">
              {searchResults.map((user) => (
                <div
                  key={user.id}
                  onClick={() => handleUserSelect(user)}
                  className="flex items-center p-3 rounded-lg transition-colors hover:bg-[#D8DFE680] dark:hover:bg-gray-700 cursor-pointer"
                >
                  {/* User Avatar */}
                  <div className="flex-shrink-0 mr-3">
                    {user.photoLink ? (
                      <img
                        src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                        alt={user.name}
                        className="w-10 h-10 rounded-full"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-300">
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

                  {/* Current user indicator */}
                  {currentUserEmail && currentUserEmail === user.email && (
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
    </div>
  )
}
