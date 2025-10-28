import { useState, useEffect } from "react"
import { Phone, Video, Search, ChevronDown } from "lucide-react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CallType } from "@/types"

interface User {
  id: string
  name: string
  email: string
  photoLink?: string
}

interface CallRecord {
  id: string
  callId: string
  roomLink: string
  callType: string
  startedAt: string
  endedAt: string | null
  duration: number | null
  createdBy: User | null
  participants: User[]
  invitedUsers: User[]
}

type FilterType = "all" | CallType | "missed"
type TimeFilter = "all" | "today" | "week" | "month"

export default function CallHistory() {
  const [calls, setCalls] = useState<CallRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [filterType, setFilterType] = useState<FilterType>("all")
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null)
  const [isParticipantsModalOpen, setIsParticipantsModalOpen] = useState(false)

  // Initial load
  useEffect(() => {
    const loadData = async () => {
      await fetchCurrentUser()
      fetchCallHistory()
    }
    loadData()
  }, [])

  // Refetch when filters change (debounce search query)
  useEffect(() => {
    if (!currentUserId) return

    // Debounce search query to avoid too many API calls
    const timeoutId = setTimeout(
      () => {
        fetchCallHistory()
      },
      searchQuery ? 300 : 0,
    ) // 300ms delay for search, instant for other filters

    return () => clearTimeout(timeoutId)
  }, [filterType, timeFilter, searchQuery])

  const fetchCurrentUser = async () => {
    try {
      const response = await api.me.$get()
      if (response.ok) {
        const data = await response.json()
        setCurrentUserId(data.user.externalId)
      }
    } catch (error) {
      console.error("Failed to fetch current user:", error)
    }
  }

  const fetchCallHistory = async () => {
    setLoading(true)
    try {
      // Build query parameters
      const params: Record<string, string> = {}

      if (filterType !== "all") {
        params.callType = filterType
      }

      if (timeFilter !== "all") {
        params.timeFilter = timeFilter
      }

      if (searchQuery.trim()) {
        params.search = searchQuery.trim()
      }

      const response = await api.calls.history.$get({
        query: params,
      })

      if (response.ok) {
        const data = await response.json()
        setCalls(data.calls || [])
      } else {
        toast({
          title: "Error",
          description: "Failed to fetch call history",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to fetch call history:", error)
      toast({
        title: "Error",
        description: "Failed to fetch call history",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }

  // Check if the current user missed a call (was invited but didn't join)
  const didCurrentUserMissCall = (call: CallRecord) => {
    if (!currentUserId) return false
    const wasInvited = call.invitedUsers.some((u) => u.id === currentUserId)
    const didParticipate = call.participants.some((p) => p.id === currentUserId)
    return wasInvited && !didParticipate
  }

  // Join an active call
  const handleJoinCall = async (call: CallRecord) => {
    try {
      const callUrl = `${window.location.origin}/call/${call.callId}?type=${call.callType}`

      // Open the call in a new window
      const callWindow = window.open(
        callUrl,
        "call-window",
        "width=800,height=600,resizable=yes,scrollbars=no,status=no,location=no,toolbar=no,menubar=no",
      )

      if (!callWindow) {
        toast({
          title: "Popup Blocked",
          description: "Please allow popups to join calls",
          variant: "destructive",
        })
      } else {
        toast({
          title: "Joining Call",
          description: "Opening call window...",
        })
      }
    } catch (error) {
      console.error("Error joining call:", error)
      toast({
        title: "Error",
        description: "Failed to join call. Please try again.",
        variant: "destructive",
      })
    }
  }

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return "—"
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}m ${secs}s`
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    const now = new Date()
    const diffInMs = now.getTime() - date.getTime()
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24))

    if (diffInDays === 0) {
      return `Today at ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
    } else if (diffInDays === 1) {
      return `Yesterday at ${date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`
    } else if (diffInDays < 7) {
      return `${diffInDays} days ago`
    } else {
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
      })
    }
  }

  return (
    <div className="flex-1 bg-white dark:bg-[#1E1E1E] flex flex-col h-full">
      {/* Header */}
      <div className="border-b border-[#D7E0E9] dark:border-gray-700 px-6 py-4">
        <h1 className="text-2xl font-semibold text-[#384049] dark:text-[#F1F3F4] mb-1">
          Call History
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          View all your past huddles and calls
        </p>
      </div>

      {/* Filters */}
      <div className="px-6 py-4 border-b border-[#D7E0E9] dark:border-gray-700 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="flex-1 min-w-[280px] relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            placeholder="Search by participant name..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 border border-[#D7E0E9] dark:border-gray-700 rounded-lg bg-white dark:bg-[#2A2A2A] text-sm text-[#384049] dark:text-[#F1F3F4] placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Call Type Filter */}
        <div className="relative">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as FilterType)}
            className="appearance-none pl-4 pr-10 py-2 border border-[#D7E0E9] dark:border-gray-700 rounded-lg bg-white dark:bg-[#2A2A2A] text-sm text-[#384049] dark:text-[#F1F3F4] focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            <option value="all">All Calls</option>
            <option value="video">Video Calls</option>
            <option value="audio">Audio Calls</option>
            <option value="missed">Missed Calls</option>
          </select>
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
        </div>

        {/* Time Filter */}
        <div className="relative">
          <select
            value={timeFilter}
            onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
            className="appearance-none pl-4 pr-10 py-2 border border-[#D7E0E9] dark:border-gray-700 rounded-lg bg-white dark:bg-[#2A2A2A] text-sm text-[#384049] dark:text-[#F1F3F4] focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
          >
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="week">This Week</option>
            <option value="month">This Month</option>
          </select>
          <ChevronDown
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
          />
        </div>
      </div>

      {/* Call List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-gray-500">Loading call history...</div>
          </div>
        ) : calls.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <div className="w-16 h-16 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-4">
              <Phone size={32} className="text-gray-400 dark:text-gray-500" />
            </div>
            <p className="text-lg text-[#384049] dark:text-[#F1F3F4] font-medium mb-2">
              {searchQuery || filterType !== "all" || timeFilter !== "all"
                ? "No calls found"
                : "No calls yet"}
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400 max-w-md">
              {searchQuery || filterType !== "all" || timeFilter !== "all"
                ? "Try adjusting your filters to see more results"
                : "Your call history will appear here once you make your first call"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {calls.map((call) => {
              const isMissed = didCurrentUserMissCall(call)
              const primaryUser = call.createdBy || call.participants[0]
              const allUsers =
                call.participants.length > 0
                  ? call.participants
                  : call.invitedUsers
              const displayLimit = 4
              const visibleUsers = allUsers.slice(0, displayLimit)
              const remainingCount = allUsers.length - displayLimit

              return (
                <div
                  key={call.id}
                  className="px-6 py-3 hover:bg-gray-50 dark:hover:bg-[#2A2A2A] transition-colors"
                >
                  <div className="flex items-center justify-between gap-4">
                    {/* Left: Icon + Name + Info */}
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {/* Call Type Icon */}
                      <div
                        className={`flex-shrink-0 ${isMissed ? "text-red-500 dark:text-red-400" : "text-gray-400 dark:text-gray-500"}`}
                      >
                        {call.callType === "video" ? (
                          <Video size={20} />
                        ) : (
                          <Phone size={20} />
                        )}
                      </div>

                      {/* Name and Details */}
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4] truncate">
                          {primaryUser?.name || "Unknown"}
                          {allUsers.length > 1 && (
                            <span className="text-[#384049] dark:text-[#F1F3F4] font-medium">
                              {", "}
                              {allUsers
                                .slice(1, 2)
                                .map((u) => u?.name)
                                .join(", ")}
                              {allUsers.length > 2 && (
                                <span className="text-xs ml-1">
                                  +{allUsers.length - 2} other
                                  {allUsers.length - 2 > 1 ? "s" : ""}
                                </span>
                              )}
                            </span>
                          )}
                        </h3>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span
                            className={`text-xs ${isMissed ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"}`}
                          >
                            {formatDate(call.startedAt)}
                          </span>
                          <span className="text-xs text-gray-400">•</span>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {call.duration !== null
                              ? formatDuration(call.duration)
                              : "Active"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Right: Join Button (if active) or Participant Avatars */}
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* Show Join button for active calls */}
                      {call.endedAt === null && (
                        <Button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleJoinCall(call)
                          }}
                          size="sm"
                          className="bg-green-600 hover:bg-green-700 text-white font-medium px-4 py-2 h-8"
                        >
                          Join
                        </Button>
                      )}

                      {/* Participant Avatars */}
                      <div
                        className="flex -space-x-2 cursor-pointer"
                        onClick={() => {
                          setSelectedCall(call)
                          setIsParticipantsModalOpen(true)
                        }}
                      >
                        {visibleUsers.map((user, index) => (
                          <div
                            key={user?.id || index}
                            className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 border-2 border-white dark:border-[#1E1E1E] overflow-hidden hover:scale-110 transition-transform"
                            title={user?.name}
                          >
                            {user?.photoLink ? (
                              <img
                                src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                                alt={user.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-300">
                                {user?.name?.charAt(0).toUpperCase()}
                              </div>
                            )}
                          </div>
                        ))}
                        {remainingCount > 0 && (
                          <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 border-2 border-white dark:border-[#1E1E1E] flex items-center justify-center hover:scale-110 transition-transform">
                            <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                              +{remainingCount}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Participants Modal */}
      <Dialog
        open={isParticipantsModalOpen}
        onOpenChange={setIsParticipantsModalOpen}
      >
        <DialogContent className="sm:max-w-md bg-white dark:bg-[#1E1E1E] border-gray-200 dark:border-gray-700">
          <DialogHeader>
            <DialogTitle className="text-xl font-semibold text-[#384049] dark:text-[#F1F3F4]">
              {selectedCall?.createdBy?.name || "Unknown"}
            </DialogTitle>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              {selectedCall &&
                `You huddled here with ${selectedCall.createdBy?.name || "Unknown"} for ${
                  selectedCall.endedAt
                    ? formatDuration(selectedCall.duration)
                    : "Active"
                }`}
            </p>
          </DialogHeader>

          <div className="mt-6 space-y-3">
            {selectedCall?.participants.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-[#2A2A2A] transition-colors"
              >
                <div className="w-12 h-12 rounded-lg overflow-hidden bg-gray-200 dark:bg-gray-700 flex-shrink-0">
                  {user?.photoLink ? (
                    <img
                      src={`/api/v1/proxy/${encodeURIComponent(user.photoLink)}`}
                      alt={user.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-lg font-medium text-gray-600 dark:text-gray-300">
                      {user?.name?.charAt(0).toUpperCase()}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-medium text-[#384049] dark:text-[#F1F3F4] truncate">
                    {user.name}
                    {user.id === currentUserId && (
                      <span className="text-gray-500 dark:text-gray-400 font-normal">
                        {" "}
                        (you)
                      </span>
                    )}
                  </h4>
                  <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                    {user.email}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
