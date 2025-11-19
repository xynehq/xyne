import React, { useState, useEffect } from "react"
import { workflowToolsAPI } from "../api/ApiHandlers"
import { X } from "lucide-react"

export interface SlackChannel {
  id: string
  name: string
}

export interface SlackChannelInputProps {
  selectedChannels: string[]
  onChannelsChange: (channels: string[]) => void
  allowAll?: boolean // Allow "all" option for triggers
  placeholder?: string
  className?: string
}

export const SlackChannelInput: React.FC<SlackChannelInputProps> = ({
  selectedChannels,
  onChannelsChange,
  allowAll = false,
  placeholder = "Type channel name",
  className = "",
}) => {
  const [channels, setChannels] = useState<SlackChannel[]>([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreChannels, setHasMoreChannels] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [channelInput, setChannelInput] = useState("")
  const [showSuggestions, setShowSuggestions] = useState(false)

  // Fetch initial channels when component mounts
  useEffect(() => {
    const fetchInitialChannels = async () => {
      try {
        setChannelsLoading(true)
        setChannels([]) // Reset channels
        setNextCursor(undefined) // Reset pagination
        
        const result = await workflowToolsAPI.fetchSlackMetadata()
        
        setChannels(result.channels)
        setHasMoreChannels(result.hasMore)
        setNextCursor(result.nextCursor)
      } catch (error) {
        console.error("Failed to fetch Slack channels:", error)
      } finally {
        setChannelsLoading(false)
      }
    }

    fetchInitialChannels()
  }, [showSuggestions])

  // Load more channels when user scrolls to bottom
  const loadMoreChannels = async () => {
    if (!hasMoreChannels || loadingMore || !nextCursor) return

    try {
      setLoadingMore(true)
      const result = await workflowToolsAPI.fetchSlackMetadata(nextCursor)
      
      setChannels(prev => [...prev, ...result.channels])
      setHasMoreChannels(result.hasMore)
      setNextCursor(result.nextCursor)
    } catch (error) {
      console.error("Failed to load more channels:", error)
    } finally {
      setLoadingMore(false)
    }
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (showSuggestions && !target.closest('.slack-channel-input')) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showSuggestions])

  const handleChannelSelect = (channel: SlackChannel | "all") => {
    // Multi-select mode only
    const channelId = channel === "all" ? "all" : channel.id

    // Check if already added
    if (selectedChannels.includes(channelId)) {
      return
    }

    // If adding "all", replace all existing channels with just "all"
    if (channelId === "all") {
      onChannelsChange(["all"])
    } else {
      // Add individual channel ID
      onChannelsChange([...selectedChannels, channelId])
    }

    setChannelInput("")
    setShowSuggestions(false)
  }

  const handleRemoveChannel = (channel: string) => {
    onChannelsChange(selectedChannels.filter(ch => ch !== channel))
  }

  const handleChannelInputChange = (value: string) => {
    setChannelInput(value)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Prevent adding channels on Enter - users must select from dropdown
    if (e.key === "Enter") {
      e.preventDefault()
    }
  }

  // Filter channels based on input
  const filteredChannels = channels.filter(channel =>
    channel.name.toLowerCase().includes(channelInput.toLowerCase().replace('#', ''))
  )

  return (
    <div className={`space-y-2 ${className}`}>
      {/* Channel Input with Autocomplete */}
      <div className="relative slack-channel-input">
          <input
            type="text"
            value={channelInput}
            onChange={(e) => handleChannelInputChange(e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setShowSuggestions(true)}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-gray-900 dark:text-gray-300"
          />

          {/* Autocomplete Suggestions */}
          {showSuggestions && (!allowAll || !selectedChannels.includes("all")) && (
            <div 
              className="absolute z-10 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-y-auto"
              onScroll={(e) => {
                const element = e.currentTarget
                if (element.scrollTop + element.clientHeight >= element.scrollHeight - 5) {
                  loadMoreChannels()
                }
              }}
            >
              {/* "All" Option */}
              {allowAll && (
                <button
                  onClick={() => handleChannelSelect("all")}
                  className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    all
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Listen to all channels
                  </div>
                </button>
              )}

              {/* Channel Suggestions */}
              {channelsLoading ? (
                <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                  Loading channels...
                </div>
              ) : filteredChannels.length === 0 ? (
                <div className="px-3 py-4 text-center text-sm text-gray-500 dark:text-gray-400">
                  No matching channels
                </div>
              ) : (
                <>
                  {filteredChannels.map((channel) => (
                    <button
                      key={channel.id}
                      onClick={() => handleChannelSelect(channel)}
                      className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                    >
                      <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        #{channel.name}
                      </div>
                    </button>
                  ))}
                  
                  {/* Load more indicator */}
                  {hasMoreChannels && (
                    <div className="px-3 py-2 text-center">
                      {loadingMore ? (
                        <div className="text-sm text-gray-500 dark:text-gray-400">
                          Loading more channels...
                        </div>
                      ) : (
                        <button
                          onClick={loadMoreChannels}
                          className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Load more...
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

      {/* Selected Channels List */}
      {selectedChannels.length > 0 && (
        <div className="space-y-2 mt-4">
          {selectedChannels.map((channelId) => {
            // Find the channel name from the ID
            const channelName = channelId === "all"
              ? "all"
              : channels.find(ch => ch.id === channelId)?.name || channelId

            return (
              <div
                key={channelId}
                className="flex items-center justify-between p-1 bg-gray-50 dark:bg-gray-800 rounded-lg w-fit"
              >
                <div className="text-xs font-medium text-slate-900 dark:text-gray-300">
                  {channelId === "all" ? "all" : `#${channelName}`}
                </div>
                <button
                  onClick={() => handleRemoveChannel(channelId)}
                  className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                >
                  <X className="w-4 h-4 text-gray-400 dark:text-gray-500" />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default SlackChannelInput
