import React from 'react'
import { X as LucideX } from 'lucide-react'

interface FilterBadgeProps {
  filters: string[]
  onRemoveFilter: (index: number) => void
  idToNameMap?: Record<string, string>
}

export const FilterBadge: React.FC<FilterBadgeProps> = ({
  filters,
  onRemoveFilter,
  idToNameMap = {},
}) => {
  // Helper function to get display text for a filter part
  const getDisplayText = (part: string): string => {
    // Check if it's a Slack person (@ID) or channel (#ID)
    if (part.startsWith('@')) {
      const id = part.substring(1)
      const name = idToNameMap[id]
      return name ? `@${name}` : part
    } else if (part.startsWith('#')) {
      const id = part.substring(1)
      const name = idToNameMap[id]
      return name ? `#${name}` : part
    }
    // For other filters (emails, timelines, etc.), return as-is
    return part
  }

  if (!filters || filters.length === 0) {
    return (
      <input
        type="text"
        placeholder='Add filters'
        className="flex-1 bg-transparent border-0 outline-none text-sm text-gray-700 dark:text-gray-200 placeholder-gray-400 min-w-[100px] focus:outline-none focus:ring-0"
        readOnly
      />
    )
  }

  return (
    <>
      {filters.map((part, idx) => (
        <div
          key={idx}
          className="inline-flex items-center gap-1.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-2.5 py-1 rounded-md text-sm"
        >
          <span>{getDisplayText(part)}</span>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onRemoveFilter(idx)
            }}
            className="hover:bg-gray-200 dark:hover:bg-gray-600 rounded-sm p-0.5"
          >
            <LucideX className="h-3 w-3" />
          </button>
        </div>
      ))}
    </>
  )
}
