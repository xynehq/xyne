import { useState, useCallback } from 'react'
import { GraphData } from '@/components/knowledge-graph/KnowledgeGraphVisualizer'

const API_BASE_URL = window.location.origin // Use the same origin as the frontend

interface SearchResult {
  entities: any[]
  total: number
  limit: number
  query: string
}

interface StatsData {
  totalEntities: number
  totalRelationships: number
  entityTypes: Record<string, number>
  relationshipTypes: Record<string, number>
}

export function useKnowledgeGraph() {
  const [data, setData] = useState<GraphData | null>(null)
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null)
  const [stats, setStats] = useState<StatsData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const searchEntities = useCallback(async (query: string, limit = 20) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kg/search?q=${encodeURIComponent(query)}&limit=${limit}`, {
        credentials: 'include', // Include cookies for authentication
      })
      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`)
      }
      
      const result = await response.json()
      setSearchResults(result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Search failed')
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [])

  const getEntityGraph = useCallback(async (entityName: string, depth = 2) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kg/visualize/${encodeURIComponent(entityName)}?depth=${depth}`, {
        credentials: 'include', // Include cookies for authentication
      })
      if (!response.ok) {
        throw new Error(`Failed to load graph: ${response.statusText}`)
      }
      
      const result = await response.json()
      setData(result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load graph')
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [])

  const getStats = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kg/stats`, {
        credentials: 'include', // Include cookies for authentication
      })
      if (!response.ok) {
        throw new Error(`Failed to load stats: ${response.statusText}`)
      }
      
      const result = await response.json()
      setStats(result.stats) // Note: API returns { stats: ... }
      return result.stats
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load stats')
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [])

  const getRandomEntity = useCallback(async () => {
    try {
      // Get available entity types first
      const statsData = await getStats()
      const entityTypes = Object.keys(statsData.entityTypes || {})
      
      if (entityTypes.length === 0) {
        throw new Error('No entity types available')
      }
      
      // Pick a random type
      const randomType = entityTypes[Math.floor(Math.random() * entityTypes.length)]
      
      // Search for entities of this type
      const searchResult = await searchEntities(`type:${randomType}`, 10)
      
      if (!searchResult.entities || searchResult.entities.length === 0) {
        throw new Error('No entities found')
      }
      
      // Pick a random entity
      const randomEntity = searchResult.entities[Math.floor(Math.random() * searchResult.entities.length)]
      
      // Load its graph
      await getEntityGraph(randomEntity.entityName || randomEntity.name || randomEntity.id)
      
      return randomEntity
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load random entity')
      setError(error)
      throw error
    }
  }, [searchEntities, getEntityGraph, getStats])

  const getOverviewGraph = useCallback(async (limit = 30, minConnections = 2) => {
    setIsLoading(true)
    setError(null)
    
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kg/overview?limit=${limit}&minConnections=${minConnections}`, {
        credentials: 'include',
      })
      if (!response.ok) {
        throw new Error(`Failed to load overview: ${response.statusText}`)
      }
      
      const result = await response.json()
      setData(result)
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load overview')
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [])

  const getRelationshipDetails = useCallback(async (sourceEntity: string, targetEntity: string, relationshipType: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/kg/relationship-details?source=${encodeURIComponent(sourceEntity)}&target=${encodeURIComponent(targetEntity)}&type=${encodeURIComponent(relationshipType)}`, {
        credentials: 'include',
      })
      if (!response.ok) {
        throw new Error(`Failed to load relationship details: ${response.statusText}`)
      }
      
      const result = await response.json()
      return result
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to load relationship details')
      console.error('Relationship details error:', error)
      throw error
    }
  }, [])

  return {
    data,
    searchResults,
    stats,
    isLoading,
    error,
    searchEntities,
    getEntityGraph,
    getStats,
    getRandomEntity,
    getOverviewGraph,
    getRelationshipDetails
  }
}
