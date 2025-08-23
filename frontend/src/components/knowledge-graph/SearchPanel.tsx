import { useState } from 'react'
import { Search, Shuffle } from 'lucide-react'

interface SearchPanelProps {
  searchQuery: string
  onSearch: (query: string) => void
  onEntitySelect: (entityName: string) => void
  isLoading: boolean
}

export function SearchPanel({ searchQuery, onSearch, onEntitySelect, isLoading }: SearchPanelProps) {
  const [localQuery, setLocalQuery] = useState(searchQuery)

  const handleSearch = () => {
    if (localQuery.trim()) {
      onSearch(localQuery)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  const handleRandomEntity = () => {
    // You can implement random entity selection here
    // For now, let's search for a common entity
    const commonEntities = ['Juspay', 'UAN', 'EPFO', 'UMANG']
    const randomEntity = commonEntities[Math.floor(Math.random() * commonEntities.length)]
    setLocalQuery(randomEntity)
    onSearch(randomEntity)
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <h3 className="text-lg font-semibold text-gray-900 mb-4">🔍 Search & Explore</h3>
      
      <div className="space-y-4">
        <div className="relative">
          <input
            type="text"
            value={localQuery}
            onChange={(e) => setLocalQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Search entities..."
            className="w-full px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 pr-10"
            disabled={isLoading}
          />
          <Search className="absolute right-3 top-2.5 h-4 w-4 text-gray-400" />
        </div>
        
        <div className="flex space-x-2">
          <button
            onClick={handleSearch}
            disabled={isLoading || !localQuery.trim()}
            className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? 'Searching...' : 'Search Entities'}
          </button>
          
          <button
            onClick={handleRandomEntity}
            disabled={isLoading}
            className="px-3 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Random Entity"
          >
            <Shuffle className="h-4 w-4" />
          </button>
        </div>
        
        {/* Quick entity buttons */}
        <div className="space-y-2">
          <div className="text-sm font-medium text-gray-700">Quick Access:</div>
          <div className="flex flex-wrap gap-2">
            {['Juspay', 'UAN', 'EPFO', 'UMANG App'].map((entity) => (
              <button
                key={entity}
                onClick={() => onEntitySelect(entity)}
                disabled={isLoading}
                className="px-3 py-1 text-sm bg-gray-100 text-gray-700 rounded hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                {entity}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
