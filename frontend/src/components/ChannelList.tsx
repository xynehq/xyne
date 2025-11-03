import { useCallback, useEffect, useState } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { callNotificationClient } from "@/services/callNotifications"
import { Hash, Lock, Plus, Search, Archive } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { Channel } from "@/types"

interface ChannelListProps {
  currentUserId: string
  selectedChannelId?: number
  onChannelSelect: (channel: Channel) => void
  onCreateChannel: () => void
  onBrowseChannels: () => void
}

export default function ChannelList({
  currentUserId,
  selectedChannelId,
  onChannelSelect,
  onCreateChannel,
  onBrowseChannels,
}: ChannelListProps) {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [showArchived, setShowArchived] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<Map<number, number>>(
    new Map(),
  )

  // Helper to update unread counts for a specific channel
  const updateUnreadCount = useCallback(
    (channelId: number, unreadCount?: number) => {
      setUnreadCounts((prev) => {
        const next = new Map(prev)
        if (typeof unreadCount === "number" && unreadCount > 0) {
          next.set(channelId, unreadCount)
        } else {
          next.delete(channelId)
        }
        return next
      })
    },
    [],
  )

  // Fetch user's channels
  const fetchChannels = useCallback(async () => {
    setLoading(true)
    try {
      const response = await api.channels.$get({
        query: {
          includeArchived: showArchived.toString(),
        },
      })

      if (response.ok) {
        const data = await response.json()
        const fetchedChannels = data.channels || []
        setChannels(fetchedChannels)

        // Seed unread counts from backend response
        setUnreadCounts(() => {
          const counts = new Map<number, number>()
          fetchedChannels.forEach((channel: Channel) => {
            if (
              typeof channel.unreadCount === "number" &&
              channel.unreadCount > 0
            ) {
              counts.set(channel.id, channel.unreadCount)
            }
          })
          return counts
        })
      } else {
        console.error("Failed to fetch channels")
        toast({
          title: "Error",
          description: "Failed to load channels",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to fetch channels:", error)
      toast({
        title: "Error",
        description: "Failed to load channels",
        variant: "destructive",
      })
    } finally {
      setLoading(false)
    }
  }, [showArchived])

  // Load channels on mount and when showArchived changes
  useEffect(() => {
    fetchChannels()
  }, [fetchChannels])

  // Subscribe to real-time channel updates
  useEffect(() => {
    // Subscribe to channel messages to update unread counts
    const unsubscribeMessage = callNotificationClient.onChannelMessage(
      (message) => {
        // Don't count messages from current user
        if (message.sender.id !== currentUserId) {
          // If the channel is not currently selected, increment unread count
          if (message.channelId !== selectedChannelId) {
            setUnreadCounts((prev) => {
              const newCounts = new Map(prev)
              const current = newCounts.get(message.channelId) || 0
              newCounts.set(message.channelId, current + 1)
              return newCounts
            })
          }
        }
      },
    )

    // Subscribe to channel updates (name changes, archive, etc.)
    const unsubscribeUpdate = callNotificationClient.onChannelUpdate(
      (update) => {
        // Update channel in state directly if update data is available
        if (update.updateData) {
          setChannels((prevChannels) =>
            prevChannels.map((channel) =>
              channel.id === update.channelId
                ? { ...channel, ...update.updateData }
                : channel,
            ),
          )
          updateUnreadCount(update.channelId, update.updateData.unreadCount)
        } else {
          // Fallback to refetch if no update data provided
          fetchChannels()
        }
      },
    )

    // Subscribe to membership updates
    const unsubscribeMembership =
      callNotificationClient.onChannelMembershipUpdate((update) => {
        // Handle membership updates based on type
        if (update.updateType === "added" && update.channelData) {
          // User was added to a new channel - add it to the list
          setChannels((prevChannels) => {
            // Check if channel already exists
            const exists = prevChannels.some((ch) => ch.id === update.channelId)
            if (!exists) {
              return [...prevChannels, update.channelData]
            }
            return prevChannels
          })
          updateUnreadCount(update.channelId, update.channelData.unreadCount)
        } else if (update.updateType === "removed") {
          // User was removed from a channel - remove it from the list
          setChannels((prevChannels) =>
            prevChannels.filter((channel) => channel.id !== update.channelId),
          )
          updateUnreadCount(update.channelId, 0)
        } else if (update.updateType === "role_changed" && update.channelData) {
          // Role changed - update the channel with new role info
          setChannels((prevChannels) =>
            prevChannels.map((channel) =>
              channel.id === update.channelId
                ? { ...channel, ...update.channelData }
                : channel,
            ),
          )
          updateUnreadCount(update.channelId, update.channelData.unreadCount)
        } else {
          // Fallback to refetch if update type is unhandled
          fetchChannels()
        }
      })

    return () => {
      unsubscribeMessage()
      unsubscribeUpdate()
      unsubscribeMembership()
    }
  }, [currentUserId, selectedChannelId, fetchChannels, updateUnreadCount])

  // Clear unread count when channel is selected
  useEffect(() => {
    if (selectedChannelId) {
      setUnreadCounts((prev) => {
        const newCounts = new Map(prev)
        newCounts.delete(selectedChannelId)
        return newCounts
      })
    }
  }, [selectedChannelId])

  // Filter channels by search query
  const filteredChannels = channels.filter((channel) => {
    const matchesSearch =
      channel.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      channel.description?.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesSearch
  })

  // Group channels by type (single pass for better performance)
  const { publicChannels, privateChannels, archivedChannels } =
    filteredChannels.reduce(
      (acc, channel) => {
        if (channel.isArchived) {
          acc.archivedChannels.push(channel)
        } else if (channel.type === "public") {
          acc.publicChannels.push(channel)
        } else if (channel.type === "private") {
          acc.privateChannels.push(channel)
        }
        return acc
      },
      {
        publicChannels: [] as Channel[],
        privateChannels: [] as Channel[],
        archivedChannels: [] as Channel[],
      },
    )

  // Render channel item
  const renderChannel = (channel: Channel) => {
    const isSelected = channel.id === selectedChannelId
    const unreadCount = unreadCounts.get(channel.id) || 0
    const hasUnread = unreadCount > 0

    return (
      <TooltipProvider key={channel.id}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => onChannelSelect(channel)}
              className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-sm transition-colors ${
                isSelected
                  ? "bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400"
                  : "hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300"
              } ${hasUnread ? "font-medium" : "font-normal"}`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {channel.type === "private" ? (
                  <Lock className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                ) : (
                  <Hash className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
                )}
                <span className="truncate">{channel.name}</span>
                {channel.isArchived && (
                  <Archive className="h-3 w-3 text-gray-400 flex-shrink-0" />
                )}
              </div>
              {hasUnread && (
                <div className="flex-shrink-0 ml-2 bg-blue-600 text-white text-[10px] rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                  {unreadCount > 99 ? "99+" : unreadCount}
                </div>
              )}
            </button>
          </TooltipTrigger>
          {channel.description && (
            <TooltipContent side="right">
              <p className="text-xs">{channel.description}</p>
            </TooltipContent>
          )}
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <div className="h-full flex flex-col bg-white dark:bg-[#1a1a1a]">
      {/* Header */}
      <div className="px-4 py-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Channels
          </h2>
          <div className="flex items-center gap-1">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowArchived(!showArchived)}
                    className={cn(
                      "h-7 w-7 p-0 hover:bg-gray-100 dark:hover:bg-gray-800",
                      showArchived
                        ? "text-gray-900 dark:text-gray-100"
                        : "text-gray-400 dark:text-gray-600",
                    )}
                  >
                    <Archive className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{showArchived ? "Hide" : "Show"} archived</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onCreateChannel}
                    className="h-7 w-7 p-0 hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Create channel</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <Input
            type="text"
            placeholder="Search channels..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-8 h-8 text-sm bg-gray-50 dark:bg-[#2A2A2A] border-gray-200 dark:border-gray-700"
          />
        </div>
      </div>

      {/* Channel Lists */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-2 py-3 space-y-4">
          {loading ? (
            <div className="text-center text-xs text-gray-500 py-8">
              Loading channels...
            </div>
          ) : (
            <>
              {/* Browse Channels Button */}
              <div className="px-2 pb-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onBrowseChannels}
                  className="w-full justify-start h-8 text-sm font-normal text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                >
                  <Plus className="h-3.5 w-3.5 mr-2" />
                  Browse channels
                </Button>
              </div>

              {/* Public Channels */}
              {publicChannels.length > 0 && (
                <div>
                  <h3 className="px-2 mb-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Public Channels
                  </h3>
                  <div className="space-y-0.5">
                    {publicChannels.map((channel) => renderChannel(channel))}
                  </div>
                </div>
              )}

              {/* Private Channels */}
              {privateChannels.length > 0 && (
                <div>
                  <h3 className="px-2 mb-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Private Channels
                  </h3>
                  <div className="space-y-0.5">
                    {privateChannels.map((channel) => renderChannel(channel))}
                  </div>
                </div>
              )}

              {/* Archived Channels */}
              {showArchived && archivedChannels.length > 0 && (
                <div>
                  <h3 className="px-2 mb-1.5 text-[11px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                    Archived Channels
                  </h3>
                  <div className="space-y-0.5">
                    {archivedChannels.map((channel) => renderChannel(channel))}
                  </div>
                </div>
              )}

              {/* No channels message */}
              {!loading &&
                publicChannels.length === 0 &&
                privateChannels.length === 0 &&
                (!showArchived || archivedChannels.length === 0) && (
                  <div className="px-3 py-8 text-center text-xs text-gray-500">
                    {searchQuery
                      ? "No channels found"
                      : "No channels yet. Create one to get started!"}
                  </div>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
