import { useState, useEffect } from "react"
import { api } from "@/api"
import { toast } from "@/hooks/use-toast"
import { Hash, Lock, Users, Search, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { Channel } from "@/types"

interface BrowseChannelsProps {
  isOpen: boolean
  onClose: () => void
  onChannelJoined: (channelId: number) => void
}

export default function BrowseChannels({
  isOpen,
  onClose,
  onChannelJoined,
}: BrowseChannelsProps) {
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [joiningChannelId, setJoiningChannelId] = useState<number | null>(null)

  // Fetch public channels
  const fetchChannels = async () => {
    setLoading(true)
    try {
      const response = await api.channels["browse"].$get()

      if (response.ok) {
        const data = await response.json()
        setChannels(data.channels || [])
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
  }

  // Load channels when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchChannels()
      setSearchQuery("")
    }
  }, [isOpen])

  // Join a channel
  const handleJoinChannel = async (channelId: number, channelName: string) => {
    setJoiningChannelId(channelId)

    try {
      const response = await api.channels.join.$post({
        json: { channelId },
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Joined #${channelName}`,
        })
        onChannelJoined(channelId)
        onClose()
      } else {
        const error = await response.json()
        toast({
          title: "Error",
          description: error.message || "Failed to join channel",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Failed to join channel:", error)
      toast({
        title: "Error",
        description: "Failed to join channel",
        variant: "destructive",
      })
    } finally {
      setJoiningChannelId(null)
    }
  }

  // Filter channels by search query
  const lowercasedQuery = searchQuery.toLowerCase()
  const filteredChannels = channels.filter(
    (channel) =>
      channel.name.toLowerCase().includes(lowercasedQuery) ||
      channel.description?.toLowerCase().includes(lowercasedQuery) ||
      channel.purpose?.toLowerCase().includes(lowercasedQuery),
  )

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Browse channels</DialogTitle>
          <DialogDescription>
            Discover and join public channels in your workspace
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              type="text"
              placeholder="Search channels..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Channels list */}
          {loading ? (
            <div className="text-center py-12 text-gray-500">
              Loading channels...
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {searchQuery
                ? "No channels found matching your search"
                : "No public channels available to join"}
            </div>
          ) : (
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {filteredChannels.map((channel) => {
                const isJoining = joiningChannelId === channel.id

                return (
                  <div
                    key={channel.id}
                    className="flex items-start gap-4 p-4 rounded-lg border hover:border-blue-300 dark:hover:border-blue-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    {/* Channel icon */}
                    <div className="h-12 w-12 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center flex-shrink-0">
                      {channel.type === "private" ? (
                        <Lock className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                      ) : (
                        <Hash className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                      )}
                    </div>

                    {/* Channel info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <h3 className="font-semibold text-lg">
                          #{channel.name}
                        </h3>
                        <Button
                          onClick={() =>
                            handleJoinChannel(channel.id, channel.name)
                          }
                          disabled={isJoining}
                          size="sm"
                        >
                          {isJoining ? (
                            "Joining..."
                          ) : (
                            <>
                              Join
                              <ArrowRight className="h-4 w-4 ml-1" />
                            </>
                          )}
                        </Button>
                      </div>

                      {/* Description */}
                      {channel.description && (
                        <p className="text-sm text-gray-700 dark:text-gray-300 mb-2">
                          {channel.description}
                        </p>
                      )}

                      {/* Purpose */}
                      {channel.purpose && (
                        <p className="text-sm text-gray-500 italic mb-2">
                          Purpose: {channel.purpose}
                        </p>
                      )}

                      {/* Metadata */}
                      <div className="flex items-center gap-4 text-xs text-gray-500">
                        <div className="flex items-center gap-1">
                          <Users className="h-3 w-3" />
                          <span>
                            {channel.memberCount || 0} member
                            {channel.memberCount !== 1 ? "s" : ""}
                          </span>
                        </div>

                        {channel.type === "private" && (
                          <div className="flex items-center gap-1">
                            <Lock className="h-3 w-3" />
                            <span>Private</span>
                          </div>
                        )}

                        <div>
                          Created{" "}
                          {new Date(channel.createdAt).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Results count */}
          {!loading && filteredChannels.length > 0 && (
            <div className="text-sm text-gray-500 pt-2 border-t">
              Showing {filteredChannels.length} channel
              {filteredChannels.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
