import { useState, useCallback, useRef } from 'react'
import { api } from '@/api'
import { useToast } from '@/hooks/use-toast'
import { SlackEntity } from 'shared/types'

export interface SlackItem {
  id: string
  name: string
}

interface UseSlackDataOptions {
  entity: SlackEntity
  enabled?: boolean
}

export const useSlackData = ({ entity, enabled = true }: UseSlackDataOptions) => {
  const { toast } = useToast()
  const [items, setItems] = useState<SlackItem[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const fetchItems = useCallback(async (query: string = '', currentOffset: number = 0, append: boolean = false) => {
    if (!enabled) return

    setIsLoading(true)
    try {
      const limit = currentOffset + 50
      const queryParams: any = {
        entity,
        limit: limit.toString(),
        offset: currentOffset.toString(),
      }

      if (query && query.trim()) {
        queryParams.query = query.trim()
      }

      const response = await api.slack.entities.$get({
        query: queryParams
      })

      if (response.ok) {
        const data = await response.json()
        const fetchedItems = data.results?.root?.children?.map((child: any) => ({
          id: child.fields?.docId || child.id,
          name: child.fields?.name || `Unknown ${entity}`,
        })) || []

        if (append) {
          setItems(prev => [...prev, ...fetchedItems])
        } else {
          setItems(fetchedItems)
        }

        setHasMore(fetchedItems.length === 50)
      } else {
        toast.error({
          title: 'Error',
          description: `Failed to fetch Slack ${entity}s`,
        })
      }
    } catch (error) {
      console.error(`Error fetching Slack ${entity}s:`, error)
      toast.error({
        title: 'Error',
        description: `An error occurred while fetching Slack ${entity}s`,
      })
    } finally {
      setIsLoading(false)
    }
  }, [entity, enabled, toast])

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query)
    setOffset(0)
    fetchItems(query, 0, false)
  }, [fetchItems])

  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container || isLoading || !hasMore) return

    const { scrollTop, scrollHeight, clientHeight } = container
    const scrollThreshold = 50

    if (scrollHeight - scrollTop - clientHeight < scrollThreshold) {
      const newOffset = offset + 50
      setOffset(newOffset)
      fetchItems(searchQuery, newOffset, true)
    }
  }, [offset, searchQuery, isLoading, hasMore, fetchItems])

  return {
    items,
    searchQuery,
    isLoading,
    hasMore,
    containerRef,
    handleSearch,
    handleScroll,
    fetchItems,
  }
}
