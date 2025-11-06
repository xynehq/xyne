import React, { useState, useEffect } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useSlackData } from '@/hooks/useSlackData'
import { SlackEntity } from 'shared/types'

interface SlackChannelFilterProps {
  filterValue?: string
  onFilterChange: (value: string) => void
  onUpdateNameMapping?: (id: string, name: string) => void
}

export const SlackChannelFilter: React.FC<SlackChannelFilterProps> = ({
  filterValue,
  onFilterChange,
  onUpdateNameMapping,
}) => {
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())

  const {
    items: slackChannels,
    searchQuery,
    isLoading,
    containerRef,
    handleSearch,
    handleScroll,
    fetchItems,
  } = useSlackData({ entity: SlackEntity.Channel })

  // Load initial channels on mount
  useEffect(() => {
    fetchItems('', 0, false)
  }, [fetchItems])

  // Parse existing filter values to set selected channels
  useEffect(() => {
    if (!filterValue) return

    const filters = filterValue.split(', ').filter(f => f.trim())
    const channelIds = filters.filter(f => f.startsWith('#')).map(f => f.substring(1))

    setSelectedChannels(new Set(channelIds))
  }, [filterValue])

  const handleChannelSelect = (channel: { id: string; name: string }) => {
    const updatedChannels = new Set(selectedChannels)
    if (updatedChannels.has(channel.id)) {
      updatedChannels.delete(channel.id)
    } else {
      updatedChannels.add(channel.id)
      // Update the ID-to-name mapping when selecting a channel
      onUpdateNameMapping?.(channel.id, channel.name)
    }
    setSelectedChannels(updatedChannels)

    // Build filter string from selected channels
    const selectedChannelIds = Array.from(updatedChannels).map(id => `#${id}`)

    // Preserve existing filters from current filterValue that aren't channel filters
    const currentFilters = filterValue?.split(', ').filter(f => f.trim()) || []
    const existingNonChannelFilters = currentFilters.filter(f => !f.startsWith('#'))

    // Combine new channel filters with existing non-channel filters
    const combinedFilters = [...selectedChannelIds, ...existingNonChannelFilters]

    onFilterChange(combinedFilters.join(', '))
  }

  return (
    <>
      <div className="px-4 py-2 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center">
          <input
            type="text"
            placeholder="Search"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
          />
        </div>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="px-2 max-h-60 overflow-y-auto"
      >
        {isLoading && slackChannels.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
            Loading channels...
          </div>
        ) : slackChannels.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
            No channels found
          </div>
        ) : (
          <>
            {slackChannels.map((channel: { id: string; name: string }) => (
              <DropdownMenuItem
                key={channel.id}
                onSelect={(e) => {
                  e.preventDefault()
                  handleChannelSelect(channel)
                }}
                className="flex items-center cursor-pointer text-sm py-2 px-2 hover:!bg-gray-100 dark:hover:!bg-gray-700 focus:!bg-gray-100 dark:focus:!bg-gray-700 data-[highlighted]:!bg-gray-100 dark:data-[highlighted]:!bg-gray-700 rounded"
              >
                <input
                  type="checkbox"
                  className="mr-3"
                  checked={selectedChannels.has(channel.id)}
                  onChange={() => {}}
                />
                <span className="text-gray-700 dark:text-gray-200">{channel.name}</span>
              </DropdownMenuItem>
            ))}
            {isLoading && (
              <div className="text-center py-2 text-sm text-gray-500 dark:text-gray-400">
                Loading more...
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}
