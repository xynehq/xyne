import React, { useState, useEffect } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useSlackData } from '@/hooks/useSlackData'
import { SlackEntity } from 'shared/types'

interface SlackPeopleFilterProps {
  filterValue?: string
  onFilterChange: (value: string) => void
  onUpdateNameMapping?: (id: string, name: string) => void
}

export const SlackPeopleFilter: React.FC<SlackPeopleFilterProps> = ({
  filterValue,
  onFilterChange,
  onUpdateNameMapping,
}) => {
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set())

  const {
    items: slackUsers,
    searchQuery,
    isLoading,
    containerRef,
    handleSearch,
    handleScroll,
    fetchItems,
  } = useSlackData({ entity: SlackEntity.User })

  // Load initial users on mount
  useEffect(() => {
    fetchItems('', 0, false)
  }, [fetchItems])

  // Parse existing filter values to set selected people
  useEffect(() => {
    if (!filterValue) return

    const filters = filterValue.split(', ').filter(f => f.trim())
    const peopleIds = filters.filter(f => f.startsWith('@')).map(f => f.substring(1))

    setSelectedPeople(new Set(peopleIds))
  }, [filterValue])

  const handlePersonSelect = (person: { id: string; name: string }) => {
    const updatedPeople = new Set(selectedPeople)
    if (updatedPeople.has(person.id)) {
      updatedPeople.delete(person.id)
    } else {
      updatedPeople.add(person.id)
      // Update the ID-to-name mapping when selecting a person
      onUpdateNameMapping?.(person.id, person.name)
    }
    setSelectedPeople(updatedPeople)

    // Build filter string from selected people using docIds (same as channels)
    const selectedPeopleIds = Array.from(updatedPeople).map(id => `@${id}`)

    // Preserve existing filters from current filterValue that aren't people filters
    const currentFilters = filterValue?.split(', ').filter(f => f.trim()) || []
    const existingNonPeopleFilters = currentFilters.filter(f => !f.startsWith('@'))

    // Combine new people filters with existing non-people filters
    const combinedFilters = [...selectedPeopleIds, ...existingNonPeopleFilters]

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
        {isLoading && slackUsers.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
            Loading users...
          </div>
        ) : slackUsers.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-500 dark:text-gray-400">
            No users found
          </div>
        ) : (
          <>
            {slackUsers.map((person: { id: string; name: string }) => (
              <DropdownMenuItem
                key={person.id}
                onSelect={(e) => {
                  e.preventDefault()
                  handlePersonSelect(person)
                }}
                className="flex items-center cursor-pointer text-sm py-2 px-2 hover:!bg-gray-100 dark:hover:!bg-gray-700 focus:!bg-gray-100 dark:focus:!bg-gray-700 data-[highlighted]:!bg-gray-100 dark:data-[highlighted]:!bg-gray-700 rounded"
              >
                <input
                  type="checkbox"
                  className="mr-3"
                  checked={selectedPeople.has(person.id)}
                  onChange={() => {}}
                />
                <span className="text-gray-700 dark:text-gray-200">{person.name}</span>
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
